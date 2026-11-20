import { Hono, type Context } from 'hono';
import {
  BLOB_ENCODINGS,
  BLOB_KINDS,
  SWARM_STEP_STATUSES,
  type BlobEncoding,
  type BlobInfo,
  type BlobKind,
  type RealtimeEvent,
  type SandboxExecRequest,
  type SandboxLeaseRequest,
  type SwarmFlowSpec,
  type SwarmStepStatus,
  type WorktreeMutexLease,
} from '@gitvise/core';
import { fromBase64, toBase64 } from '@gitvise/adapter-cloudflare';
import type { AppEnv } from '../app-env';
import { createEdgeServices } from '../composition';
import { readJson } from '../http';
import { ndjsonResponse } from './ndjson';
import {
  agentEventOf,
  embeddingRequestOf,
  identifier,
  inferenceRequestOf,
  intField,
  invalid,
  objectBody,
  presenceOf,
  roomRef,
  stringField,
} from './validate';

/**
 * `/internal/ports/*`. Each route exposes one core port over the adapters in `@gitvise/adapter-cloudflare`, so the
 * apps/api container can run its ports on Cloudflare. The bodies and replies match the clients in
 * `apps/api/src/adapter-registry/cloud/*.bridge.ts`.
 *
 * Inference needs `billing` in every request. The gateway debits the organisation, so an unattributed call is
 * refused with 400 before any credit is reserved.
 */

const MAX_SANDBOX_COMMAND = 64;
const MAX_SANDBOX_ARG_CHARS = 4_096;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_BLOB_BYTES = 8 * 1024 * 1024 * 1024;
const BLOB_BYTE_HEADER = 'x-gitvise-blob-byte-length';
const BLOB_ENCODING_HEADER = 'x-gitvise-blob-encoding';
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const portRoutes = new Hono<AppEnv>();

// Realtime. Yjs updates travel as base64 in JSON. The subscription is NDJSON, one event per line.

portRoutes.post('/ports/realtime/update', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const update = fromBase64(stringField(body['update'], 'update', 2_000_000));
  await realtimeFor(c).publishUpdate(roomRef(body['room']), update, stringField(body['origin'], 'origin', 128));
  return c.json({ ok: true });
});

portRoutes.post('/ports/realtime/presence', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  await realtimeFor(c).publishPresence(roomRef(body['room']), presenceOf(body['presence']));
  return c.json({ ok: true });
});

portRoutes.post('/ports/realtime/agent', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  await realtimeFor(c).publishAgentEvent(roomRef(body['room']), agentEventOf(body['event']));
  return c.json({ ok: true });
});

portRoutes.post('/ports/realtime/subscribe', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const events = realtimeFor(c).subscribe(roomRef(body['room']));
  return ndjsonResponse(events.pipeThrough(new TransformStream<RealtimeEvent, unknown>({
    transform(event, controller) {
      controller.enqueue(wireRealtimeEvent(event));
    },
  })));
});

// Inference. Metered on the gateway. `billing` is required, and the stream is NDJSON of token, tool-call, and usage.

portRoutes.post('/ports/inference/stream', async (c) => {
  const request = inferenceRequestOf(await readJson<unknown>(c.req.raw));
  const { metered } = createEdgeServices(c.env);
  const events = await metered.open(request, {
    orgId: request.billing.organizationId,
    userId: request.billing.userId,
  });
  return ndjsonResponse(events);
});

portRoutes.post('/ports/inference/embed', async (c) => {
  const request = embeddingRequestOf(await readJson<unknown>(c.req.raw));
  const { metered } = createEdgeServices(c.env);
  const vectors = await metered.embed(request, {
    orgId: request.billing.organizationId,
    userId: request.billing.userId,
  });
  return c.json({ vectors });
});

// Sandbox. Runs go to the container adapter. A lease is addressed by its id, and a missing lease answers 404.

portRoutes.post('/ports/sandbox/exec', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const request = sandboxExecOf(body);
  const { sandbox } = createEdgeServices(c.env);
  return c.json(await sandbox.runInSandbox(request));
});

portRoutes.post('/ports/sandbox/leases', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const request = sandboxLeaseOf(body);
  const { sandbox } = createEdgeServices(c.env);
  const lease = await sandbox.acquire(request);
  return c.json({ leaseId: lease.id }, 201);
});

portRoutes.post('/ports/sandbox/leases/:leaseId/run', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const argv = argvOf(body['argv']);
  const { sandbox } = createEdgeServices(c.env);
  const lease = await sandbox.attach(identifier(c.req.param('leaseId') ?? '', 'leaseId'));
  return c.json(await lease.run(argv, c.req.raw.signal));
});

portRoutes.delete('/ports/sandbox/leases/:leaseId', async (c) => {
  const { sandbox } = createEdgeServices(c.env);
  const lease = await sandbox.attach(identifier(c.req.param('leaseId') ?? '', 'leaseId'));
  await lease.release();
  return c.json({ released: true });
});

// Blob. The body streams straight into R2, which checks the digest in the path while it writes. The request is signed
// with UNSIGNED-PAYLOAD, so the gateway never buffers it.

portRoutes.put('/ports/blob/:kind/:sha256', async (c) => {
  const ref = blobRef(c);
  const byteLength = blobByteLength(c.req.header(BLOB_BYTE_HEADER));
  const encoding = blobEncoding(c.req.header(BLOB_ENCODING_HEADER));
  if (c.req.raw.body === null) throw invalid('body is required');
  const { blobs } = createEdgeServices(c.env);
  const created = await blobs.putBlob(ref, c.req.raw.body, { byteLength, encoding });
  return c.json({ created }, created ? 201 : 200);
});

portRoutes.get('/ports/blob/:kind/:sha256', async (c) => {
  const { engine } = createEdgeServices(c.env);
  const blob = await engine.blobs.load(blobRef(c));
  if (blob === undefined) return c.json({ code: 'NOT_FOUND', message: 'no such blob' }, 404);
  return new Response(blob.body, { headers: blobHeaders(blob.info) });
});

portRoutes.on('HEAD', '/ports/blob/:kind/:sha256', async (c) => {
  const { blobs } = createEdgeServices(c.env);
  const info = await blobs.headBlob(blobRef(c));
  if (info === undefined) return new Response(null, { status: 404 });
  return new Response(null, { status: 200, headers: blobHeaders(info) });
});

// Queue. The swarm's flow state, step status, and worktree mutex, as the apps/api SwarmQueuePort calls them.

portRoutes.post('/ports/queue/flows', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const { swarmQueue } = createEdgeServices(c.env);
  return c.json(await swarmQueue.enqueueFlow(swarmFlowOf(body)));
});

portRoutes.post('/ports/queue/steps/status', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const { swarmQueue } = createEdgeServices(c.env);
  const status = await swarmQueue.getStepStatus(
    stringField(body['flowId'], 'flowId', 256),
    stringField(body['taskId'], 'taskId', 256),
  );
  return c.json({ status: status ?? null });
});

portRoutes.post('/ports/queue/steps/cas', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const { swarmQueue } = createEdgeServices(c.env);
  const ok = await swarmQueue.compareAndSetStepStatus(
    stringField(body['flowId'], 'flowId', 256),
    stringField(body['taskId'], 'taskId', 256),
    stepStatusOf(body['expected']),
    stepStatusOf(body['next']),
  );
  return c.json({ ok });
});

portRoutes.post('/ports/queue/mutex/acquire', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const { swarmQueue } = createEdgeServices(c.env);
  const lease = await swarmQueue.acquireWorktreeMutex(
    identifier(body['worktreeId'], 'worktreeId'),
    identifier(body['owner'], 'owner'),
    intField(body['ttlMs'], 'ttlMs', 1, MAX_TIMEOUT_MS),
  );
  return c.json({ lease: lease ?? null });
});

portRoutes.post('/ports/queue/mutex/release', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const { swarmQueue } = createEdgeServices(c.env);
  const ok = await swarmQueue.releaseWorktreeMutex(mutexLeaseOf(body));
  return c.json({ ok });
});

function realtimeFor(c: Context<AppEnv>) {
  return createEdgeServices(c.env).realtime;
}

/** The NDJSON line for one event. Yjs updates are base64, which the apps/api client decodes. */
function wireRealtimeEvent(event: RealtimeEvent): unknown {
  if (event['type'] === 'yjs-update') {
    return { type: 'yjs-update', room: event.room, origin: event.origin, update: toBase64(event['update']) };
  }
  return event;
}

function blobRef(c: Context<AppEnv>): { kind: BlobKind; sha256: string } {
  const kind = c.req.param('kind') ?? '';
  const sha256 = c.req.param('sha256') ?? '';
  if (!(BLOB_KINDS as readonly string[]).includes(kind)) throw invalid('blob kind is not recognised');
  if (!SHA256_HEX.test(sha256)) throw invalid('blob digest must be lowercase hex SHA-256');
  return { kind: kind as BlobKind, sha256 };
}

function blobByteLength(header: string | undefined): number {
  if (header === undefined || !/^\d{1,16}$/.test(header)) throw invalid(`${BLOB_BYTE_HEADER} is required`);
  return intField(Number(header), BLOB_BYTE_HEADER, 0, MAX_BLOB_BYTES);
}

function blobEncoding(header: string | undefined): BlobEncoding {
  if (header === undefined || !(BLOB_ENCODINGS as readonly string[]).includes(header)) {
    throw invalid(`${BLOB_ENCODING_HEADER} must be identity or zstd`);
  }
  return header as BlobEncoding;
}

function blobHeaders(info: BlobInfo): Headers {
  return new Headers({
    'content-type': 'application/octet-stream',
    'content-length': String(info.byteLength),
    [BLOB_BYTE_HEADER]: String(info.byteLength),
    [BLOB_ENCODING_HEADER]: info.encoding,
  });
}

function sandboxExecOf(body: Record<string, unknown>): SandboxExecRequest {
  const command = argvOf(body['command']);
  const timeoutMs = intField(body['timeoutMs'], 'timeoutMs', 1, MAX_TIMEOUT_MS);
  // The remaining fields are the adapter's contract (SandboxSpec, SandboxSource, env). The adapter validates them.
  return { ...(body as unknown as SandboxExecRequest), command, timeoutMs };
}

function sandboxLeaseOf(body: Record<string, unknown>): SandboxLeaseRequest {
  const timeoutMs = intField(body['timeoutMs'], 'timeoutMs', 1, MAX_TIMEOUT_MS);
  return { ...(body as unknown as SandboxLeaseRequest), timeoutMs };
}

function argvOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SANDBOX_COMMAND) {
    throw invalid(`argv must be an array of 1 to ${MAX_SANDBOX_COMMAND} strings`);
  }
  return value.map((arg: unknown) => stringField(arg, 'argv entry', MAX_SANDBOX_ARG_CHARS, 0));
}

function swarmFlowOf(body: Record<string, unknown>): SwarmFlowSpec {
  if (!Array.isArray(body['tasks'])) throw invalid('tasks must be an array');
  return {
    ...(body as unknown as SwarmFlowSpec),
    flowId: stringField(body['flowId'], 'flowId', 256),
    repoId: stringField(body['repoId'], 'repoId', 256),
    tasks: body['tasks'].map((task: unknown) => {
      const entry = objectBody(task, 'task');
      if (!Array.isArray(entry['dependsOn']) || entry['dependsOn'].some((dep: unknown) => typeof dep !== 'string')) {
        throw invalid('task.dependsOn must be an array of task ids');
      }
      objectBody(entry['input'], 'task.input');
      return {
        taskId: stringField(entry['taskId'], 'task.taskId', 256),
        queue: stringField(entry['queue'], 'task.queue', 128),
        dependsOn: entry['dependsOn'] as string[],
        input: entry['input'] as SwarmFlowSpec['tasks'][number]['input'],
      };
    }),
  };
}

function stepStatusOf(value: unknown): SwarmStepStatus {
  if (typeof value !== 'string' || !(SWARM_STEP_STATUSES as readonly string[]).includes(value)) {
    throw invalid(`step status must be one of ${SWARM_STEP_STATUSES.join(', ')}`);
  }
  return value as SwarmStepStatus;
}

function mutexLeaseOf(body: Record<string, unknown>): WorktreeMutexLease {
  return {
    worktreeId: identifier(body['worktreeId'], 'worktreeId'),
    owner: identifier(body['owner'], 'owner'),
    token: stringField(body['token'], 'token', 256),
    expiresAtMs: intField(body['expiresAtMs'], 'expiresAtMs', 0, Number.MAX_SAFE_INTEGER),
  };
}

