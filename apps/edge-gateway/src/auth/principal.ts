import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app-env';
import type { GatewayEnv } from '../env';
import { sha256Hex, timingSafeEqualText, verifyToken } from '../crypto';
import type { Principal, Role, SessionClaims } from './types';

/** Every tenant API key starts with this prefix, so a bearer token can be routed to the right check. */
export const API_KEY_PREFIX = 'gv_live_';
export const SESSION_COOKIE = 'gv_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/**
 * Attributes shared by the login cookie and the logout cookie. A clearing Set-Cookie only replaces the session
 * cookie when name, path, domain, and the same-site and secure settings match, so both paths read from here.
 */
export const SESSION_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
} as const;

/** Maps the stored user role onto the two roles tenants see. `admin` gets member rights. */
export function roleFor(userRole: string): Role {
  return userRole === 'owner' ? 'owner' : 'member';
}

/**
 * Resolves the caller from the request alone. A `Bearer gv_live_...` header is checked against D1 by digest. Any
 * other bearer value is refused, and a session cookie is only read when no bearer header is present. The operator
 * token is not a principal: it can never pass this function.
 */
export async function resolvePrincipal(c: Context<AppEnv>): Promise<Principal | undefined> {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length);
    return token.startsWith(API_KEY_PREFIX) ? resolveApiKey(c, token) : undefined;
  }
  const session = getCookie(c, SESSION_COOKIE);
  return session === undefined ? undefined : resolveSession(c, session);
}

/**
 * Every key use is checked against D1, so a revoked key stops working on the next request, in every location.
 * There is no key cache to go stale. The cost is one read per API-key request.
 */
async function resolveApiKey(c: Context<AppEnv>, token: string): Promise<Principal | undefined> {
  const keyHash = await sha256Hex(token);
  const row = await c.env.D1.prepare('SELECT id, org_id, user_id, role FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL')
    .bind(keyHash)
    .first<{ id: string; org_id: string; user_id: string; role: Role }>();
  if (row === null) return undefined;

  await recordKeyUse(c, row.id);
  return { orgId: row.org_id, userId: row.user_id, role: row.role, via: 'api-key', keyId: row.id };
}

/**
 * Stamps `last_used_at` on every request that uses the key. It runs after the response when the runtime allows
 * (`waitUntil`), so it adds no latency. Without an execution context, as in tests, it is awaited. A failed stamp is
 * logged and never fails the request, because the key was valid.
 */
async function recordKeyUse(c: Context<AppEnv>, keyId: string): Promise<void> {
  const stamp = c.env.D1.prepare('UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?1')
    .bind(keyId)
    .run()
    .then(
      () => undefined,
      (error: unknown) => {
        console.error(`api key last-use write failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  try {
    c.executionCtx.waitUntil(stamp);
  } catch {
    await stamp;
  }
}

async function resolveSession(c: Context<AppEnv>, token: string): Promise<Principal | undefined> {
  const secret = c.env.SESSION_SECRET ?? '';
  if (secret === '') return undefined;
  const claims = await verifyToken<SessionClaims>(token, secret);
  // Tokens without a session id predate server-side sessions, so they are refused. Those users sign in again.
  if (claims === undefined || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return undefined;

  // The row is the authority. A token whose session was logged out, or that the server never issued, is refused
  // even though its signature checks out. This is what makes logout take effect at once.
  const row = await c.env.D1.prepare('SELECT user_id, org_id, role, expires_at, revoked_at FROM sessions WHERE id = ?1')
    .bind(claims.sid)
    .first<{ user_id: string; org_id: string; role: string; expires_at: number; revoked_at: number | null }>();
  if (row === null || row.revoked_at !== null || row.expires_at <= now) return undefined;
  if (row.user_id !== claims.sub || row.org_id !== claims.org) return undefined;
  if (row.role !== 'owner' && row.role !== 'member') return undefined;
  return { orgId: row.org_id, userId: row.user_id, role: row.role, via: 'session' };
}

/** Any authenticated tenant caller: an API key, or a signed-in dashboard session. */
export const requirePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = await resolvePrincipal(c);
  if (principal === undefined) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'sign in or present a valid API key' } }, 401);
  }
  const refusal = refuseCrossSiteWrite(c, principal);
  if (refusal !== undefined) return refusal;
  c.set('principal', principal);
  return next();
};

/** Dashboard sessions only. API keys cannot mint more keys, so a leaked key cannot widen its own access. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = await resolvePrincipal(c);
  if (principal === undefined || principal.via !== 'session') {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'this action needs a signed-in dashboard session' } }, 401);
  }
  const refusal = refuseCrossSiteWrite(c, principal);
  if (refusal !== undefined) return refusal;
  c.set('principal', principal);
  return next();
};

/**
 * Cookie-authenticated writes must be JSON. A cross-site form cannot send that content type, which closes the CSRF
 * path even if a browser were to send the cookie. Bearer callers are not affected: they never send cookies.
 */
function refuseCrossSiteWrite(c: Context<AppEnv>, principal: Principal): Response | undefined {
  if (principal.via === 'session' && isWrite(c.req.method) && !isJson(c.req.header('content-type'))) {
    return c.json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'session writes must be application/json' } }, 415);
  }
  return undefined;
}

/** Owners only. Used for billing actions that change what the organisation pays for. */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const principal = c.get('principal');
  if (principal.role !== 'owner') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'only an owner of the organisation can do this' } }, 403);
  }
  return next();
};

/**
 * Operator key, for internal jobs such as manual reconciliation. It is not a tenant credential and is refused
 * everywhere a tenant could reach. With no token configured it refuses everything.
 */
export const requireOperator: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.GATEWAY_API_TOKEN ?? '';
  if (expected === '') {
    return c.json({ error: { code: 'UNCONFIGURED', message: 'GATEWAY_API_TOKEN is not set' } }, 503);
  }
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!timingSafeEqualText(presented, expected)) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid operator token' } }, 401);
  }
  return next();
};

/**
 * The session id inside a session cookie, if the cookie carries a valid signature. Used by logout, which must
 * revoke the session it belongs to even when the session has expired or been revoked already.
 */
export async function sessionIdFromCookie(env: GatewayEnv, cookie: string | undefined): Promise<string | undefined> {
  const secret = env.SESSION_SECRET ?? '';
  if (cookie === undefined || secret === '') return undefined;
  const claims = await verifyToken<{ sid?: unknown }>(cookie, secret);
  return typeof claims?.sid === 'string' ? claims.sid : undefined;
}

function isWrite(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function isJson(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.toLowerCase().startsWith('application/json');
}
