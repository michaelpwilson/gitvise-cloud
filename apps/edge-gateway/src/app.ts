import { Hono, type Context } from 'hono';
import {
  GitViseError,
  INFERENCE_TIERS,
  type AgentCursorPresence,
  type BlobEncoding,
  type BlobKind,
  type GitViseErrorCode,
  type InferenceEvent,
  type InferenceMessage,
  type InferenceRequest,
  type InferenceTier,
  type RealtimeEvent,
  type RealtimeRoomRef,
  type SandboxExecRequest,
  type SandboxLeaseRequest,
  type VectorQuery,
  type VectorRecord,
  type VectorRecordKind,
} from '@gitvise/core';
import { toBase64 } from '@gitvise/adapter-cloudflare';
import type { AppEnv } from './app-env';
import { createEdgeServices, CommitSnapshotConflict } from './composition';
import { CreditExhaustedError, RetryableWebhookError } from './billing/errors';
import { findOrganization, markStripeEvent, hasSeenStripeEvent } from './billing/ledger';
import { applyStripeEvent, HANDLED_STRIPE_EVENTS } from './billing/webhooks';
import { reconcileBilling } from './billing/reconcile';
import { createCheckoutSession, verifyStripeSignature, type StripeEvent } from './billing/stripe';
import { isPaidTier, PLANS, TOPUP_PACK, type PaidTier } from './billing/plans';
import { refuseCrossSiteWrite, requireOperator, requireOwner, requirePrincipal, resolvePrincipal } from './auth/principal';
import { GATEWAY_IDENTITY_HEADERS, setGatewayIdentity } from './auth/gateway-identity';
import { authRoutes } from './routes/auth';
import { keyRoutes } from './routes/keys';
import { internalRoutes } from './internal/routes';
import { readJson } from './http';
import { assertLeaseOwner, forgetLease, recordLeaseOwner, scopeFlowSpec, scopeId, unscopeId } from './tenancy';
import type { GatewayEnv } from './env';
import { API_CONTAINER_INSTANCE } from './api-container';

export type { AppEnv } from './app-env';

type ErrorStatus = 400 | 404 | 409 | 423 | 502 | 503;

const STATUS_BY_CODE: Record<GitViseErrorCode, ErrorStatus> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  LOCK_HELD: 423,
  TIER_UNAVAILABLE: 503,
  UPSTREAM_FAILURE: 502,
  CONFLICT: 409,
};

const TASK_ACTIONS = ['start', 'finish', 'fail'] as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_SEATS = 10_000;
const MAX_RECONCILE_ORGS = 500;

export const app = new Hono<AppEnv>();

app.onError((error, c) => {
  if (error instanceof GitViseError) {
    return c.json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
  }
  if (error instanceof CreditExhaustedError) {
    // The body tells the client how to top up, so the UI can offer a one-click purchase.
    return c.json(
      {
        error: {
          code: 'CREDITS_EXHAUSTED',
          message: 'organisation has no remaining credit',
          availablePence: error.availablePence,
        },
        topUp: { method: 'POST', path: '/api/billing/checkout', body: { kind: 'topup' }, pricePence: TOPUP_PACK.pricePence },
      },
      402,
    );
  }
  if (error instanceof CommitSnapshotConflict) {
    return c.json({ error: { code: 'CONFLICT', message: error.message } }, 409);
  }
  console.error(error);
  return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
});

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'no such route' } }, 404));

/** Liveness. Unauthenticated, so load balancers can call it. */
app.get('/api/health', (c) => c.json({ ok: true }));

// Authentication. Sign-up and sign-in are public. Everything under /v1 and /api/billing needs a principal.
// The operator token is checked only under /api/admin, so it cannot act as a tenant anywhere.

app.route('/api/auth', authRoutes);
app.route('/api/keys', keyRoutes);

// Container-to-gateway calls. Each request is checked against its gitvise-internal-v1 signature in the sub-router.
app.route('/internal', internalRoutes);

app.use('/v1/*', requirePrincipal);
app.use('/api/billing/*', requirePrincipal);
app.use('/api/admin/*', requireOperator);

// Sandbox: one-shot runs and leases. Repo ids are scoped to the caller's org, and a lease is usable only by its owner.

app.post('/v1/sandbox/runs', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const body = await readJson<SandboxExecRequest>(c.req.raw);
  return c.json(await engine.sandbox.run({ ...body, repoId: scopeId(orgId, body.repoId, 'repoId') }));
});

app.post('/v1/sandbox/leases', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const body = await readJson<SandboxLeaseRequest>(c.req.raw);
  const request: SandboxLeaseRequest = body.source === undefined
    ? body
    : { ...body, source: { ...body.source, repoId: scopeId(orgId, body.source.repoId, 'source.repoId') } };
  const lease = await engine.sandbox.acquire(request);
  await recordLeaseOwner(c.env.D1, lease.id, orgId);
  return c.json({ leaseId: lease.id }, 201);
});

app.post('/v1/sandbox/leases/:leaseId/runs', async (c) => {
  const { orgId } = c.get('principal');
  const leaseId = c.req.param('leaseId');
  await assertLeaseOwner(c.env.D1, leaseId, orgId);
  const { sandbox } = createEdgeServices(c.env);
  const body = await readJson<{ argv?: unknown }>(c.req.raw);
  if (!isStringArray(body.argv)) throw new GitViseError('INVALID_REQUEST', 'argv must be an array of strings');
  const lease = await sandbox.attach(leaseId);
  return c.json(await lease.run(body.argv, c.req.raw.signal));
});

app.delete('/v1/sandbox/leases/:leaseId', async (c) => {
  const { orgId } = c.get('principal');
  const leaseId = c.req.param('leaseId');
  await assertLeaseOwner(c.env.D1, leaseId, orgId);
  const { sandbox } = createEdgeServices(c.env);
  const lease = await sandbox.attach(leaseId);
  await lease.release();
  await forgetLease(c.env.D1, leaseId);
  return c.body(null, 204);
});

// Swarm: DAG submission and step transitions. The route stamps the caller's org into every task before queueing.

app.post('/v1/swarm/flows', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const spec = scopeFlowSpec(orgId, await readJson<unknown>(c.req.raw));
  const result = await engine.swarm.submitFlow(spec);
  return c.json(result, result.created ? 201 : 200);
});

app.get('/v1/swarm/flows/:flowId/tasks/:taskId', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const status = await engine.swarm.getStatus(scopeId(orgId, c.req.param('flowId'), 'flowId'), c.req.param('taskId'));
  return c.json({ status });
});

app.post('/v1/swarm/flows/:flowId/tasks/:taskId/:action', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const flowId = scopeId(orgId, c.req.param('flowId'), 'flowId');
  const taskId = c.req.param('taskId');
  const action = c.req.param('action');
  if (!isTaskAction(action)) throw new GitViseError('INVALID_REQUEST', 'action must be start, finish, or fail');

  if (action === 'start') await engine.swarm.startTask(flowId, taskId);
  if (action === 'fail') await engine.swarm.failTask(flowId, taskId);
  if (action === 'finish') {
    const body = await readJson<{ outcome?: unknown }>(c.req.raw);
    if (body.outcome !== 'succeeded' && body.outcome !== 'failed') {
      throw new GitViseError('INVALID_REQUEST', 'outcome must be succeeded or failed');
    }
    await engine.swarm.finishTask(flowId, taskId, body.outcome);
  }
  return c.body(null, 204);
});

// Realtime: Yjs updates and presence per worktree room. A worktree id is scoped to the caller's org.

app.get('/v1/realtime/rooms/:worktreeId/:roomId', (c) => {
  if (c.req.header('upgrade') !== 'websocket') {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'expected a WebSocket upgrade' } }, 426);
  }
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const events = engine.realtime.subscribe(roomRef(orgId, c.req.param('worktreeId'), c.req.param('roomId')));
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const reader = events.getReader();
  server.addEventListener('close', () => {
    void reader.cancel('client closed');
  });
  void pump(reader, server);
  return new Response(null, { status: 101, webSocket: client });
});

app.post('/v1/realtime/rooms/:worktreeId/:roomId/updates', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const origin = c.req.header('x-gitvise-origin');
  if (origin === undefined || origin === '') {
    throw new GitViseError('INVALID_REQUEST', 'x-gitvise-origin is required');
  }
  const update = new Uint8Array(await c.req.arrayBuffer());
  await engine.realtime.publishUpdate(roomRef(orgId, c.req.param('worktreeId'), c.req.param('roomId')), update, origin);
  return c.body(null, 204);
});

app.post('/v1/realtime/rooms/:worktreeId/:roomId/presence', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  await engine.realtime.publishPresence(
    roomRef(orgId, c.req.param('worktreeId'), c.req.param('roomId')),
    await readJson<AgentCursorPresence>(c.req.raw),
  );
  return c.body(null, 204);
});

// Memory: cross-agent trajectory search. Namespaces and record ids are scoped, so one org cannot read or overwrite another's vectors.

app.post('/v1/memory/records', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const body = await readJson<{ records?: Array<WireRecord> }>(c.req.raw);
  if (!Array.isArray(body.records)) throw new GitViseError('INVALID_REQUEST', 'records must be an array');
  const records: VectorRecord[] = body.records.map((record) => ({
    id: scopeId(orgId, record.id, 'records[].id'),
    namespace: scopeId(orgId, record.namespace, 'records[].namespace'),
    kind: record.kind,
    embedding: new Float32Array(record.embedding),
    payload: record.payload,
  }));
  await engine.memory.upsert(records);
  return c.body(null, 204);
});

app.post('/v1/memory/search', async (c) => {
  const { orgId } = c.get('principal');
  const { engine } = createEdgeServices(c.env);
  const body = await readJson<WireQuery>(c.req.raw);
  const query: VectorQuery = {
    namespace: scopeId(orgId, body.namespace, 'namespace'),
    embedding: new Float32Array(body.embedding),
    topK: body.topK,
    ...(body.kind === undefined ? {} : { kind: body.kind }),
    ...(body.minScore === undefined ? {} : { minScore: body.minScore }),
  };
  const matches = await engine.memory.findSimilar(query);
  return c.json({ matches: matches.map((match) => ({ ...match, id: unscopeId(orgId, match.id) })) });
});

// Blobs: content-addressed packfiles and LFS objects. Blobs are keyed by content hash and are not scoped per org.
// Anyone holding a digest can fetch that blob, so a digest must be treated as a secret until blobs are scoped.

app.put('/v1/blobs/:kind/:sha256', async (c) => {
  const { engine } = createEdgeServices(c.env);
  const lengthHeader = c.req.header('content-length');
  if (lengthHeader === undefined) {
    return c.json({ error: { code: 'INVALID_REQUEST', message: 'content-length is required' } }, 411);
  }
  if (c.req.raw.body === null) throw new GitViseError('INVALID_REQUEST', 'body is required');
  const created = await engine.blobs.store(
    { kind: c.req.param('kind') as BlobKind, sha256: c.req.param('sha256') },
    c.req.raw.body,
    {
      byteLength: Number(lengthHeader),
      encoding: (c.req.header('x-gitvise-encoding') ?? 'identity') as BlobEncoding,
    },
  );
  return c.json({ created }, created ? 201 : 200);
});

app.get('/v1/blobs/:kind/:sha256', async (c) => {
  const { engine } = createEdgeServices(c.env);
  const blob = await engine.blobs.load({
    kind: c.req.param('kind') as BlobKind,
    sha256: c.req.param('sha256'),
  });
  if (blob === undefined) return c.json({ error: { code: 'NOT_FOUND', message: 'no such blob' } }, 404);
  return new Response(blob.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(blob.info.byteLength),
      'x-gitvise-encoding': blob.info.encoding,
    },
  });
});

// Repos: commit-to-packfile index. Repo ids are scoped to the caller's org.

app.put('/v1/repos/:repoId/commits/:commitHash/snapshot', async (c) => {
  const { orgId } = c.get('principal');
  const { snapshots, blobs } = createEdgeServices(c.env);
  const repoId = scopeId(orgId, c.req.param('repoId'), 'repoId');
  const commitHash = c.req.param('commitHash');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitHash)) {
    throw new GitViseError('INVALID_REQUEST', 'commitHash must be a git object id');
  }
  const body = await readJson<{ sha256?: unknown; parentHash?: unknown }>(c.req.raw);
  if (typeof body.sha256 !== 'string') throw new GitViseError('INVALID_REQUEST', 'sha256 is required');
  if (body.parentHash !== undefined && (typeof body.parentHash !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(body.parentHash))) {
    throw new GitViseError('INVALID_REQUEST', 'parentHash must be a git object id');
  }

  // The packfile must already be uploaded, so no commit points at a missing blob.
  const info = await blobs.headBlob({ kind: 'packfile', sha256: body.sha256 });
  if (info === undefined) throw new GitViseError('NOT_FOUND', 'upload the packfile before recording a snapshot');

  const outcome = await snapshots.record(repoId, commitHash, body.sha256, typeof body.parentHash === 'string' ? body.parentHash : null);
  return c.json({ outcome }, outcome === 'created' ? 201 : 200);
});

// Inference: metered and server-sent. The org and user come from the principal. The body cannot name them.

app.post('/v1/inference/:tier', async (c) => {
  const principal = c.get('principal');
  const { metered } = createEdgeServices(c.env);
  const tier = c.req.param('tier');
  if (!isInferenceTier(tier)) {
    throw new GitViseError('INVALID_REQUEST', 'tier must be fast-3b, worker-7b, or architect-30b');
  }
  const body = await readJson<InferenceBody>(c.req.raw);
  const request: InferenceRequest = {
    // Scoped, because usage rows and ledger ids are global in D1. Two orgs must never share a request id.
    requestId: scopeId(principal.orgId, body.requestId, 'requestId'),
    tier,
    messages: parseMessages(body.messages),
    ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: positiveInt(body.maxOutputTokens, 'maxOutputTokens') }),
    ...(body.temperature === undefined ? {} : { temperature: temperatureValue(body.temperature) }),
  };

  // Refusal (402 or 503) happens here, before any bytes are sent.
  const events = await metered.open(request, { orgId: principal.orgId, userId: principal.userId });

  const encoder = new TextEncoder();
  const frames = events.pipeThrough(
    new TransformStream<InferenceEvent, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    }),
  );
  return new Response(frames, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
});

// Billing: Stripe Checkout, webhook, and status. Checkout is owner-only, and the org comes from the principal.

app.post('/api/billing/checkout', requireOwner, async (c) => {
  const { orgId } = c.get('principal');
  const body = await readJson<CheckoutBody>(c.req.raw);
  const secret = c.env.STRIPE_SECRET_KEY ?? '';
  const returnUrl = (c.env.BILLING_RETURN_URL ?? '').trim();
  if (secret === '' || returnUrl === '') return unconfigured(c, 'Stripe is not configured');

  const common: [string, string][] = [
    ['success_url', `${returnUrl}?billing=success`],
    ['cancel_url', `${returnUrl}?billing=cancelled`],
    ['client_reference_id', orgId],
    ['metadata[orgId]', orgId],
  ];

  let params: [string, string][];
  if (body.kind === 'topup') {
    const price = c.env.STRIPE_PRICE_TOPUP_15 ?? '';
    if (price === '') return unconfigured(c, 'top-up price is not configured');
    params = [
      ['mode', 'payment'],
      ['line_items[0][price]', price],
      ['line_items[0][quantity]', '1'],
      ...common,
      ['metadata[kind]', 'topup'],
      ['metadata[creditPence]', String(TOPUP_PACK.creditsPence)],
    ];
  } else if (body.kind === 'subscription') {
    if (!isPaidTier(body.tier)) throw new GitViseError('INVALID_REQUEST', 'tier must be pro, business, or enterprise');
    const tier: PaidTier = body.tier;
    const seats = PLANS[tier].perSeat ? seatCount(body.seats) : 1;
    const price = priceFor(c.env, tier);
    if (price === '') return unconfigured(c, `price for ${tier} is not configured`);
    params = [
      ['mode', 'subscription'],
      ['line_items[0][price]', price],
      ['line_items[0][quantity]', String(seats)],
      ...common,
      ['metadata[kind]', 'subscription'],
      ['metadata[tier]', tier],
      ['metadata[seats]', String(seats)],
    ];
  } else {
    throw new GitViseError('INVALID_REQUEST', 'kind must be subscription or topup');
  }

  const session = await createCheckoutSession(secret, params);
  return c.json({ sessionId: session.id, url: session.url }, 201);
});

app.post('/api/webhooks/stripe', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET ?? '';
  if (secret === '') return unconfigured(c, 'Stripe webhook secret is not configured');

  // The signature covers the exact bytes Stripe sent, so read the body as text and never re-serialise it.
  const payload = await c.req.text();
  const valid = await verifyStripeSignature({
    payload,
    header: c.req.header('stripe-signature'),
    secret,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!valid) return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'signature check failed' } }, 400);

  const event = parseStripeEvent(payload);
  if (event === undefined) return c.json({ error: { code: 'INVALID_REQUEST', message: 'malformed event' } }, 400);

  // Idempotency: an event that has already been applied is acknowledged, not applied twice.
  if (await hasSeenStripeEvent(c.env.D1, event.id)) return c.json({ received: true, duplicate: true });
  if (!HANDLED_STRIPE_EVENTS.includes(event.type)) {
    await markStripeEvent(c.env.D1, event.id, event.type);
    return c.json({ received: true, handled: false });
  }

  try {
    await applyStripeEvent(event, { db: c.env.D1, guards: c.env.BILLING_GUARD });
  } catch (error) {
    // A non-2xx makes Stripe redeliver. The event is marked seen only after it applies cleanly.
    if (error instanceof RetryableWebhookError) {
      return c.json({ error: { code: 'RETRY', message: error.message } }, 409);
    }
    throw error;
  }
  await markStripeEvent(c.env.D1, event.id, event.type);
  return c.json({ received: true, handled: true });
});

app.get('/api/billing/status', async (c) => {
  const { orgId } = c.get('principal');
  const [live, org] = await Promise.all([
    c.env.BILLING_GUARD.getByName(orgId).status(),
    findOrganization(c.env.D1, orgId),
  ]);
  return c.json({
    orgId,
    tier: org?.tier ?? 'none',
    seats: org?.seats ?? 1,
    samlSso: (org?.saml_sso_enabled ?? 0) === 1,
    b4AuditLog: (org?.b4_audit_log_enabled ?? 0) === 1,
    hardCap: live.hardCap,
    balancePence: {
      monthly: live.monthlyPence,
      topup: live.topupPence,
      held: live.heldPence,
      available: live.availablePence,
    },
  });
});

// Operator: internal jobs, authenticated with GATEWAY_API_TOKEN. Tenants cannot reach these.

app.post('/api/admin/reconcile', async (c) => {
  const body = await readJson<{ orgIds?: unknown }>(c.req.raw).catch(() => ({}) as { orgIds?: unknown });
  let orgIds: string[] | undefined;
  if (body.orgIds !== undefined) {
    if (!Array.isArray(body.orgIds) || body.orgIds.length > MAX_RECONCILE_ORGS || !body.orgIds.every(isIdentifier)) {
      throw new GitViseError('INVALID_REQUEST', `orgIds must be up to ${MAX_RECONCILE_ORGS} identifiers`);
    }
    orgIds = body.orgIds as string[];
  }
  return c.json(await reconcileBilling(c.env, orgIds === undefined ? {} : { orgIds }));
});

// apps/api owns everything this Worker does not: repositories, issues, pull requests, projects, Git smart HTTP,
// and MCP. Those requests are forwarded, unchanged, to the one apps/api container instance. `/internal` is the
// gateway's own container-facing surface, and `/api/admin` is operator-only. Neither is ever forwarded.
const NEVER_FORWARDED = /^\/+(?:internal|api\/admin)(?:\/|$)/i;

app.all('*', async (c) => {
  const incoming = new URL(c.req.url);
  if (NEVER_FORWARDED.test(incoming.pathname)) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'no such route' } }, 404);
  }
  if (c.env.GitViseApiContainer === undefined) return unconfigured(c, 'the apps/api container is not bound');

  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

  // The container trusts only identity this gateway signs. A signed-in browser session, or a tenant API key, gets
  // its identity attached here. Any other caller is forwarded with no identity, and the container checks its own
  // bearer token (for example a personal access token used by Git). A caller's identity headers are never kept.
  const principal = await resolvePrincipal(c);
  if (principal !== undefined) {
    const refusal = refuseCrossSiteWrite(c, principal);
    if (refusal !== undefined) return refusal;
    const secret = c.env.INTERNAL_GATEWAY_SECRET ?? '';
    if (secret === '') return unconfigured(c, 'INTERNAL_GATEWAY_SECRET is not set');
    await setGatewayIdentity(headers, secret, {
      method: c.req.method,
      path: incoming.pathname,
      userId: principal.userId,
      orgId: principal.orgId,
      timestamp: Date.now(),
    });
  } else {
    for (const name of GATEWAY_IDENTITY_HEADERS) headers.delete(name);
  }

  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const forwarded = new Request(incoming, {
    method: c.req.method,
    headers,
    body: hasBody ? c.req.raw.body : null,
  });
  return c.env.GitViseApiContainer.getByName(API_CONTAINER_INSTANCE).fetch(forwarded);
});

interface WireRecord {
  readonly id: string;
  readonly namespace: string;
  readonly kind: VectorRecordKind;
  readonly embedding: number[];
  readonly payload: VectorRecord['payload'];
}

interface WireQuery {
  readonly namespace: string;
  readonly embedding: number[];
  readonly topK: number;
  readonly kind?: VectorRecordKind;
  readonly minScore?: number;
}

interface InferenceBody {
  readonly requestId?: unknown;
  readonly messages?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly temperature?: unknown;
}

interface CheckoutBody {
  readonly kind?: unknown;
  readonly tier?: unknown;
  readonly seats?: unknown;
}

function roomRef(orgId: string, worktreeId: string, roomId: string): RealtimeRoomRef {
  return { worktreeId: scopeId(orgId, worktreeId, 'worktreeId'), roomId };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isIdentifier(value: unknown): boolean {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isTaskAction(value: string): value is (typeof TASK_ACTIONS)[number] {
  return (TASK_ACTIONS as readonly string[]).includes(value);
}

function isInferenceTier(value: string): value is InferenceTier {
  return (INFERENCE_TIERS as readonly string[]).includes(value);
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GitViseError('INVALID_REQUEST', `${field} must be a positive integer`);
  }
  return value;
}

function temperatureValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new GitViseError('INVALID_REQUEST', 'temperature must be from 0 to 2');
  }
  return value;
}

function parseMessages(value: unknown): InferenceMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new GitViseError('INVALID_REQUEST', 'messages must be an array of 1-100 entries');
  }
  let total = 0;
  return value.map((entry: unknown) => {
    const message = entry as Partial<InferenceMessage> | null;
    if (typeof message !== 'object' || message === null) {
      throw new GitViseError('INVALID_REQUEST', 'each message must be an object');
    }
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
      throw new GitViseError('INVALID_REQUEST', 'message role must be system, user, or assistant');
    }
    if (typeof message.content !== 'string') throw new GitViseError('INVALID_REQUEST', 'message content must be a string');
    total += message.content.length;
    if (total > MAX_MESSAGE_CHARS) throw new GitViseError('INVALID_REQUEST', 'messages exceed the size limit');
    return { role: message.role, content: message.content };
  });
}

function seatCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SEATS) {
    throw new GitViseError('INVALID_REQUEST', `seats must be an integer from 1 to ${MAX_SEATS}`);
  }
  return value;
}

function priceFor(env: GatewayEnv, tier: PaidTier): string {
  switch (tier) {
    case 'pro':
      return env.STRIPE_PRICE_PRO ?? '';
    case 'business':
      return env.STRIPE_PRICE_BUSINESS_SEAT ?? '';
    case 'enterprise':
      return env.STRIPE_PRICE_ENTERPRISE_SEAT ?? '';
  }
}

function unconfigured(c: Context<AppEnv>, message: string): Response {
  return c.json({ error: { code: 'UNCONFIGURED', message } }, 503);
}

/** Decodes a Stripe event payload. Returns undefined when it is not the expected shape. */
function parseStripeEvent(payload: string): StripeEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const event = parsed as Partial<StripeEvent>;
  if (typeof event.id !== 'string' || typeof event.type !== 'string') return undefined;
  const object = event.data?.object;
  if (typeof object !== 'object' || object === null) return undefined;
  return { id: event.id, type: event.type, data: { object } };
}

/** Forwards realtime events to a WebSocket as JSON text. Ends the socket when the room stream ends. */
async function pump(reader: ReadableStreamDefaultReader<RealtimeEvent>, socket: WebSocket): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      socket.send(JSON.stringify(toWire(value)));
    }
    socket.close(1000, 'room closed');
  } catch {
    socket.close(1011, 'room stream failed');
  }
}

function toWire(event: RealtimeEvent): unknown {
  if (event.type === 'presence' || event.type === 'agent') return event;
  return { type: event.type, room: event.room, origin: event.origin, update: toBase64(event.update) };
}