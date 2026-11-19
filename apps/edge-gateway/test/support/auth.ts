import { app } from '../../src/app';
import type { GatewayEnv } from '../../src/env';
import { hashPassword } from '../../src/crypto';

/** Password that passes the policy. Shared by tests; it protects nothing real. */
export const TEST_PASSWORD = 'correct horse battery staple';

export interface Account {
  readonly email: string;
  readonly orgId: string;
  readonly userId: string;
  /** The `gv_session=...` pair from Set-Cookie, ready to send as a Cookie header. */
  readonly cookie: string;
}

/** Signs up a fresh account through the real route. Each call creates its own personal org. */
export async function registerAccount(env: GatewayEnv, email = `${crypto.randomUUID()}@example.test`): Promise<Account> {
  const response = await app.request(
    '/api/auth/register',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: TEST_PASSWORD }) },
    env,
  );
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { orgId: string; userId: string };
  return { email, orgId: body.orgId, userId: body.userId, cookie: sessionCookie(response) };
}

/**
 * Adds a `member` to an existing org and signs them in through the real login route. The row is written directly,
 * since there is no invite flow yet. The session role is taken from the row at sign-in, as it would be in production.
 */
export async function addMember(env: GatewayEnv, owner: Account): Promise<Account> {
  const email = `${crypto.randomUUID()}@example.test`;
  const userId = `usr-${crypto.randomUUID().slice(0, 8)}`;
  await env.D1.prepare("INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?1, ?2, ?3, 'member', ?4)")
    .bind(userId, owner.orgId, email, await hashPassword(TEST_PASSWORD))
    .run();
  const response = await app.request(
    '/api/auth/login',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: TEST_PASSWORD }) },
    env,
  );
  if (response.status !== 200) throw new Error(`member login failed: ${response.status}`);
  return { email, orgId: owner.orgId, userId, cookie: sessionCookie(response) };
}

/** Mints an API key through the real route. Requires a session, so the account must sign in first. */
export async function mintKey(env: GatewayEnv, account: Account, name = 'test'): Promise<{ id: string; key: string }> {
  const response = await app.request(
    '/api/keys',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: account.cookie },
      body: JSON.stringify({ name }),
    },
    env,
  );
  if (response.status !== 201) throw new Error(`mint failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { id: string; key: string };
}

/** Pulls `gv_session=<token>` out of a response's Set-Cookie header. */
export function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const pair = header.split(';')[0] ?? '';
  if (!pair.startsWith('gv_session=')) throw new Error(`no session cookie in response: "${header}"`);
  return pair;
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
