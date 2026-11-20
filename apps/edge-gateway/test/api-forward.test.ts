import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { API_CONTAINER_INSTANCE } from '../src/api-container';
import type { GatewayEnv } from '../src/env';
import { httpEnv } from './support/bindings';

interface Forwarded {
  readonly instance: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/** Stands in for the `GitViseApiContainer` namespace. Records every request it receives, then answers 201. */
function namespaceRecording(seen: Forwarded[]): GatewayEnv['GitViseApiContainer'] {
  return {
    getByName: (name: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        seen.push({ instance: name, method: request.method, url: request.url, headers: request.headers, body: await request.text() });
        return new Response('{"forwarded":true}', { status: 201, headers: { 'content-type': 'application/json', 'x-from': 'api' } });
      },
    }),
  } as unknown as GatewayEnv['GitViseApiContainer'];
}

const ORIGIN = 'https://api.gitvise.com';

describe('apps/api is the fallback for paths the gateway does not own', () => {
  it('forwards an issue write to the one container instance, with its body and original path', async () => {
    const seen: Forwarded[] = [];
    const response = await app.request(
      `${ORIGIN}/api/v1/repositories/r1/issues?state=open`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":"bug"}' },
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('x-from')).toBe('api');
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call?.instance).toBe(API_CONTAINER_INSTANCE);
    expect(call?.method).toBe('POST');
    expect(new URL(call!.url).pathname + new URL(call!.url).search).toBe('/api/v1/repositories/r1/issues?state=open');
    expect(call?.body).toBe('{"title":"bug"}');
    expect(call?.headers.get('x-forwarded-host')).toBe('api.gitvise.com');
    expect(call?.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('forwards Git smart HTTP paths, which sit at the root rather than under /api', async () => {
    const seen: Forwarded[] = [];
    const response = await app.request(
      `${ORIGIN}/owner/repo.git/info/refs?service=git-upload-pack`,
      { method: 'GET' },
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );
    expect(response.status).toBe(201);
    expect(new URL(seen[0]!.url).pathname).toBe('/owner/repo.git/info/refs');
  });

  it('never forwards /internal, which is the gateway-facing surface', async () => {
    const seen: Forwarded[] = [];
    const response = await app.request(
      `${ORIGIN}/internal/not-a-route`,
      { method: 'POST', body: '{}' },
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );
    // The internal signature check answers first (401), so an unsigned caller learns nothing about routes here.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(0);
  });

  it('never forwards operator paths under /api/admin', async () => {
    const seen: Forwarded[] = [];
    const response = await app.request(
      `${ORIGIN}/api/admin/anything`,
      { method: 'POST', body: '{}' },
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(0);
  });

  it('answers 503 rather than failing when the container binding is absent', async () => {
    const response = await app.request(`${ORIGIN}/api/v1/repositories`, {}, httpEnv());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'UNCONFIGURED' } });
  });

  it('keeps the gateway’s own routes ahead of the fallback', async () => {
    const seen: Forwarded[] = [];
    const response = await app.request(
      `${ORIGIN}/api/health`,
      {},
      httpEnv({ GitViseApiContainer: namespaceRecording(seen) }),
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
  });
});
