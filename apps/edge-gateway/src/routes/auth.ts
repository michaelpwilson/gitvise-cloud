import { Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { hashPassword, randomHex, verifyPassword } from '../crypto';
import { emailValue, isUniqueViolation, passwordValue, readJson } from '../http';
import {
  requirePrincipal,
  roleFor,
  SESSION_COOKIE,
  SESSION_COOKIE_ATTRIBUTES,
  sessionIdFromCookie,
} from '../auth/principal';
import { sessionSecret, startSession, unconfigured } from '../auth/session-issue';
import { signupRoutes } from './signup';
import { onboardingRoutes } from './onboarding';

/**
 * Dashboard sign-up and sign-in. Both are public, since they are how a caller gets a session. Sign-up provisions
 * a personal organisation and makes the new user its owner, so every account is a tenant from its first request.
 *
 * `POST /register` is the one-step password sign-up that predates the wizard. The wizard uses `/signup/*`, which
 * confirms the email before it creates the account. See ./signup.ts.
 */
export const authRoutes = new Hono<AppEnv>();

authRoutes.route('/signup', signupRoutes);
authRoutes.route('/onboarding', onboardingRoutes);

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
      // apps/api bills a personal repository through this row (see loadPersonalOwnerBilling). Without it, chat is refused.
      c.env.D1.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?1, ?2, 'owner')").bind(
        orgId,
        userId,
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

/**
 * Who the caller is. Accepts a session cookie or an API key, so the dashboard's auth guard and the CLI can both
 * ask. The email comes from the users row, because sessions and keys carry only ids.
 */
authRoutes.get('/me', requirePrincipal, async (c) => {
  const principal = c.get('principal');
  const row = await c.env.D1.prepare('SELECT email FROM users WHERE id = ?1 AND org_id = ?2')
    .bind(principal.userId, principal.orgId)
    .first<{ email: string }>();
  // A valid session for a user who no longer exists is not a signed-in user.
  if (row === null) return c.json({ error: { code: 'UNAUTHORIZED', message: 'sign in or present a valid API key' } }, 401);

  c.header('cache-control', 'no-store');
  return c.json({ userId: principal.userId, orgId: principal.orgId, email: row.email, role: principal.role });
});

/**
 * Ends the caller's dashboard session on the server, then clears the cookie. Public and idempotent: it succeeds with
 * or without a session, so a stale browser can always sign out. Only a correctly signed cookie can revoke anything,
 * so a stranger cannot sign out someone else.
 */
authRoutes.post('/logout', async (c) => {
  const sid = await sessionIdFromCookie(c.env, getCookie(c, SESSION_COOKIE));
  if (sid !== undefined) {
    await c.env.D1.prepare('UPDATE sessions SET revoked_at = unixepoch() WHERE id = ?1 AND revoked_at IS NULL').bind(sid).run();
  }
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_ATTRIBUTES);
  c.header('cache-control', 'no-store');
  return c.body(null, 204);
});

let decoy: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword('decoy-password-never-matches');
  return decoy;
}
