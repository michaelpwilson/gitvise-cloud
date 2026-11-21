import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { base64url, hashPassword, randomBytes, randomHex, sha256Hex } from '../crypto';
import { emailValue, isUniqueViolation, passwordValue, readJson } from '../http';
import { sendConfirmationEmail } from '../email/transactional';
import { sessionSecret, startSession, unconfigured } from '../auth/session-issue';
import { nameValue, planValue, seatsFor, termsAccepted, usernameValue } from '../signup/validate';

/**
 * The signup wizard's account creation. A registration is held in `pending_signups` until the emailed link is
 * opened. Only then does the gateway create the user, the personal organisation, and a session.
 *
 * The pending row is found by an HttpOnly cookie that holds its id. The emailed link carries a random token, and only
 * its SHA-256 is stored, so a leaked database does not expose a usable link.
 */
export const signupRoutes = new Hono<AppEnv>();

export const SIGNUP_COOKIE = 'gv_signup';
const SIGNUP_COOKIE_PATH = '/api/auth/signup';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const DEFAULT_FROM = 'GitStrand <no-reply@mail.gitvise.com>';

interface PendingRow {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly password_hash: string;
  readonly plan: string;
  readonly seats: number;
  readonly token_hash: string;
  readonly expires_at: number;
  readonly last_sent_at: number;
}

interface StartBody {
  readonly email?: unknown;
  readonly password?: unknown;
  readonly firstName?: unknown;
  readonly lastName?: unknown;
  readonly username?: unknown;
  readonly termsAccepted?: unknown;
  readonly plan?: unknown;
  readonly seats?: unknown;
}

signupRoutes.post('/start', async (c) => {
  const secret = sessionSecret(c);
  if (secret === undefined) return unconfigured(c);
  requireJsonBody(c);
  const body = await readJson<StartBody>(c.req.raw);
  const email = emailValue(body.email);
  const password = passwordValue(body.password);
  const firstName = nameValue(body.firstName, 'first name');
  const lastName = nameValue(body.lastName, 'last name');
  const username = usernameValue(body.username);
  termsAccepted(body.termsAccepted);
  const plan = planValue(body.plan);
  const seats = seatsFor(plan, body.seats);

  await assertAvailable(c, email, username);

  const id = `sgn-${randomHex(12)}`;
  const token = base64url(randomBytes(32));
  const now = Date.now();
  const passwordHash = await hashPassword(password);

  // A new registration for the same email replaces the earlier pending one, so the newest link is the only live one.
  await c.env.D1.prepare('DELETE FROM pending_signups WHERE lower(email) = lower(?1)').bind(email).run();
  try {
    await c.env.D1.prepare(
      `INSERT INTO pending_signups
         (id, email, username, first_name, last_name, password_hash, plan, seats, token_hash, expires_at, last_sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(id, email, username, firstName, lastName, passwordHash, plan, seats, await sha256Hex(token), now + TOKEN_TTL_MS, now)
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new GitViseError('CONFLICT', 'that username is already being registered');
    throw error;
  }

  try {
    await sendConfirmationEmail(mailer(c), fromAddress(c), {
      to: email,
      firstName,
      link: confirmationLink(c, token),
      expiresInHours: TOKEN_TTL_MS / 3_600_000,
    });
  } catch (error) {
    await c.env.D1.prepare('DELETE FROM pending_signups WHERE id = ?1').bind(id).run();
    throw error;
  }

  setCookie(c, SIGNUP_COOKIE, id, signupCookieAttributes());
  c.header('cache-control', 'no-store');
  return c.json({ status: 'confirm-email', email, resendAvailableAt: now + RESEND_COOLDOWN_MS }, 202);
});

/** The wizard asks this on load, so a refresh or a new tab resumes at the confirm-email screen. */
signupRoutes.get('/status', async (c) => {
  const pending = await pendingFromCookie(c);
  c.header('cache-control', 'no-store');
  if (pending === undefined) return c.json({ status: 'none' });
  return c.json({
    status: 'confirm-email',
    email: pending.email,
    plan: pending.plan,
    seats: pending.seats,
    resendAvailableAt: pending.last_sent_at + RESEND_COOLDOWN_MS,
  });
});

signupRoutes.post('/resend', async (c) => {
  requireJsonBody(c);
  const pending = await pendingFromCookie(c);
  if (pending === undefined) throw new GitViseError('NOT_FOUND', 'no registration is waiting for confirmation');

  const now = Date.now();
  const readyAt = pending.last_sent_at + RESEND_COOLDOWN_MS;
  if (now < readyAt) {
    c.header('retry-after', String(Math.ceil((readyAt - now) / 1000)));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'wait a minute before asking for another email' } }, 429);
  }

  const token = base64url(randomBytes(32));
  // The `last_sent_at` check makes two rapid resends race to one winner, so only one link is live.
  const updated = await c.env.D1.prepare(
    'UPDATE pending_signups SET token_hash = ?1, expires_at = ?2, last_sent_at = ?3 WHERE id = ?4 AND last_sent_at = ?5',
  )
    .bind(await sha256Hex(token), now + TOKEN_TTL_MS, now, pending.id, pending.last_sent_at)
    .run();
  if (updated.meta.changes === 0) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'wait a minute before asking for another email' } }, 429);
  }

  await sendConfirmationEmail(mailer(c), fromAddress(c), {
    to: pending.email,
    firstName: pending.first_name,
    link: confirmationLink(c, token),
    expiresInHours: TOKEN_TTL_MS / 3_600_000,
  });
  c.header('cache-control', 'no-store');
  return c.json({ status: 'confirm-email', email: pending.email, resendAvailableAt: now + RESEND_COOLDOWN_MS }, 202);
});

/**
 * The link in the email. It is a GET, because email clients open links that way. It creates the account and sets the
 * session, then sends the browser into the app, where the onboarding steps take over.
 */
signupRoutes.get('/confirm', async (c) => {
  const appUrl = publicAppUrl(c);
  const token = c.req.query('token') ?? '';
  if (token.length < 20 || token.length > 200) return c.redirect(`${appUrl}/register?confirm=invalid`, 303);

  const pending = await c.env.D1.prepare(
    `SELECT id, email, username, first_name, last_name, password_hash, plan, seats, token_hash, expires_at, last_sent_at
       FROM pending_signups WHERE token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first<PendingRow>();
  if (pending === null) return c.redirect(`${appUrl}/register?confirm=invalid`, 303);
  if (pending.expires_at <= Date.now()) return c.redirect(`${appUrl}/register?confirm=expired`, 303);

  const secret = sessionSecret(c);
  if (secret === undefined) return unconfigured(c);

  const taken = await findTaken(c, pending.email, pending.username);
  if (taken !== undefined) return c.redirect(`${appUrl}/register?confirm=taken`, 303);

  const orgId = `org-${randomHex(8)}`;
  const userId = `usr-${randomHex(8)}`;
  const now = Date.now();
  try {
    await c.env.D1.batch([
      c.env.D1.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?2)').bind(orgId, pending.username),
      c.env.D1.prepare(
        `INSERT INTO users (id, org_id, email, username, role, password_hash, first_name, last_name,
                            email_verified_at, terms_accepted_at, plan_choice, seat_choice, passkey_required,
                            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'owner', ?5, ?6, ?7, ?8, ?8, ?9, ?10, 1, ?8, ?8)`,
      ).bind(
        userId,
        orgId,
        pending.email,
        pending.username,
        pending.password_hash,
        pending.first_name,
        pending.last_name,
        now,
        pending.plan,
        pending.seats,
      ),
      // apps/api bills a personal repository through this row (see loadPersonalOwnerBilling). Without it, chat is refused.
      c.env.D1.prepare(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?1, ?2, 'owner')",
      ).bind(orgId, userId),
      c.env.D1.prepare('DELETE FROM pending_signups WHERE id = ?1').bind(pending.id),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) return c.redirect(`${appUrl}/register?confirm=taken`, 303);
    throw error;
  }

  await startSession(c, secret, { userId, orgId, role: 'owner' });
  deleteCookie(c, SIGNUP_COOKIE, { path: SIGNUP_COOKIE_PATH });
  return c.redirect(`${appUrl}/`, 303);
});

async function pendingFromCookie(c: Context<AppEnv>): Promise<PendingRow | undefined> {
  const id = getCookie(c, SIGNUP_COOKIE);
  if (id === undefined || !/^sgn-[0-9a-f]{24}$/.test(id)) return undefined;
  const row = await c.env.D1.prepare(
    `SELECT id, email, username, first_name, last_name, password_hash, plan, seats, token_hash, expires_at, last_sent_at
       FROM pending_signups WHERE id = ?1 AND expires_at > ?2`,
  )
    .bind(id, Date.now())
    .first<PendingRow>();
  return row ?? undefined;
}

/** Refuses an email or username that already belongs to an account, or to another registration in progress. */
async function assertAvailable(c: Context<AppEnv>, email: string, username: string): Promise<void> {
  const taken = await findTaken(c, email, username);
  if (taken === 'email') throw new GitViseError('CONFLICT', 'an account already exists for this email');
  if (taken === 'username') throw new GitViseError('CONFLICT', 'that username is already taken');
}

async function findTaken(c: Context<AppEnv>, email: string, username: string): Promise<'email' | 'username' | undefined> {
  const byEmail = await c.env.D1.prepare('SELECT id FROM users WHERE lower(email) = lower(?1)').bind(email).first();
  if (byEmail !== null) return 'email';
  const byUsername = await c.env.D1.prepare('SELECT id FROM users WHERE lower(username) = lower(?1)').bind(username).first();
  if (byUsername !== null) return 'username';
  return undefined;
}

function requireJsonBody(c: Context<AppEnv>): void {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new GitViseError('INVALID_REQUEST', 'this request must be JSON');
  }
}

function mailer(c: Context<AppEnv>): { send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown> } | undefined {
  const binding = c.env.EMAIL;
  if (binding === undefined) return undefined;
  return { send: (message) => binding.send(message) };
}

function fromAddress(c: Context<AppEnv>): string {
  const configured = (c.env.SIGNUP_FROM_ADDRESS ?? '').trim();
  return configured === '' ? DEFAULT_FROM : configured;
}

/**
 * The public origin the web app is served from. The email link and the post-confirm redirect both use it, so they land
 * on the app and not on the API's own hostname.
 */
export function publicAppUrl(c: Context<AppEnv>): string {
  const configured = (c.env.PUBLIC_APP_URL ?? '').trim();
  return (configured === '' ? new URL(c.req.url).origin : configured).replace(/\/$/, '');
}

function confirmationLink(c: Context<AppEnv>, token: string): string {
  return `${publicAppUrl(c)}/api/auth/signup/confirm?token=${encodeURIComponent(token)}`;
}

function signupCookieAttributes() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: SIGNUP_COOKIE_PATH,
    maxAge: TOKEN_TTL_MS / 1000,
  };
}
