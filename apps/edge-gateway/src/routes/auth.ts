import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { hashPassword, randomHex, signToken, verifyPassword } from '../crypto';
import { emailValue, isUniqueViolation, passwordValue, readJson } from '../http';
import { roleFor, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../auth/principal';
import type { Role } from '../auth/types';

/**
 * Dashboard sign-up and sign-in. Both are public, since they are how a caller gets a session. Sign-up provisions
 * a personal organisation and makes the new user its owner, so every account is a tenant from its first request.
 */
export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/register', async (c) => {
  const secret = sessionSecret(c);
  if (secret === undefined) return unconfigured(c);
  const body = await readJson<{ email?: unknown; password?: unknown }>(c.req.raw);
  const email = emailValue(body.email);
  const password = passwordValue(body.password);

  const existing = await c.env.D1.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (existing !== null) throw new GitViseError('CONFLICT', 'an account already exists for this email');

  // Org and user ids are random and gateway-generated, so a caller can never pick a tenant id.
  const orgId = `org-${randomHex(8)}`;
  const userId = `usr-${randomHex(8)}`;
  const passwordHash = await hashPassword(password);
  try {
    await c.env.D1.batch([
      c.env.D1.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?2)').bind(orgId, email),
      c.env.D1.prepare("INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?1, ?2, ?3, 'owner', ?4)").bind(
        userId,
        orgId,
        email,
        passwordHash,
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new GitViseError('CONFLICT', 'an account already exists for this email');
    throw error;
  }

  await startSession(c, secret, { userId, orgId, role: 'owner' });
  return c.json({ orgId, userId, role: 'owner' }, 201);
});

authRoutes.post('/login', async (c) => {
  const secret = sessionSecret(c);
  if (secret === undefined) return unconfigured(c);
  const body = await readJson<{ email?: unknown; password?: unknown }>(c.req.raw);
  const email = emailValue(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  const user = await c.env.D1.prepare('SELECT id, org_id, role, password_hash FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: string; org_id: string; role: string; password_hash: string | null }>();

  // Run the hash either way, so the response time does not reveal whether the email exists.
  const stored = user?.password_hash ?? (await decoyHash());
  const matches = await verifyPassword(password, stored);
  if (user === null || user.password_hash === null || !matches) {
    return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'email or password is incorrect' } }, 401);
  }

  const role = roleFor(user.role);
  await startSession(c, secret, { userId: user.id, orgId: user.org_id, role });
  return c.json({ orgId: user.org_id, userId: user.id, role });
});

/** The HMAC key for sessions. Undefined when unset, so sign-in refuses rather than issuing unverifiable tokens. */
function sessionSecret(c: Context<AppEnv>): string | undefined {
  const secret = c.env.SESSION_SECRET ?? '';
  return secret === '' ? undefined : secret;
}

function unconfigured(c: Context<AppEnv>): Response {
  return c.json({ error: { code: 'UNCONFIGURED', message: 'SESSION_SECRET is not set' } }, 503);
}

async function startSession(
  c: Context<AppEnv>,
  secret: string,
  claims: { readonly userId: string; readonly orgId: string; readonly role: Role },
): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await signToken({ sub: claims.userId, org: claims.orgId, role: claims.role, exp }, secret);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

let decoy: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword('decoy-password-never-matches');
  return decoy;
}
