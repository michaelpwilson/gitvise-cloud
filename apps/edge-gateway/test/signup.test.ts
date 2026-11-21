import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { httpEnv, testEnv, uniqueId } from './support/bindings';
import { registerAccount, TEST_PASSWORD } from './support/auth';
import { changeSeats } from '../src/billing/seats';
import type { GatewayEnv } from '../src/env';

/** A sender that records every message, so a test can open the link the email carries. */
class RecordingMailer {
  readonly sent: { to: string; from: string; subject: string; text: string; html: string }[] = [];
  send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown> {
    this.sent.push(message);
    return Promise.resolve({ messageId: uniqueId('msg') });
  }
  /** The token from the most recent confirmation link. */
  lastToken(): string {
    const last = this.sent.at(-1);
    const match = last?.text.match(/\/api\/auth\/signup\/confirm\?token=([^\s]+)/);
    if (match?.[1] === undefined) throw new Error('no confirmation link in the last email');
    return decodeURIComponent(match[1]);
  }
}

function wizardEnv(mailer: RecordingMailer, overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return httpEnv({
    EMAIL: mailer as unknown as GatewayEnv['EMAIL'],
    PUBLIC_APP_URL: 'https://gitvise.test',
    ...overrides,
  });
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://gitvise.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function validDetails(overrides: Record<string, unknown> = {}) {
  const name = uniqueId('user').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    username: name,
    email: `${uniqueId('wizard')}@example.test`,
    password: TEST_PASSWORD,
    termsAccepted: true,
    plan: 'pro',
    seats: 1,
    ...overrides,
  };
}

/** Starts a signup and returns the pending cookie it set. */
async function start(env: GatewayEnv, details: Record<string, unknown>): Promise<{ response: Response; pending: string }> {
  const response = await app.fetch(jsonRequest('/api/auth/signup/start', details), env);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const pending = setCookie.split(';')[0] ?? '';
  return { response, pending };
}

/** Opens the confirmation link, which creates the account and sets the session. */
async function confirm(env: GatewayEnv, token: string): Promise<Response> {
  return app.fetch(new Request(`https://gitvise.test/api/auth/signup/confirm?token=${encodeURIComponent(token)}`, { redirect: 'manual' }), env);
}

function sessionPair(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  if (!pair.startsWith('gv_session=')) throw new Error(`no session cookie: "${header}"`);
  return pair;
}

async function onboarding(env: GatewayEnv, session: string): Promise<{ step: string; plan: string | null; seats: number; passkeys: number; tier: string }> {
  const response = await app.fetch(new Request('https://gitvise.test/api/auth/onboarding', { headers: { cookie: session } }), env);
  expect(response.status).toBe(200);
  return (await response.json()) as { step: string; plan: string | null; seats: number; passkeys: number; tier: string };
}

describe('signup wizard: start', () => {
  it('holds the registration and sends a confirmation email without creating an account yet', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    const { response, pending } = await start(env, details);

    expect(response.status).toBe(202);
    expect(pending.startsWith('gv_signup=sgn-')).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(details.email);
    expect(mailer.sent[0]?.text).toContain('https://gitvise.test/api/auth/signup/confirm?token=');

    const users = await testEnv.D1.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?1').bind(details.email).first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it('stores only the hash of the emailed token', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    await start(env, details);
    const token = mailer.lastToken();
    const row = await testEnv.D1.prepare('SELECT token_hash FROM pending_signups WHERE lower(email) = lower(?1)')
      .bind(details.email)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBeDefined();
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toHaveLength(64);
  });

  it('refuses an email that already has an account', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const existing = await registerAccount(env);
    const { response } = await start(env, validDetails({ email: existing.email }));
    expect(response.status).toBe(409);
    expect(mailer.sent).toHaveLength(0);
  });

  it('refuses a username that another account already uses, in any case', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const first = validDetails();
    const firstStart = await start(env, first);
    expect(firstStart.response.status).toBe(202);
    const token = mailer.lastToken();
    await confirm(env, token);

    const second = validDetails({ username: String(first.username).toUpperCase() });
    const { response } = await start(env, second);
    expect(response.status).toBe(409);
  });

  it('refuses a username that breaks the API rules', async () => {
    const env = wizardEnv(new RecordingMailer());
    for (const username of ['has space', 'ends.git', 'double..dot', '-leading', '']) {
      const { response } = await start(env, validDetails({ username }));
      expect(response.status, username).toBe(400);
    }
  });

  it('refuses a registration without accepted terms', async () => {
    const env = wizardEnv(new RecordingMailer());
    const { response } = await start(env, validDetails({ termsAccepted: false }));
    expect(response.status).toBe(400);
  });

  it('refuses a plan that is not a paid tier, since cloud has no free plan', async () => {
    const env = wizardEnv(new RecordingMailer());
    const { response } = await start(env, validDetails({ plan: 'free' }));
    expect(response.status).toBe(400);
  });

  it('refuses a seat count on Business outside 1 to 10000', async () => {
    const env = wizardEnv(new RecordingMailer());
    expect((await start(env, validDetails({ plan: 'business', seats: 0 }))).response.status).toBe(400);
    expect((await start(env, validDetails({ plan: 'business', seats: 10_001 }))).response.status).toBe(400);
  });

  it('refuses a weak password and a request that is not JSON', async () => {
    const env = wizardEnv(new RecordingMailer());
    expect((await start(env, validDetails({ password: 'short' }))).response.status).toBe(400);
    const plain = await app.fetch(
      new Request('https://gitvise.test/api/auth/signup/start', { method: 'POST', body: 'x=1' }),
      env,
    );
    expect(plain.status).toBe(400);
  });

  it('replaces an earlier pending registration for the same email, so only the newest link works', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    await start(env, details);
    const firstToken = mailer.lastToken();
    await start(env, { ...details, username: uniqueId('again').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) });
    const secondToken = mailer.lastToken();

    const stale = await confirm(env, firstToken);
    expect(stale.headers.get('location')).toContain('confirm=invalid');
    const fresh = await confirm(env, secondToken);
    expect(fresh.status).toBe(303);
    expect(fresh.headers.get('location')).toBe('https://gitvise.test/');
  });

  it('does not send mail, or store anything, when no email sender is bound', async () => {
    const env = httpEnv({ PUBLIC_APP_URL: 'https://gitvise.test' });
    const details = validDetails();
    const { response } = await start(env, details);
    expect(response.status).toBe(502);
    const row = await testEnv.D1.prepare('SELECT COUNT(*) AS n FROM pending_signups WHERE lower(email) = lower(?1)')
      .bind(details.email)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('signup wizard: confirm and status', () => {
  it('confirming creates the owner, marks the email verified, and signs them in', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails({ plan: 'business', seats: 4 });
    await start(env, details);
    const response = await confirm(env, mailer.lastToken());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://gitvise.test/');
    expect(sessionPair(response).startsWith('gv_session=')).toBe(true);

    const row = await testEnv.D1.prepare(
      `SELECT u.role, u.first_name, u.last_name, u.email_verified_at, u.terms_accepted_at, u.plan_choice,
              u.seat_choice, u.passkey_required, o.tier
         FROM users u JOIN organizations o ON o.id = u.org_id
        WHERE lower(u.email) = lower(?1)`,
    )
      .bind(details.email)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      role: 'owner',
      first_name: 'Ada',
      last_name: 'Lovelace',
      plan_choice: 'business',
      seat_choice: 4,
      passkey_required: 1,
      tier: 'none',
    });
    expect(row?.['email_verified_at']).not.toBeNull();
    expect(row?.['terms_accepted_at']).not.toBeNull();

    const pending = await testEnv.D1.prepare('SELECT COUNT(*) AS n FROM pending_signups WHERE lower(email) = lower(?1)')
      .bind(details.email)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);

    // apps/api bills a personal repository through this membership. Without it, cloud chat is refused.
    const membership = await testEnv.D1.prepare(
      `SELECT m.role FROM organization_members m JOIN users u ON u.id = m.user_id AND u.org_id = m.organization_id
        WHERE lower(u.email) = lower(?1)`,
    )
      .bind(details.email)
      .first<{ role: string }>();
    expect(membership?.role).toBe('owner');
  });

  it('an expired link does not create the account', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    await start(env, details);
    await testEnv.D1.prepare("UPDATE pending_signups SET expires_at = 0 WHERE lower(email) = lower(?1)").bind(details.email).run();
    const response = await confirm(env, mailer.lastToken());
    expect(response.headers.get('location')).toContain('confirm=expired');
    const users = await testEnv.D1.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = lower(?1)').bind(details.email).first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it('a made-up token is refused, and so is a token that is too short to be real', async () => {
    const env = wizardEnv(new RecordingMailer());
    expect((await confirm(env, 'x'.repeat(40))).headers.get('location')).toContain('confirm=invalid');
    expect((await confirm(env, 'short')).headers.get('location')).toContain('confirm=invalid');
  });

  it('a link whose email has since been taken by an account is refused', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    await start(env, details);
    const token = mailer.lastToken();
    const orgId = uniqueId('org');
    await testEnv.D1.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?1)').bind(orgId).run();
    await testEnv.D1.prepare(
      "INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?1, ?2, ?3, 'member', 'x')",
    )
      .bind(uniqueId('usr'), orgId, details.email)
      .run();
    const response = await confirm(env, token);
    expect(response.headers.get('location')).toContain('confirm=taken');
  });

  it('status reports the waiting email from the pending cookie, and none without one', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    const { pending } = await start(env, details);
    const waiting = await app.fetch(
      new Request('https://gitvise.test/api/auth/signup/status', { headers: { cookie: pending } }),
      env,
    );
    expect(await waiting.json()).toMatchObject({ status: 'confirm-email', email: details.email, plan: 'pro' });

    const none = await app.fetch(new Request('https://gitvise.test/api/auth/signup/status'), env);
    expect(await none.json()).toEqual({ status: 'none' });
  });

  it('resend is rate limited to one email a minute', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const { pending } = await start(env, validDetails());
    const again = await app.fetch(
      new Request('https://gitvise.test/api/auth/signup/resend', {
        method: 'POST',
        headers: { cookie: pending, 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(again.status).toBe(429);
    expect(again.headers.get('retry-after')).not.toBeNull();
    expect(mailer.sent).toHaveLength(1);
  });

  it('resend after the cooldown sends a fresh link that replaces the old one', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    const { pending } = await start(env, details);
    const oldToken = mailer.lastToken();
    await testEnv.D1.prepare('UPDATE pending_signups SET last_sent_at = 0 WHERE lower(email) = lower(?1)').bind(details.email).run();
    const resent = await app.fetch(
      new Request('https://gitvise.test/api/auth/signup/resend', {
        method: 'POST',
        headers: { cookie: pending, 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(resent.status).toBe(202);
    expect(mailer.sent).toHaveLength(2);
    expect((await confirm(env, oldToken)).headers.get('location')).toContain('confirm=invalid');
    expect((await confirm(env, mailer.lastToken())).status).toBe(303);
  });
});

describe('onboarding after sign-in', () => {
  it('walks a new account through plan, checkout, and passkey, in that order', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails({ plan: 'pro' });
    await start(env, details);
    const session = sessionPair(await confirm(env, mailer.lastToken()));

    // Plan was chosen before confirmation, so the next step is Checkout.
    expect(await onboarding(env, session)).toMatchObject({ step: 'checkout', plan: 'pro' });

    // Starting Checkout and then leaving without paying sends the owner back to the plan picker.
    await testEnv.D1.prepare('UPDATE users SET checkout_started_at = ?1 WHERE lower(email) = lower(?2)')
      .bind(Date.now(), details.email)
      .run();
    expect((await onboarding(env, session)).step).toBe('plan');

    // Choosing again moves on to Checkout for the new choice.
    const chosen = await app.fetch(
      jsonRequest('/api/auth/onboarding/plan', { plan: 'enterprise', seats: 2 }, { cookie: session }),
      env,
    );
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toMatchObject({ step: 'checkout', plan: 'enterprise', seats: 2 });

    // Paid, but no passkey yet.
    await testEnv.D1.prepare("UPDATE organizations SET tier = 'enterprise' WHERE id = (SELECT org_id FROM users WHERE lower(email) = lower(?1))")
      .bind(details.email)
      .run();
    expect((await onboarding(env, session)).step).toBe('passkey');

    // A registered passkey finishes onboarding.
    await testEnv.D1.prepare(
      "UPDATE users SET webauthn_credentials = '[{\"id\":\"cred-1\",\"publicKey\":\"k\",\"counter\":0,\"transports\":[],\"deviceType\":\"singleDevice\",\"backedUp\":false}]' WHERE lower(email) = lower(?1)",
    )
      .bind(details.email)
      .run();
    expect(await onboarding(env, session)).toMatchObject({ step: 'done', passkeys: 1 });
  });

  it('refuses a plan choice once the organisation already has a plan', async () => {
    const mailer = new RecordingMailer();
    const env = wizardEnv(mailer);
    const details = validDetails();
    await start(env, details);
    const session = sessionPair(await confirm(env, mailer.lastToken()));
    await testEnv.D1.prepare("UPDATE organizations SET tier = 'pro' WHERE id = (SELECT org_id FROM users WHERE lower(email) = lower(?1))")
      .bind(details.email)
      .run();
    const response = await app.fetch(jsonRequest('/api/auth/onboarding/plan', { plan: 'business', seats: 1 }, { cookie: session }), env);
    expect(response.status).toBe(409);
  });

  it('refuses a plan choice without a session, and a plan that is not paid', async () => {
    const env = wizardEnv(new RecordingMailer());
    const anonymous = await app.fetch(jsonRequest('/api/auth/onboarding/plan', { plan: 'pro' }), env);
    expect(anonymous.status).toBe(401);
    const mailer = new RecordingMailer();
    const wizardEnvWithMail = wizardEnv(mailer);
    const details = validDetails();
    await start(wizardEnvWithMail, details);
    const session = sessionPair(await confirm(wizardEnvWithMail, mailer.lastToken()));
    const free = await app.fetch(jsonRequest('/api/auth/onboarding/plan', { plan: 'free' }, { cookie: session }), wizardEnvWithMail);
    expect(free.status).toBe(400);
  });

  it('existing accounts from before the wizard are never asked for a plan or a passkey', async () => {
    const env = wizardEnv(new RecordingMailer());
    const legacy = await registerAccount(env);
    const state = await onboarding(env, legacy.cookie);
    expect(state.step).toBe('done');
  });
});

describe('seat changes', () => {
  it('refuses a seat change without a Stripe key, before anything is changed', async () => {
    const env = httpEnv();
    const account = await registerAccount(env);
    const response = await app.fetch(jsonRequest('/api/billing/seats', { seats: 3 }, { cookie: account.cookie }), env);
    expect(response.status).toBe(503);
  });

  it('refuses a seat change with no active subscription', async () => {
    const orgId = uniqueId('org');
    await testEnv.D1.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?1)').bind(orgId).run();
    await expect(
      changeSeats({ db: testEnv.D1, secretKey: 'sk_test', orgId, seats: 3 }, (() => {
        throw new Error('Stripe must not be called');
      }) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a seat change on Pro, which has a fixed single seat', async () => {
    const orgId = uniqueId('org');
    const subId = uniqueId('sub');
    await testEnv.D1.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?1)').bind(orgId).run();
    await testEnv.D1.prepare("INSERT INTO subscriptions (id, org_id, tier, seats, status) VALUES (?1, ?2, 'pro', 1, 'active')")
      .bind(subId, orgId)
      .run();
    await expect(
      changeSeats({ db: testEnv.D1, secretKey: 'sk_test', orgId, seats: 3 }, (() => {
        throw new Error('Stripe must not be called');
      }) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('updates Stripe first, then mirrors the new seat count locally', async () => {
    const orgId = uniqueId('org');
    const subId = uniqueId('sub');
    await testEnv.D1.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?1)').bind(orgId).run();
    await testEnv.D1.prepare("INSERT INTO subscriptions (id, org_id, tier, seats, status) VALUES (?1, ?2, 'business', 1, 'active')")
      .bind(subId, orgId)
      .run();

    const calls: { method: string; url: string; body: string | null }[] = [];
    const fakeStripe = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null });
      if (init?.method === 'POST') return new Response('{"id":"sub"}', { status: 200 });
      return new Response(JSON.stringify({ id: subId, items: { data: [{ id: 'si_1' }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await changeSeats({ db: testEnv.D1, secretKey: 'sk_test', orgId, seats: 4 }, fakeStripe);
    expect(result).toEqual({ seats: 4 });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1]?.body).toContain('items%5B0%5D%5Bquantity%5D=4');
    expect(calls[1]?.body).toContain('items%5B0%5D%5Bid%5D=si_1');

    const sub = await testEnv.D1.prepare('SELECT seats FROM subscriptions WHERE id = ?1').bind(subId).first<{ seats: number }>();
    const org = await testEnv.D1.prepare('SELECT seats FROM organizations WHERE id = ?1').bind(orgId).first<{ seats: number }>();
    expect(sub?.seats).toBe(4);
    expect(org?.seats).toBe(4);
  });

  it('leaves the local seat count alone when Stripe refuses the change', async () => {
    const orgId = uniqueId('org');
    const subId = uniqueId('sub');
    await testEnv.D1.prepare('INSERT INTO organizations (id, name, seats) VALUES (?1, ?1, 2)').bind(orgId).run();
    await testEnv.D1.prepare("INSERT INTO subscriptions (id, org_id, tier, seats, status) VALUES (?1, ?2, 'business', 2, 'active')")
      .bind(subId, orgId)
      .run();
    const failing = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('{"error":"card declined"}', { status: 402 });
      return new Response(JSON.stringify({ id: subId, items: { data: [{ id: 'si_1' }] } }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(changeSeats({ db: testEnv.D1, secretKey: 'sk_test', orgId, seats: 9 }, failing)).rejects.toMatchObject({
      code: 'UPSTREAM_FAILURE',
    });
    const sub = await testEnv.D1.prepare('SELECT seats FROM subscriptions WHERE id = ?1').bind(subId).first<{ seats: number }>();
    expect(sub?.seats).toBe(2);
  });
});
