import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { readJson } from '../http';
import { constraintFailure, parseStatement, runBatch, runQuery, type D1WireStatement } from './d1';
import { INTERNAL_HEADERS, INTERNAL_MAX_SKEW_MS, STREAMED_BODY, UNSIGNED_PAYLOAD, verifyInternalSignature } from './signature';
import { kvRoutes } from './kv';
import { portRoutes } from './ports';
import { queueRoutes } from './queues';
import { deleteVectors, queryVectors, upsertVectors } from './vector';

/**
 * Container-to-gateway routes, mounted at `/internal`. Only the apps/api container calls them, and every request must
 * carry a valid `gitvise-internal-v1` signature. Tenants never reach this path.
 */
export const internalRoutes = new Hono<AppEnv>();

/**
 * Blob writes are the only streamed bodies. They are signed as `UNSIGNED-PAYLOAD`, so the gateway never buffers
 * a packfile. R2 checks the digest in the path while it writes.
 */
const STREAMED_ROUTE = /^\/internal\/ports\/blob\/(?:packfile|lfs-object)\/[0-9a-f]{64}$/;

/**
 * Checks the signature before any route runs, then refuses a nonce the gateway has already seen. A replayed signed
 * request is therefore refused even inside the skew window. The body is buffered, except for a streamed route, so the
 * digest can be checked. A missing secret refuses everything, so an unconfigured gateway cannot be called.
 */
const requireInternal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = c.env.INTERNAL_GATEWAY_SECRET ?? '';
  if (secret === '') {
    return c.json({ code: 'UNCONFIGURED', message: 'internal gateway secret is not configured' }, 503);
  }
  const streamed = c.req.header(INTERNAL_HEADERS.contentSha256) === UNSIGNED_PAYLOAD;
  if (streamed && !(c.req.method === 'PUT' && STREAMED_ROUTE.test(c.req.path))) {
    return c.json({ code: 'UNAUTHORIZED', message: 'signature check failed' }, 401);
  }
  const body = streamed ? STREAMED_BODY : new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const url = new URL(c.req.url);
  const ok = await verifyInternalSignature({
    secret,
    method: c.req.method,
    pathAndQuery: url.pathname + url.search,
    headers: c.req.raw.headers,
    body,
  });
  if (!ok) return c.json({ code: 'UNAUTHORIZED', message: 'signature check failed' }, 401);

  // Claimed after the signature passes, so an unsigned caller cannot fill the nonce table. The claim lasts past
  // the skew window, so a captured request stays refused for as long as its signature would still verify.
  const nonce = c.req.header(INTERNAL_HEADERS.nonce) ?? '';
  const fresh = await c.env.KV_ENTRIES.getByName(`nonce:${nonce}`).put('1', {
    ifAbsent: true,
    ttlMs: 2 * INTERNAL_MAX_SKEW_MS,
  });
  if (!fresh) return c.json({ code: 'UNAUTHORIZED', message: 'request nonce was already used' }, 401);
  return next();
};

internalRoutes.use('*', requireInternal);
internalRoutes.route('/', kvRoutes);
internalRoutes.route('/', portRoutes);
internalRoutes.route('/', queueRoutes);

/**
 * A SQLite constraint violation is a client conflict, not a gateway fault. It answers 409 with a top-level
 * `{ code, message }`, which is the shape apps/api reads. Other D1 errors are rethrown to the app error handler, so
 * they keep their existing status.
 */
internalRoutes.post('/d1/query', async (c) => {
  const statement = parseStatement(await readJson<unknown>(c.req.raw));
  return withConstraintMapping(c, () => runQuery(c.env.D1, statement));
});

internalRoutes.post('/d1/batch', async (c) => {
  const body = await readJson<{ statements?: unknown }>(c.req.raw);
  if (!Array.isArray(body.statements) || body.statements.length === 0) {
    throw new GitViseError('INVALID_REQUEST', 'statements must be a non-empty array');
  }
  const statements: D1WireStatement[] = body.statements.map(parseStatement);
  return withConstraintMapping(c, () => runBatch(c.env.D1, statements));
});

/**
 * Vector port, the calls behind apps/api's `CloudVectorMemoryPort`. Each answers JSON, because the apps/api client
 * parses every body, so a 204 would break it. Upsert and delete return a count.
 */
internalRoutes.post('/ports/vector/upsert', async (c) => {
  const upserted = await upsertVectors(c.env, await readJson<{ records?: unknown }>(c.req.raw));
  return c.json({ upserted });
});

internalRoutes.post('/ports/vector/query', async (c) => {
  return c.json(await queryVectors(c.env, await readJson<unknown>(c.req.raw)));
});

internalRoutes.post('/ports/vector/delete', async (c) => {
  await deleteVectors(c.env, await readJson<unknown>(c.req.raw));
  return c.json({ ok: true });
});

async function withConstraintMapping<T>(c: Context<AppEnv>, run: () => Promise<T>): Promise<Response> {
  try {
    return c.json(await run());
  } catch (error: unknown) {
    const failure = constraintFailure(error);
    if (failure === undefined) throw error;
    return c.json({ code: failure.code, message: failure.message }, 409);
  }
}
