import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { GatewayEnv } from '../src/env';
import { httpEnv, TEST_SECRETS } from './support/bindings';
import { registerAccount } from './support/auth';

interface Forwarded {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
}

/** Stands in for the `GitViseApiContainer` namespace. Records every request it receives. */
function namespaceRecording(seen: Forwarded[]): GatewayEnv['GitViseApiContainer'] {
  return {
    getByName: () => ({
      fetch: async (request: Request): Promise<Response> => {
        seen.push({ method: request.method, url: request.url, headers: request.headers });
        return new Response('{"forwarded":true}', { status: 201, headers: { 'content-type': 'application/json' } });
      },
    }),
  } as unknown as GatewayEnv['GitViseApiContainer'];
}

const ORIGIN = 'https://api.gitvise.com';
const IDENTITY_HEADERS = [
  'x-gitvise-user-id',
  'x-gitvise-org-id',
  'x-gitvise-user-email',
  'x-gitvise-timestamp',
  'x-gitvise-signature',
];

/**
 * The container's verification, written from its canonical format, not from the gateway's helper. If the two
 * sides drift, this check fails.
 */
async function containerSignature(claims: {
  method: string;
  path: string;
  userId: string;
  orgId: string;
  email: string;
  timestamp: string;
}): Promise<string> {
  const canonical = [
    'gitvise-gateway-v2',
    claims.method.toUpperCase(),
    claims.path,
    claims.userId,
    claims.orgId,
    claims.email,
    claims.timestamp,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TEST_SECRETS.INTERNAL_GATEWAY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('a signed-in session reaches apps/api with signed identity', () => {
  it('attaches identity that the container can verify, for the same method and path', async () => {
    const seen: Forwarded[] = [];
    const env = httpEnv({ GitViseApiContainer: namespaceRecording(seen) });
    const account = await registerAccount(env);

    const response = await app.request(
      `${ORIGIN}/api/v1/repositories`,
      { method: 'GET', headers: { cookie: account.cookie } },
      env,
    );

    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
    const headers = seen[0]!.headers;
    expect(headers.get('x-gitvise-user-id')).toBe(account.userId);
    expect(headers.get('x-gitvise-org-id')).toBe(account.orgId);
    expect(headers.get('x-gitvise-user-email')).toBeNull();

    const timestamp = headers.get('x-gitvise-timestamp') ?? '';
    expect(Math.abs(Date.now() - Number(timestamp))).toBeLessThan(60_000);
    const expected = await containerSignature({
      method: 'GET',
      path: '/api/v1/repositories',
      userId: account.userId,
      orgId: account.orgId,
      email: '',
      timestamp,
    });
    expect(headers.get('x-gitvise-signature')).toBe(expected);
  });

  it('removes identity headers a caller sends when it has no session', async () => {
    const seen: Forwarded[] = [];
    await app.request(
      `${ORIGIN}/api/v1/repositories`,
      {
        method: 'GET',
        headers: {
          'x-gitvise-user-id': '11111111-1111-4111-8111-111111111111',
          'x-gitvise-org-id': '22222222-2222-4222-8222-222222222222',
          'x-gitvise-user-email': 'forged@example.test',
          'x-gitvise-timestamp': String(Date.now()),
          'x-gitvise-signature': 'a'.repeat(64),
        },
      },
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );

    expect(seen).toHaveLength(1);
    for (const name of IDENTITY_HEADERS) expect(seen[0]!.headers.get(name)).toBeNull();
  });

  it('replaces identity headers a caller sends with a session identity', async () => {
    const seen: Forwarded[] = [];
    const env = httpEnv({ GitViseApiContainer: namespaceRecording(seen) });
    const account = await registerAccount(env);

    await app.request(
      `${ORIGIN}/api/v1/repositories`,
      {
        method: 'GET',
        headers: { cookie: account.cookie, 'x-gitvise-user-id': '11111111-1111-4111-8111-111111111111' },
      },
      env,
    );

    expect(seen[0]!.headers.get('x-gitvise-user-id')).toBe(account.userId);
    expect(seen[0]!.headers.get('x-gitvise-user-email')).toBeNull();
  });

  it('refuses a cookie write that is not JSON, and forwards nothing', async () => {
    const seen: Forwarded[] = [];
    const env = httpEnv({ GitViseApiContainer: namespaceRecording(seen) });
    const account = await registerAccount(env);

    const response = await app.request(
      `${ORIGIN}/api/v1/repositories`,
      { method: 'POST', headers: { cookie: account.cookie, 'content-type': 'text/plain' }, body: 'name=x' },
      env,
    );

    expect(response.status).toBe(415);
    expect(seen).toHaveLength(0);
  });

  it('forwards an unauthenticated request with no identity, so the container can check its own bearer token', async () => {
    const seen: Forwarded[] = [];
    await app.request(
      `${ORIGIN}/api/v1/repositories`,
      { method: 'GET', headers: { authorization: 'Bearer gspat_example' } },
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer gspat_example');
    for (const name of IDENTITY_HEADERS) expect(seen[0]!.headers.get(name)).toBeNull();
  });
});
