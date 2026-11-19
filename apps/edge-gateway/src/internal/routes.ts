import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { readJson } from '../http';
import { constraintFailure, parseStatement, runBatch, runQuery, type D1WireStatement } from './d1';
import { verifyInternalSignature } from './signature';
import { deleteVectors, queryVectors, upsertVectors } from './vector';

/**
 * Container-to-gateway routes, mounted at `/internal`. Only the apps/api container calls them, and every request must
 * carry a valid `gitvise-internal-v1` signature. Tenants never reach this path.
 */
export const internalRoutes = new Hono<AppEnv>();

/**
 * Checks the signature before any route runs. The body is read from a clone, so the handler can still read it. A
 * missing secret refuses everything, so an unconfigured gateway cannot be called.
 */
const requireInternal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = c.env.INTERNAL_GATEWAY_SECRET ?? '';
  if (secret === '') {
    return c.json({ code: 'UNCONFIGURED', message: 'internal gateway secret is not configured' }, 503);
  }
  const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const url = new URL(c.req.url);
  const ok = await verifyInternalSignature({
    secret,
    method: c.req.method,
    pathAndQuery: url.pathname + url.search,
    headers: c.req.raw.headers,
    body,
  });
  if (!ok) return c.json({ code: 'UNAUTHORIZED', message: 'signature check failed' }, 401);
  return next();
};

internalRoutes.use('*', requireInternal);

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
