import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { sha256Hex, signToken, verifyToken } from '../src/crypto';
import { SESSION_COOKIE } from '../src/auth/principal';
import { pruneExpiredSessions } from '../src/auth/sessions';
import type { GatewayEnv } from '../src/env';
import { httpEnv, testEnv, TEST_SECRETS, uniqueId } from './support/bindings';
import { addMember, bearer, mintKey, registerAccount, sessionCookie, type Account } from './support/auth';

const env: GatewayEnv = httpEnv();

/** One entry of `GET /api/keys`. */
interface KeyListing {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

async function getJson(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request(path, { headers }, env);
}

async function postKey(account: Account, name: string): Promise<Response> {
  return await app.request(
    '/api/keys',
    { method: 'POST', headers: { 'content-type': 'application/json', cookie: account.cookie }, body: JSON.stringify({ name }) },
    env,
  );
}

async function listKeys(account: Account): Promise<KeyListing[]> {
  const response = await getJson('/api/keys', { cookie: account.cookie });
  return ((await response.json()) as { keys: KeyListing[] }).keys;
}

describe('GET /api/auth/me', () => {
  it('returns the caller for a session cookie: user, org, email, and role', async () => {
    const account = await registerAccount(env);
    const response = await getJson('/api/auth/me', { cookie: account.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      userId: account.userId,
      orgId: account.orgId,
      email: account.email,
      role: 'owner',
    });
  });

  it('returns the same identity for an API key, with the role the key was minted with', async () => {
    const owner = await registerAccount(env);
    const key = await mintKey(env, owner);
    const response = await getJson('/api/auth/me', bearer(key.key));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: owner.userId, orgId: owner.orgId, email: owner.email, role: 'owner' });
  });

  it('reports a member as member, not owner', async () => {
    const owner = await registerAccount(env);
    const member = await addMember(env, owner);
    const response = await getJson('/api/auth/me', { cookie: member.cookie });

    expect(await response.json()).toEqual({ userId: member.userId, orgId: owner.orgId, email: member.email, role: 'member' });
  });

  it('refuses no credentials, a forged or wrongly-signed cookie, and the operator token', async () => {
    const account = await registerAccount(env);
    const forged = await signToken(
      { sub: account.userId, org: account.orgId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 },
      'not-the-secret',
    );

    const anonymous = await getJson('/api/auth/me');
    const wrongSecret = await getJson('/api/auth/me', { cookie: `${SESSION_COOKIE}=${forged}` });
    const operator = await getJson('/api/auth/me', bearer(TEST_SECRETS.GATEWAY_API_TOKEN));

    for (const response of [anonymous, wrongSecret, operator]) {
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    }
  });

  it('refuses a valid session whose user row no longer exists', async () => {
    const account = await registerAccount(env);
    await testEnv.D1.prepare('DELETE FROM users WHERE id = ?1').bind(account.userId).run();

    const response = await getJson('/api/auth/me', { cookie: account.cookie });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/keys', () => {
  it('lists the caller’s active keys with exactly id, name, prefix, createdAt, and lastUsedAt', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account, 'laptop');
    const response = await getJson('/api/keys', { cookie: account.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const keys = await listKeys(account);
    expect(keys).toHaveLength(1);

    const [listed] = keys;
    expect(Object.keys(listed ?? {}).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name', 'prefix']);
    expect(listed).toMatchObject({ id: key.id, name: 'laptop', lastUsedAt: null });
    expect(Number.isNaN(Date.parse(listed?.createdAt ?? ''))).toBe(false);
  });

  it('shows a non-secret prefix that starts the real key, and never the secret or its digest', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account);
    const response = await getJson('/api/keys', { cookie: account.cookie });
    const text = await response.text();
    const listed = (JSON.parse(text) as { keys: KeyListing[] }).keys.find((entry) => entry.id === key.id);

    expect(listed?.prefix).toBe(key.key.slice(0, 16));
    expect(key.key.startsWith(listed?.prefix ?? '')).toBe(true);
    expect(text).not.toContain(key.key);
    expect(text).not.toContain(await sha256Hex(key.key));
    expect(text).not.toContain('key_hash');
  });

  it('omits revoked keys, and never shows another user’s keys', async () => {
    const owner = await registerAccount(env);
    const other = await registerAccount(env);
    const revoked = await mintKey(env, owner, 'old');
    const kept = await mintKey(env, owner, 'current');
    const foreign = await mintKey(env, other, 'theirs');

    const revoke = await app.request(`/api/keys/${revoked.id}`, { method: 'DELETE', headers: { cookie: owner.cookie } }, env);
    expect(revoke.status).toBe(204);

    expect((await listKeys(owner)).map((entry) => entry.id)).toEqual([kept.id]);
    expect((await listKeys(other)).map((entry) => entry.id)).toEqual([foreign.id]);
  });

  it('reports lastUsedAt as null until a key authenticates a request, then as that request’s time', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account);
    const lastUsed = async (): Promise<string | null | undefined> => (await listKeys(account)).find((entry) => entry.id === key.id)?.lastUsedAt;

    expect(await lastUsed()).toBeNull();

    // First use is a key-cache miss, so it is recorded.
    expect((await getJson('/api/billing/status', bearer(key.key))).status).toBe(200);
    const recorded = await lastUsed();
    expect(typeof recorded).toBe('string');
    expect(Math.abs(Date.parse(recorded ?? '') - Date.now())).toBeLessThan(60_000);
  });

  it('refuses an anonymous caller', async () => {
    expect((await getJson('/api/keys')).status).toBe(401);
  });

  it('returns the prefix and timestamps from POST /api/keys, matching the list entry', async () => {
    const account = await registerAccount(env);
    const created = await postKey(account, 'ci');
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; key: string; prefix: string; createdAt: string; lastUsedAt: null };

    expect(body.prefix).toBe(body.key.slice(0, 16));
    expect(body.lastUsedAt).toBeNull();

    const listed = (await listKeys(account)).find((entry) => entry.id === body.id);
    expect(listed).toMatchObject({ prefix: body.prefix, createdAt: body.createdAt });
  });
});

describe('POST /api/auth/logout', () => {
  it('returns 204 and clears the session cookie with the same attributes the login cookie used', async () => {
    const account = await registerAccount(env);
    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: account.cookie } }, env);

    expect(logout.status).toBe(204);
    const cleared = logout.headers.get('set-cookie') ?? '';
    expect(cleared.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('SameSite=Lax');
  });

  it('uses the same name, path, and attributes as the login cookie, so the browser replaces it', async () => {
    const account = await registerAccount(env);
    const login = await app.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: 'correct horse battery staple' }) },
      env,
    );
    const loginCookie = login.headers.get('set-cookie') ?? '';
    expect(sessionCookie(login)).toMatch(/^gv_session=/);

    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: account.cookie } }, env);
    const clearCookie = logout.headers.get('set-cookie') ?? '';
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
      expect(loginCookie).toContain(attribute);
      expect(clearCookie).toContain(attribute);
    }
  });

  it('succeeds without a session or with an API key, so a stale browser can always sign out', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account);

    const anonymous = await app.request('/api/auth/logout', { method: 'POST' }, env);
    const withKey = await app.request('/api/auth/logout', { method: 'POST', headers: bearer(key.key) }, env);
    expect(anonymous.status).toBe(204);
    expect(withKey.status).toBe(204);
    expect(anonymous.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

/** The signed token inside a `gv_session=<token>` cookie pair. */
function tokenOf(cookie: string): string {
  return cookie.slice(`${SESSION_COOKIE}=`.length);
}

async function sessionRow(sid: string): Promise<{ revoked_at: number | null } | null> {
  return testEnv.D1.prepare('SELECT revoked_at FROM sessions WHERE id = ?1').bind(sid).first<{ revoked_at: number | null }>();
}

describe('server-side sessions', () => {
  it('logout revokes the session, so the same cookie is refused at once, even though its signature still checks out', async () => {
    const account = await registerAccount(env);
    expect((await getJson('/api/auth/me', { cookie: account.cookie })).status).toBe(200);

    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: account.cookie } }, env);
    expect(logout.status).toBe(204);

    // The browser drops the cookie, but a copied token must be refused too.
    expect((await getJson('/api/auth/me', { cookie: account.cookie })).status).toBe(401);
    expect((await getJson('/api/keys', { cookie: account.cookie })).status).toBe(401);
    const sid = (await verifyToken<{ sid: string }>(tokenOf(account.cookie), TEST_SECRETS.SESSION_SECRET))?.sid ?? '';
    expect((await sessionRow(sid))?.revoked_at).not.toBeNull();
  });

  it('a logged-out session does not affect the same user’s other sessions', async () => {
    const account = await registerAccount(env);
    const login = await app.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: account.email, password: 'correct horse battery staple' }) },
      env,
    );
    const second = sessionCookie(login);

    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: account.cookie } }, env);
    expect((await getJson('/api/auth/me', { cookie: account.cookie })).status).toBe(401);
    expect((await getJson('/api/auth/me', { cookie: second })).status).toBe(200);
  });

  it('a stranger cannot sign someone else out: logout only revokes a correctly signed session', async () => {
    const victim = await registerAccount(env);
    const victimSid = (await verifyToken<{ sid: string }>(tokenOf(victim.cookie), TEST_SECRETS.SESSION_SECRET))?.sid ?? '';
    const forged = await signToken({ sid: victimSid, sub: victim.userId, org: victim.orgId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, 'not-the-secret');

    const attempt = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${forged}` } }, env);
    expect(attempt.status).toBe(204);
    expect((await getJson('/api/auth/me', { cookie: victim.cookie })).status).toBe(200);
  });

  it('refuses a correctly signed token whose session row was never issued (tokens minted before sessions existed)', async () => {
    const account = await registerAccount(env);
    const legacy = await signToken({ sub: account.userId, org: account.orgId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, TEST_SECRETS.SESSION_SECRET);
    const unknown = await signToken({ sid: 'ses-never-issued', sub: account.userId, org: account.orgId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, TEST_SECRETS.SESSION_SECRET);

    for (const token of [legacy, unknown]) {
      expect((await getJson('/api/auth/me', { cookie: `${SESSION_COOKIE}=${token}` })).status).toBe(401);
    }
  });

  it('refuses a session whose row has expired, even when the token itself has not', async () => {
    const account = await registerAccount(env);
    const sid = uniqueId('ses');
    await testEnv.D1.prepare('INSERT INTO sessions (id, user_id, org_id, role, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(sid, account.userId, account.orgId, 'owner', Math.floor(Date.now() / 1000) - 10)
      .run();
    const token = await signToken({ sid, sub: account.userId, org: account.orgId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, TEST_SECRETS.SESSION_SECRET);

    expect((await getJson('/api/auth/me', { cookie: `${SESSION_COOKIE}=${token}` })).status).toBe(401);
  });

  it('pruning deletes expired session rows and keeps live ones', async () => {
    const account = await registerAccount(env);
    const liveSid = (await verifyToken<{ sid: string }>(tokenOf(account.cookie), TEST_SECRETS.SESSION_SECRET))?.sid ?? '';
    const expiredSid = uniqueId('ses');
    await testEnv.D1.prepare('INSERT INTO sessions (id, user_id, org_id, role, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(expiredSid, account.userId, account.orgId, 'owner', 1)
      .run();

    await pruneExpiredSessions(testEnv.D1);

    expect(await sessionRow(expiredSid)).toBeNull();
    expect(await sessionRow(liveSid)).not.toBeNull();
    expect((await getJson('/api/auth/me', { cookie: account.cookie })).status).toBe(200);
  });
});
