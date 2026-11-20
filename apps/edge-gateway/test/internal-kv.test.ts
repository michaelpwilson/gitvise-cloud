import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { httpEnv, uniqueId } from './support/bindings';
import { callInternalWith, signedHeaders } from './support/internal';

const kvPath = (key: string, suffix = '') => `/internal/kv/${encodeURIComponent(key)}${suffix}`;

describe('/internal/kv', () => {
  it('stores, reads, and deletes a value', async () => {
    const key = uniqueId('kv-basic');
    const put = await callInternalWith('PUT', kvPath(key), { payload: { value: 'hello' } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ written: true });

    const read = await callInternalWith('GET', kvPath(key));
    expect(await read.json()).toEqual({ value: 'hello' });

    const removed = await callInternalWith('DELETE', kvPath(key));
    expect(await removed.json()).toEqual({ deleted: true });
    expect((await callInternalWith('GET', kvPath(key))).status).toBe(404);
  });

  it('refuses a second ifAbsent write with 409 and keeps the first value', async () => {
    const key = uniqueId('kv-absent');
    await callInternalWith('PUT', kvPath(key), { payload: { value: 'first', ifAbsent: true } });

    const second = await callInternalWith('PUT', kvPath(key), { payload: { value: 'second', ifAbsent: true } });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'CONFLICT', written: false });
    expect(await (await callInternalWith('GET', kvPath(key))).json()).toEqual({ value: 'first' });
  });

  it('lets exactly one of many concurrent ifAbsent writes win', async () => {
    const key = uniqueId('kv-race');
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        callInternalWith('PUT', kvPath(key), { payload: { value: `writer-${index}`, ifAbsent: true } }),
      ),
    );
    const statuses = attempts.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
  });

  it('counts atomically, creating a counter at the step size', async () => {
    const key = uniqueId('kv-count');
    expect(await (await callInternalWith('POST', kvPath(key, '/incr'), { payload: { by: 2 } })).json()).toEqual({
      value: 2,
    });
    expect(await (await callInternalWith('POST', kvPath(key, '/incr'), { payload: {} })).json()).toEqual({ value: 3 });
    expect(await (await callInternalWith('POST', kvPath(key, '/incr'), { payload: { by: -3 } })).json()).toEqual({
      value: 0,
    });
  });

  it('answers concurrent increments without losing any', async () => {
    const key = uniqueId('kv-count-race');
    await Promise.all(
      Array.from({ length: 25 }, () => callInternalWith('POST', kvPath(key, '/incr'), { payload: {} })),
    );
    expect(await (await callInternalWith('POST', kvPath(key, '/incr'), { payload: { by: 0 } })).json()).toEqual({
      value: 25,
    });
  });

  it('expires a key after its ttlSeconds', async () => {
    const key = uniqueId('kv-ttl');
    await callInternalWith('PUT', kvPath(key), { payload: { value: 'short', ttlSeconds: 1 } });
    expect(await (await callInternalWith('GET', kvPath(key, '/ttl'))).json()).toMatchObject({ ttlMs: expect.any(Number) });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect((await callInternalWith('GET', kvPath(key))).status).toBe(404);
    // An expired key is absent, so ifAbsent can write it again.
    const reclaimed = await callInternalWith('PUT', kvPath(key), { payload: { value: 'fresh', ifAbsent: true } });
    expect(reclaimed.status).toBe(200);
  });

  it('reports no expiry as -1 and absence as -2, and sets an expiry with expire', async () => {
    const key = uniqueId('kv-expire');
    expect(await (await callInternalWith('GET', kvPath(key, '/ttl'))).json()).toEqual({ ttlMs: -2 });

    await callInternalWith('PUT', kvPath(key), { payload: { value: 'v' } });
    expect(await (await callInternalWith('GET', kvPath(key, '/ttl'))).json()).toEqual({ ttlMs: -1 });

    const expired = await callInternalWith('POST', kvPath(key, '/expire'), { payload: { ttlSeconds: 60 } });
    expect(await expired.json()).toEqual({ updated: true });
    const ttl = (await (await callInternalWith('GET', kvPath(key, '/ttl'))).json()) as { ttlMs: number };
    expect(ttl.ttlMs).toBeGreaterThan(0);
  });

  it('takes a value and removes it in one step', async () => {
    const key = uniqueId('kv-take');
    await callInternalWith('PUT', kvPath(key), { payload: { value: 'once' } });
    expect(await (await callInternalWith('POST', kvPath(key, '/take'))).json()).toEqual({ value: 'once' });
    expect(await (await callInternalWith('POST', kvPath(key, '/take'))).json()).toEqual({ value: null });
  });

  it('refuses a replayed signed request with 401', async () => {
    const key = uniqueId('kv-replay');
    const path = kvPath(key);
    const body = JSON.stringify({ value: 'original' });
    const headers = await signedHeaders('PUT', path, body);

    const first = await app.request(path, { method: 'PUT', headers, body }, httpEnv());
    expect(first.status).toBe(200);
    const replay = await app.request(path, { method: 'PUT', headers, body }, httpEnv());
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a request signed with the wrong secret before it touches the key', async () => {
    const key = uniqueId('kv-forged');
    const path = kvPath(key);
    const body = JSON.stringify({ value: 'forged' });
    const headers = await signedHeaders('PUT', path, body, { secret: 'not-the-real-secret-0123456789abcdef' });
    const response = await app.request(path, { method: 'PUT', headers, body }, httpEnv());
    expect(response.status).toBe(401);
    expect((await callInternalWith('GET', kvPath(key))).status).toBe(404);
  });

  it('rejects a value that is not a string, or a bad ttl, with 400', async () => {
    const key = uniqueId('kv-invalid');
    expect((await callInternalWith('PUT', kvPath(key), { payload: { value: 42 } })).status).toBe(400);
    expect((await callInternalWith('PUT', kvPath(key), { payload: { value: 'v', ttlSeconds: 0 } })).status).toBe(400);
    expect((await callInternalWith('PUT', kvPath(key), { payload: { value: 'v', ifAbsent: 'yes' } })).status).toBe(400);
  });
});
