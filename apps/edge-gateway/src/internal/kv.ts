import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app-env';
import { readJson } from '../http';
import { invalid, MAX_KV_VALUE_BYTES, objectBody, optionalIntField, stringField } from './validate';

/**
 * `/internal/kv/:key`. Every operation goes to the key's own Durable Object (see src/kv/gateway-kv-entry.ts), which
 * makes `ifAbsent` and counters atomic. The apps/api container reaches these through its gateway KV client.
 *
 *   GET    /internal/kv/:key                 -> 200 { value } | 404
 *   PUT    /internal/kv/:key                 -> 200 { written } | 409 (ifAbsent and the key is live)
 *   DELETE /internal/kv/:key                 -> 200 { deleted }
 *   POST   /internal/kv/:key/incr            -> 200 { value }
 *   POST   /internal/kv/:key/take            -> 200 { value | null }   (read and delete)
 *   GET    /internal/kv/:key/ttl             -> 200 { ttlMs }          (-1 no expiry, -2 absent)
 *   POST   /internal/kv/:key/expire          -> 200 { updated }
 *
 * TTLs are in whole seconds on the wire. Milliseconds are rounded up, so a key never expires early.
 */

const MAX_KEY_CHARS = 512;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_COUNTER_STEP = 1_000_000_000;

export const kvRoutes = new Hono<AppEnv>();

kvRoutes.get('/kv/:key', async (c) => {
  const value = await entryFor(c, keyParam(c)).get();
  if (value === undefined) return c.json({ code: 'NOT_FOUND', message: 'no such key' }, 404);
  return c.json({ value });
});

kvRoutes.put('/kv/:key', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const value = stringField(body['value'], 'value', MAX_KV_VALUE_BYTES, 0);
  if (new TextEncoder().encode(value).byteLength > MAX_KV_VALUE_BYTES) {
    throw invalid(`value is larger than ${MAX_KV_VALUE_BYTES} bytes`);
  }
  const ttlMs = ttlFromSeconds(body['ttlSeconds']);
  if (body['ifAbsent'] !== undefined && typeof body['ifAbsent'] !== 'boolean') {
    throw invalid('ifAbsent must be a boolean');
  }
  const written = await entryFor(c, keyParam(c)).put(value, {
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ifAbsent: body['ifAbsent'] === true,
  });
  if (!written) {
    return c.json({ code: 'CONFLICT', message: 'key already exists', written: false }, 409);
  }
  return c.json({ written: true });
});

kvRoutes.delete('/kv/:key', async (c) => {
  return c.json({ deleted: await entryFor(c, keyParam(c)).delete() });
});

kvRoutes.post('/kv/:key/incr', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const by = optionalIntField(body['by'], 'by', -MAX_COUNTER_STEP, MAX_COUNTER_STEP) ?? 1;
  const ttlMs = ttlFromSeconds(body['ttlSeconds']);
  const value = await entryFor(c, keyParam(c)).increment(by, ttlMs);
  return c.json({ value });
});

kvRoutes.post('/kv/:key/take', async (c) => {
  return c.json({ value: (await entryFor(c, keyParam(c)).take()) ?? null });
});

kvRoutes.get('/kv/:key/ttl', async (c) => {
  return c.json({ ttlMs: await entryFor(c, keyParam(c)).remainingMs() });
});

kvRoutes.post('/kv/:key/expire', async (c) => {
  const body = objectBody(await readJson<unknown>(c.req.raw));
  const ttlMs = ttlFromSeconds(body['ttlSeconds']);
  if (ttlMs === undefined) throw invalid('ttlSeconds is required');
  return c.json({ updated: await entryFor(c, keyParam(c)).expire(ttlMs) });
});

function entryFor(c: Context<AppEnv>, key: string) {
  return c.env.KV_ENTRIES.getByName(key);
}

function keyParam(c: Context<AppEnv>): string {
  const key = c.req.param('key') ?? '';
  if (key.length === 0 || key.length > MAX_KEY_CHARS) {
    throw invalid(`key must be 1 to ${MAX_KEY_CHARS} characters`);
  }
  return key;
}

/** Whole seconds on the wire, milliseconds inside the object. Undefined means no expiry. */
function ttlFromSeconds(value: unknown): number | undefined {
  const seconds = optionalIntField(value, 'ttlSeconds', 1, MAX_TTL_SECONDS);
  return seconds === undefined ? undefined : seconds * 1000;
}

