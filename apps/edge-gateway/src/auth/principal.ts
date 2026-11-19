import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app-env';
import type { GatewayEnv } from '../env';
import { sha256Hex, timingSafeEqualText, verifyToken } from '../crypto';
import type { CachedKey, Principal, Role, SessionClaims } from './types';

/** Every tenant API key starts with this prefix, so a bearer token can be routed to the right check. */
export const API_KEY_PREFIX = 'gv_live_';
export const SESSION_COOKIE = 'gv_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** How long a verified key stays in KV. Revocation deletes the entry, so the window is only for keys that
 *  were revoked on another edge location in the last minute. */
const KEY_CACHE_TTL_SECONDS = 60;

/** Maps the stored user role onto the two roles tenants see. `admin` gets member rights. */
export function roleFor(userRole: string): Role {
  return userRole === 'owner' ? 'owner' : 'member';
}

export function apiKeyCacheKey(keyHash: string): string {
  return `apikey:${keyHash}`;
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
    return token.startsWith(API_KEY_PREFIX) ? resolveApiKey(c.env, token) : undefined;
  }
  const session = getCookie(c, SESSION_COOKIE);
  return session === undefined ? undefined : resolveSession(c.env, session);
}

async function resolveApiKey(env: GatewayEnv, token: string): Promise<Principal | undefined> {
  const keyHash = await sha256Hex(token);
  const cacheKey = apiKeyCacheKey(keyHash);

  const cached = await env.KV.get<CachedKey>(cacheKey, 'json');
  if (cached !== null) return { ...cached, via: 'api-key' };

  const row = await env.D1.prepare(
    'SELECT id, org_id, user_id, role FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL',
  )
    .bind(keyHash)
    .first<{ id: string; org_id: string; user_id: string; role: Role }>();
  if (row === null) return undefined;

  const entry: CachedKey = { orgId: row.org_id, userId: row.user_id, role: row.role, keyId: row.id };
  await env.KV.put(cacheKey, JSON.stringify(entry), { expirationTtl: KEY_CACHE_TTL_SECONDS });
  return { ...entry, via: 'api-key' };
}

async function resolveSession(env: GatewayEnv, token: string): Promise<Principal | undefined> {
  const secret = env.SESSION_SECRET ?? '';
  if (secret === '') return undefined;
  const claims = await verifyToken<SessionClaims>(token, secret);
  if (claims === undefined || typeof claims.sub !== 'string' || typeof claims.org !== 'string') return undefined;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return undefined;
  if (claims.role !== 'owner' && claims.role !== 'member') return undefined;
  return { orgId: claims.org, userId: claims.sub, role: claims.role, via: 'session' };
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

function isWrite(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function isJson(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.toLowerCase().startsWith('application/json');
}
