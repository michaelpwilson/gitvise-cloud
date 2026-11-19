import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { sha256Hex, signToken } from '../src/crypto';
import { SESSION_COOKIE } from '../src/auth/principal';
import type { GatewayEnv } from '../src/env';
import { httpEnv, testEnv, TEST_SECRETS, uniqueId } from './support/bindings';
import { addMember, bearer, mintKey, registerAccount, TEST_PASSWORD, type Account } from './support/auth';
import { recordGrant } from '../src/billing/ledger';

const env: GatewayEnv = httpEnv();

/** Credits an org's live balance through the guard, and mirrors it to the ledger the way the webhook does. */
async function grantTopup(orgId: string, amountPence: number): Promise<void> {
  const result = await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: uniqueId('grant'), bucket: 'topup', amountPence });
  await recordGrant(testEnv.D1, orgId, 'topup_purchase', uniqueId('ref'), result);
}

async function inference(key: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    '/v1/inference/fast-3b',
    {
      method: 'POST',
      headers: { ...bearer(key), 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: uniqueId('req'), messages: [{ role: 'user', content: 'hi' }], ...body }),
    },
    env,
  );
}

describe('multi-tenant isolation', () => {
  it('an API key for Org A cannot read or spend Org B credits', async () => {
    const orgA = await registerAccount(env);
    const orgB = await registerAccount(env);
    const keyA = await mintKey(env, orgA);
    await grantTopup(orgB.orgId, 1_000);

    // A has no credit of its own. Naming B in the body must not borrow B's balance.
    const spend = await inference(keyA.key, { orgId: orgB.orgId, userId: 'anyone' });
    expect(spend.status).toBe(402);
    const refusal = (await spend.json()) as { error: { code: string } };
    expect(refusal.error.code).toBe('CREDITS_EXHAUSTED');

    const bAfter = await testEnv.BILLING_GUARD.getByName(orgB.orgId).status();
    expect(bAfter).toMatchObject({ topupPence: 1_000, heldPence: 0, availablePence: 1_000 });
    const usage = await testEnv.D1.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE org_id = ?1').bind(orgB.orgId).first<{ n: number }>();
    expect(usage?.n).toBe(0);
  });

  it('an API key for Org A reads only Org A billing, whatever org it asks for', async () => {
    const orgA = await registerAccount(env);
    const orgB = await registerAccount(env);
    await grantTopup(orgB.orgId, 700);
    const keyA = await mintKey(env, orgA);

    const response = await app.request(`/api/billing/status?orgId=${orgB.orgId}`, { headers: bearer(keyA.key) }, env);
    const body = (await response.json()) as { orgId: string; balancePence: { topup: number } };
    expect(body.orgId).toBe(orgA.orgId);
    expect(body.balancePence.topup).toBe(0);
  });

  it('a lease owned by Org B is invisible to Org A: it is refused as not found and left alone', async () => {
    const orgA = await registerAccount(env);
    const orgB = await registerAccount(env);
    const keyA = await mintKey(env, orgA);
    const leaseId = crypto.randomUUID();
    await testEnv.D1.prepare('INSERT INTO sandbox_leases (lease_id, org_id) VALUES (?1, ?2)').bind(leaseId, orgB.orgId).run();

    const attempt = await app.request(`/v1/sandbox/leases/${leaseId}`, { method: 'DELETE', headers: bearer(keyA.key) }, env);
    expect(attempt.status).toBe(404);

    const row = await testEnv.D1.prepare('SELECT org_id FROM sandbox_leases WHERE lease_id = ?1').bind(leaseId).first<{ org_id: string }>();
    expect(row?.org_id).toBe(orgB.orgId);
  });

  it('a repo name is scoped to the caller: two orgs can both name a repo "app" without sharing it', async () => {
    const orgA = await registerAccount(env);
    const orgB = await registerAccount(env);
    const keyA = await mintKey(env, orgA);

    const bytes = new TextEncoder().encode(`pack-${crypto.randomUUID()}`);
    const sha = await sha256Hex(bytes);
    const commit = 'a'.repeat(40);
    const upload = await app.request(
      `/v1/blobs/packfile/${sha}`,
      { method: 'PUT', headers: { ...bearer(keyA.key), 'content-length': String(bytes.byteLength), 'x-gitvise-encoding': 'identity' }, body: bytes },
      env,
    );
    expect(upload.status).toBe(201);

    const record = await app.request(
      `/v1/repos/app/commits/${commit}/snapshot`,
      { method: 'PUT', headers: { ...bearer(keyA.key), 'content-type': 'application/json' }, body: JSON.stringify({ sha256: sha }) },
      env,
    );
    expect(record.status).toBe(201);

    const stored = await testEnv.D1.prepare('SELECT repo_id FROM commit_snapshots WHERE commit_hash = ?1').bind(commit).all<{ repo_id: string }>();
    expect(stored.results.map((row) => row.repo_id)).toEqual([`${orgA.orgId}:app`]);

    // B's scope for the same name holds nothing.
    const fromB = await testEnv.D1.prepare('SELECT blob_sha256 FROM commit_snapshots WHERE repo_id = ?1').bind(`${orgB.orgId}:app`).first();
    expect(fromB).toBeNull();
  });
});

describe('sign-up, sign-in, and sessions', () => {
  it('register creates a personal org, makes the user its owner, and sets a session cookie', async () => {
    const account = await registerAccount(env);
    expect(account.orgId).toMatch(/^org-[0-9a-f]{16}$/);
    const row = await testEnv.D1.prepare('SELECT org_id, role, password_hash FROM users WHERE id = ?1')
      .bind(account.userId)
      .first<{ org_id: string; role: string; password_hash: string }>();
    expect(row?.org_id).toBe(account.orgId);
    expect(row?.role).toBe('owner');
    // The password is stored as a PBKDF2 hash, never in plain text.
    expect(row?.password_hash.startsWith('pbkdf2-sha256$100000$')).toBe(true);
    expect(row?.password_hash).not.toContain(TEST_PASSWORD);
  });

  it('refuses a duplicate email, a short password, and a malformed email', async () => {
    const account = await registerAccount(env);
    const duplicate = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: TEST_PASSWORD }) },
      env,
    );
    expect(duplicate.status).toBe(409);

    const weak = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.test', password: 'short' }) },
      env,
    );
    expect(weak.status).toBe(400);

    const malformed = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email', password: TEST_PASSWORD }) },
      env,
    );
    expect(malformed.status).toBe(400);
  });

  it('login accepts the right password and refuses a wrong one or an unknown email with the same response', async () => {
    const account = await registerAccount(env);
    const post = (body: unknown) =>
      app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

    const good = await post({ email: account.email, password: TEST_PASSWORD });
    expect(good.status).toBe(200);
    expect(good.headers.get('set-cookie')).toContain('HttpOnly');

    const wrong = await post({ email: account.email, password: 'definitely the wrong password' });
    const unknown = await post({ email: `nobody-${crypto.randomUUID()}@example.test`, password: TEST_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('a session cookie is accepted, and a forged, expired, or wrongly-signed one is not', async () => {
    const account = await registerAccount(env);
    const valid = await app.request('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie: account.cookie }, body: '{}' }, env);
    expect(valid.status).toBe(201);

    const forged = await signToken({ sub: account.userId, org: account.orgId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, 'not-the-secret');
    const expired = await signToken({ sub: account.userId, org: account.orgId, role: 'owner', exp: 1 }, TEST_SECRETS.SESSION_SECRET);
    for (const token of [forged, expired]) {
      const response = await app.request('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` }, body: '{}' }, env);
      expect(response.status).toBe(401);
    }
  });

  it('a session write must be JSON, which closes the cross-site form path', async () => {
    const account = await registerAccount(env);
    const formPost = await app.request(
      '/api/keys',
      { method: 'POST', headers: { cookie: account.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' },
      env,
    );
    expect(formPost.status).toBe(415);
  });

  it('with no session secret configured, sign-up refuses and sessions are never accepted', async () => {
    const account = await registerAccount(env);
    const unconfigured = httpEnv({ SESSION_SECRET: undefined });
    const signup = await app.request(
      '/api/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: TEST_PASSWORD }) },
      unconfigured,
    );
    expect(signup.status).toBe(503);

    // A cookie that verifies under the real secret is still refused when the secret is unset.
    const cookieResponse = await app.request('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie: account.cookie }, body: '{}' }, unconfigured);
    expect(cookieResponse.status).toBe(401);
  });
});

describe('API keys', () => {
  it('a minted key is returned once, and only its SHA-256 digest is stored', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account, 'laptop');
    expect(key.key.startsWith('gv_live_')).toBe(true);

    const row = await testEnv.D1.prepare('SELECT key_hash, org_id, user_id, role FROM api_keys WHERE id = ?1')
      .bind(key.id)
      .first<{ key_hash: string; org_id: string; user_id: string; role: string }>();
    expect(row).toEqual({ key_hash: await sha256Hex(key.key), org_id: account.orgId, user_id: account.userId, role: 'owner' });
    expect(JSON.stringify(row)).not.toContain(key.key);
  });

  it('an API key cannot mint another key, so a leaked key cannot widen its own access', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account);
    const response = await app.request(
      '/api/keys',
      { method: 'POST', headers: { ...bearer(key.key), 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(response.status).toBe(401);
  });

  it('a revoked key stops working at once, even while it is cached', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account);
    expect((await app.request('/api/billing/status', { headers: bearer(key.key) }, env)).status).toBe(200);

    const revoke = await app.request(`/api/keys/${key.id}`, { method: 'DELETE', headers: { cookie: account.cookie } }, env);
    expect(revoke.status).toBe(204);
    expect((await app.request('/api/billing/status', { headers: bearer(key.key) }, env)).status).toBe(401);
  });

  it('a user cannot revoke another user’s key, and gets the same answer as for a missing key', async () => {
    const owner = await registerAccount(env);
    const other = await registerAccount(env);
    const ownerKey = await mintKey(env, owner);

    const foreign = await app.request(`/api/keys/${ownerKey.id}`, { method: 'DELETE', headers: { cookie: other.cookie } }, env);
    const missing = await app.request(`/api/keys/key-missing`, { method: 'DELETE', headers: { cookie: other.cookie } }, env);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await app.request('/api/billing/status', { headers: bearer(ownerKey.key) }, env)).status).toBe(200);
  });

  it('a member’s key carries the member role, not the owner role', async () => {
    const owner = await registerAccount(env);
    const member: Account = await addMember(env, owner);
    const key = await mintKey(env, member);
    const row = await testEnv.D1.prepare('SELECT role FROM api_keys WHERE id = ?1').bind(key.id).first<{ role: string }>();
    expect(row?.role).toBe('member');
  });
});

describe('the operator token', () => {
  it('is refused on every tenant route', async () => {
    const operator = bearer(TEST_SECRETS.GATEWAY_API_TOKEN);
    expect((await app.request('/api/billing/status', { headers: operator }, env)).status).toBe(401);
    expect((await app.request('/v1/memory/search', { method: 'POST', headers: { ...operator, 'content-type': 'application/json' }, body: '{}' }, env)).status).toBe(401);
    expect((await app.request('/api/keys', { method: 'POST', headers: { ...operator, 'content-type': 'application/json' }, body: '{}' }, env)).status).toBe(401);
  });

  it('works on the operator route, and is refused when no token is configured', async () => {
    const reconcile = (overrides: Partial<GatewayEnv>, token?: string) =>
      app.request(
        '/api/admin/reconcile',
        { method: 'POST', headers: { ...(token === undefined ? {} : bearer(token)), 'content-type': 'application/json' }, body: JSON.stringify({ orgIds: [] }) },
        httpEnv(overrides),
      );
    expect((await reconcile({}, TEST_SECRETS.GATEWAY_API_TOKEN)).status).toBe(200);
    expect((await reconcile({}, 'wrong')).status).toBe(401);
    expect((await reconcile({ GATEWAY_API_TOKEN: undefined })).status).toBe(503);
  });
});
