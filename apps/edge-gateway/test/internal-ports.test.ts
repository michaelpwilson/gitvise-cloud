import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { SANDBOX_IMAGE } from '../src/composition';
import { FakeBlobs, FakeContainerNamespace } from './support/fake-container';
import { httpEnv, testEnv, uniqueId } from './support/bindings';
import { callInternalWith, signedHeaders, signedStreamHeaders } from './support/internal';
import type { GatewayEnv } from '../src/env';

/** Reads NDJSON lines until `count` have arrived, or the stream stalls for too long. */
async function readLines(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<unknown[]> {
  const decoder = new TextDecoder();
  const lines: unknown[] = [];
  let buffer = '';
  const deadline = Date.now() + 5_000;
  while (lines.length < count && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream stalled')), 4_000)),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') lines.push(JSON.parse(line));
      newline = buffer.indexOf('\n');
    }
  }
  return lines;
}

async function readAll(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** A Workers AI binding double. `handler` decides each reply from the model and the inputs. */
function fakeAi(handler: (model: string, inputs: Record<string, unknown>) => unknown): Ai {
  return { run: async (model: string, inputs: Record<string, unknown>) => handler(model, inputs) } as unknown as Ai;
}

/** HEAD carries no body, so it is signed with the empty-body digest, not UNSIGNED-PAYLOAD. */
async function headFor(path: string): Promise<Record<string, string>> {
  const headers = await signedHeaders('HEAD', path, '');
  delete headers['content-type'];
  return headers;
}

async function grantCredit(orgId: string, amountPence = 10_000): Promise<void> {
  await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: `seed-${orgId}`, bucket: 'monthly', amountPence });
}

describe('/internal/ports/realtime', () => {
  it('relays presence, Yjs, and agent events to a subscriber in publish order', async () => {
    const room = { worktreeId: uniqueId('wt'), roomId: 'room-main' };
    const subscribed = await callInternalWith('POST', '/internal/ports/realtime/subscribe', { payload: { room } });
    expect(subscribed.status).toBe(200);
    expect(subscribed.headers.get('content-type')).toContain('application/x-ndjson');
    const reader = subscribed.body!.getReader();

    // The room socket opens asynchronously. Publishing before it does would drop the events.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await callInternalWith('POST', '/internal/ports/realtime/update', {
      payload: { room, origin: 'agent-1', update: Buffer.from([1, 2, 3]).toString('base64') },
    });
    await callInternalWith('POST', '/internal/ports/realtime/presence', {
      payload: {
        room,
        presence: { agentId: 'agent-1', path: 'src/index.ts', line: 3, column: 0, updatedAtMs: 1 },
      },
    });
    await callInternalWith('POST', '/internal/ports/realtime/agent', {
      payload: { room, event: { type: 'stream-chunk', runId: 'run-1', text: 'partial output' } },
    });

    const events = await readLines(reader, 3);
    await reader.cancel();
    expect(events[0]).toMatchObject({ type: 'yjs-update', origin: 'agent-1', update: 'AQID' });
    expect(events[1]).toMatchObject({ type: 'presence', presence: { agentId: 'agent-1', line: 3 } });
    expect(events[2]).toMatchObject({ type: 'agent', event: { type: 'stream-chunk', runId: 'run-1', text: 'partial output' } });
  });

  it('refuses an agent event with no run id', async () => {
    const response = await callInternalWith('POST', '/internal/ports/realtime/agent', {
      payload: { room: { worktreeId: 'wt', roomId: 'r' }, event: { type: 'stream-close', status: 'done' } },
    });
    expect(response.status).toBe(400);
  });
});

describe('/internal/ports/inference', () => {
  it('streams tokens and a usage event for a metered call', async () => {
    const orgId = uniqueId('org-stream');
    await grantCredit(orgId);
    const env = httpEnv({ AI: fakeAi(() => ({ response: 'hello' })) });
    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env,
      payload: {
        requestId: uniqueId('req'),
        tier: 'fast-3b',
        messages: [{ role: 'user', content: 'hi' }],
        billing: { organizationId: orgId, userId: 'user-1' },
      },
    });
    expect(response.status).toBe(200);
    const events = await readAll(response);
    expect(events[0]).toEqual({ type: 'token', text: 'hello' });
    expect(events.at(-1)).toMatchObject({ type: 'usage', usage: { tier: 'fast-3b' } });
  });

  it('returns a tool call as a tool-call event followed by usage', async () => {
    const orgId = uniqueId('org-tools');
    await grantCredit(orgId);
    const env = httpEnv({
      AI: fakeAi((_model, inputs) =>
        inputs['tools'] === undefined ? { response: 'no tools' } : { response: '', tool_calls: [{ name: 'lookup', arguments: { q: 'x' } }] },
      ),
    });
    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env,
      payload: {
        requestId: uniqueId('req'),
        tier: 'fast-3b',
        messages: [{ role: 'user', content: 'find x' }],
        tools: [{ name: 'lookup', description: 'look up a term', parameters: { type: 'object' } }],
        billing: { organizationId: orgId, userId: 'user-1' },
      },
    });
    expect(response.status).toBe(200);
    const events = await readAll(response);
    expect(events[0]).toMatchObject({ type: 'tool-call', call: { name: 'lookup', arguments: '{"q":"x"}' } });
    expect(events.at(-1)).toMatchObject({ type: 'usage' });
  });

  it('refuses an inference request with no billing attribution, before any credit is reserved', async () => {
    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      payload: { requestId: uniqueId('req'), tier: 'fast-3b', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.status).toBe(400);
  });

  it('embeds inputs through the metered path and returns one vector per input', async () => {
    const orgId = uniqueId('org-embed');
    await grantCredit(orgId);
    const env = httpEnv({
      AI_MODEL_EMBED: '@cf/baai/bge-large-en-v1.5',
      AI: fakeAi((_model, inputs) => ({
        data: (inputs['text'] as string[]).map(() => new Array<number>(1024).fill(0.25)),
      })),
    });
    const response = await callInternalWith('POST', '/internal/ports/inference/embed', {
      env,
      payload: {
        requestId: uniqueId('embed'),
        inputs: ['alpha', 'beta'],
        billing: { organizationId: orgId, userId: 'user-1' },
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { vectors: number[][] };
    expect(body.vectors).toHaveLength(2);
    expect(body.vectors[0]).toHaveLength(1024);
  });

  it('refuses embedding when no embedding model is configured', async () => {
    const orgId = uniqueId('org-noembed');
    await grantCredit(orgId);
    const env = httpEnv({ AI_MODEL_EMBED: '', AI: fakeAi(() => ({})) });
    const response = await callInternalWith('POST', '/internal/ports/inference/embed', {
      env,
      payload: { requestId: uniqueId('embed'), inputs: ['alpha'], billing: { organizationId: orgId, userId: 'u' } },
    });
    expect(response.status).toBe(503);
  });
});

describe('/internal/ports/sandbox', () => {
  const SANDBOX = { image: SANDBOX_IMAGE, vcpus: 1, memoryMiB: 1024, network: 'none' as const, timeoutMs: 600_000 };

  it('refuses an exec against a commit the gateway has no snapshot for', async () => {
    const containers = new FakeContainerNamespace(new FakeBlobs());
    const env = httpEnv({ CONTAINERS: containers.asNamespace() as unknown as GatewayEnv['CONTAINERS'] });
    const exec = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: { sandbox: SANDBOX, orgId: 'org-demo', repoId: 'repo-demo', commitHash: 'a'.repeat(40), command: ['echo', 'hi'], timeoutMs: 5_000, env: {} },
    });
    expect(exec.status).toBe(404);
  });

  it('runs commands inside a lease, then releases it', async () => {
    const containers = new FakeContainerNamespace(new FakeBlobs());
    const env = httpEnv({ CONTAINERS: containers.asNamespace() as unknown as GatewayEnv['CONTAINERS'] });

    const leased = await callInternalWith('POST', '/internal/ports/sandbox/leases', {
      env,
      payload: { ...SANDBOX, timeoutMs: 60_000, env: {} },
    });
    expect(leased.status).toBe(201);
    const { leaseId } = (await leased.json()) as { leaseId: string };

    const ran = await callInternalWith('POST', `/internal/ports/sandbox/leases/${leaseId}/run`, {
      env,
      payload: { argv: ['echo', 'lease'] },
    });
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({ exitCode: expect.any(Number) });

    const released = await callInternalWith('DELETE', `/internal/ports/sandbox/leases/${leaseId}`, { env });
    expect(await released.json()).toEqual({ released: true });
  });

  it('refuses an empty argv', async () => {
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      payload: { sandbox: SANDBOX, repoId: 'r', commitHash: 'a'.repeat(40), command: [], timeoutMs: 5_000, env: {} },
    });
    expect(response.status).toBe(400);
  });
});

describe('/internal/ports/blob (streamed)', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text);
  const sha256Hex = async (bytes: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

  it('streams a blob in, serves it back, and answers HEAD without the body', async () => {
    const bytes = bytesOf(`packfile-${uniqueId('blob')}`);
    const sha = await sha256Hex(bytes);
    const path = `/internal/ports/blob/packfile/${sha}`;
    const headers = await signedStreamHeaders('PUT', path, {
      'content-type': 'application/octet-stream',
      'x-gitvise-blob-byte-length': String(bytes.byteLength),
      'x-gitvise-blob-encoding': 'identity',
    });

    const created = await app.request(path, { method: 'PUT', headers, body: bytes }, httpEnv());
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ created: true });

    const again = await callInternalWith('GET', path);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
    expect(again.headers.get('x-gitvise-blob-byte-length')).toBe(String(bytes.byteLength));

    const head = await app.request(path, { method: 'HEAD', headers: await headFor(path) }, httpEnv());
    expect(head.status).toBe(200);
    expect(head.headers.get('x-gitvise-blob-encoding')).toBe('identity');
  });

  it('answers 200 for a blob that already exists, leaving it untouched', async () => {
    const bytes = bytesOf(`same-${uniqueId('blob')}`);
    const sha = await sha256Hex(bytes);
    const path = `/internal/ports/blob/lfs-object/${sha}`;
    const put = () =>
      signedStreamHeaders('PUT', path, {
        'x-gitvise-blob-byte-length': String(bytes.byteLength),
        'x-gitvise-blob-encoding': 'identity',
      }).then((headers) => app.request(path, { method: 'PUT', headers, body: bytes }, httpEnv()));
    expect((await put()).status).toBe(201);
    expect((await put()).status).toBe(200);
  });

  it('refuses a streamed body whose bytes do not match the digest in the path with 400', async () => {
    const claimed = await sha256Hex(bytesOf('the bytes the path names'));
    const path = `/internal/ports/blob/packfile/${claimed}`;
    const headers = await signedStreamHeaders('PUT', path, {
      'x-gitvise-blob-byte-length': '5',
      'x-gitvise-blob-encoding': 'identity',
    });
    const response = await app.request(path, { method: 'PUT', headers, body: bytesOf('wrong') }, httpEnv());
    expect(response.status).toBe(400);
    expect((await callInternalWith('GET', path)).status).toBe(404);
  });

  it('refuses a streamed signature on any route other than a blob write', async () => {
    const path = '/internal/kv/anything';
    const headers = await signedStreamHeaders('PUT', path, {});
    const response = await app.request(path, { method: 'PUT', headers, body: '{"value":"x"}' }, httpEnv());
    expect(response.status).toBe(401);
  });
});
