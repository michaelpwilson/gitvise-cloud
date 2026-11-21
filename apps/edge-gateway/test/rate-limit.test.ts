import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { GatewayEnv } from '../src/env';
import { httpEnv } from './support/bindings';

const ORIGIN = 'https://api.gitvise.com';

/** Records every key the limiter is asked about, and answers with the given verdict. */
function limiter(success: boolean): { keys: string[]; binding: NonNullable<GatewayEnv['API_RATE_LIMIT']> } {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success };
      },
    } as unknown as NonNullable<GatewayEnv['API_RATE_LIMIT']>,
  };
}

/** Stands in for the apps/api container, so a forwarded request is observable as a 201. */
const container = {
  getByName: () => ({ fetch: async () => new Response('{"forwarded":true}', { status: 201 }) }),
} as unknown as GatewayEnv['GitViseApiContainer'];

describe('edge rate limit on requests forwarded to apps/api', () => {
  it('forwards a signed-out request, keyed by client IP, when the limit allows it', async () => {
    const limit = limiter(true);
    const response = await app.request(
      `${ORIGIN}/api/v1/repositories`,
      { method: 'GET', headers: { 'cf-connecting-ip': '203.0.113.7' } },
      httpEnv({ GitViseApiContainer: container, API_RATE_LIMIT: limit.binding }),
    );

    expect(response.status).toBe(201);
    expect(limit.keys).toEqual(['ip:203.0.113.7']);
  });

  it('answers 429 and does not forward when the caller is over the limit', async () => {
    const limit = limiter(false);
    const response = await app.request(
      `${ORIGIN}/api/v1/repositories`,
      { method: 'GET', headers: { 'cf-connecting-ip': '203.0.113.7' } },
      httpEnv({ GitViseApiContainer: container, API_RATE_LIMIT: limit.binding }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('forwards without a limit check when the binding is not configured', async () => {
    const response = await app.request(
      `${ORIGIN}/api/v1/repositories`,
      { method: 'GET' },
      httpEnv({ GitViseApiContainer: container, API_RATE_LIMIT: undefined }),
    );
    expect(response.status).toBe(201);
  });
});
