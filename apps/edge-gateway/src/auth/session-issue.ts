import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppEnv } from '../app-env';
import { randomHex, signToken } from '../crypto';
import { SESSION_COOKIE, SESSION_COOKIE_ATTRIBUTES, SESSION_TTL_SECONDS } from './principal';
import type { Role } from './types';

/** The HMAC key for sessions. Undefined when unset, so sign-in refuses rather than issuing unverifiable tokens. */
export function sessionSecret(c: Context<AppEnv>): string | undefined {
  const secret = c.env.SESSION_SECRET ?? '';
  return secret === '' ? undefined : secret;
}

export function unconfigured(c: Context<AppEnv>): Response {
  return c.json({ error: { code: 'UNCONFIGURED', message: 'SESSION_SECRET is not set' } }, 503);
}

/** Records a session row, then sets a cookie that points at it. The row is what makes the session valid. */
export async function startSession(
  c: Context<AppEnv>,
  secret: string,
  claims: { readonly userId: string; readonly orgId: string; readonly role: Role },
): Promise<void> {
  const sid = `ses-${randomHex(16)}`;
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await c.env.D1.prepare('INSERT INTO sessions (id, user_id, org_id, role, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(sid, claims.userId, claims.orgId, claims.role, exp)
    .run();
  const token = await signToken({ sid, sub: claims.userId, org: claims.orgId, role: claims.role, exp }, secret);
  setCookie(c, SESSION_COOKIE, token, { ...SESSION_COOKIE_ATTRIBUTES, maxAge: SESSION_TTL_SECONDS });
}
