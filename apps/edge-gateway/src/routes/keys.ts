import { Hono } from 'hono';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { base64url, randomBytes, randomHex, sha256Hex } from '../crypto';
import { readJson } from '../http';
import { API_KEY_PREFIX, apiKeyCacheKey, requirePrincipal, requireSession } from '../auth/principal';

/**
 * API keys for CLI and IDE clients. Minting needs a dashboard session, so a stolen key cannot mint more keys.
 * Revoking works with either credential, and only on keys that belong to the caller.
 */
export const keyRoutes = new Hono<AppEnv>();

keyRoutes.post('/', requireSession, async (c) => {
  const principal = c.get('principal');
  const body = await readJson<{ name?: unknown }>(c.req.raw).catch(() => ({}) as { name?: unknown });
  const name = nameValue(body.name);

  // 32 random bytes is 256 bits. The plaintext is returned once and only its digest is stored.
  const key = `${API_KEY_PREFIX}${base64url(randomBytes(32))}`;
  const id = `key-${randomHex(8)}`;
  await c.env.D1.prepare(
    'INSERT INTO api_keys (id, key_hash, org_id, user_id, role, name) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(id, await sha256Hex(key), principal.orgId, principal.userId, principal.role, name)
    .run();

  c.header('cache-control', 'no-store');
  return c.json({ id, name, role: principal.role, key }, 201);
});

keyRoutes.delete('/:id', requirePrincipal, async (c) => {
  const principal = c.get('principal');
  const id = c.req.param('id');
  const row = await c.env.D1.prepare(
    'SELECT key_hash FROM api_keys WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL',
  )
    .bind(id, principal.userId)
    .first<{ key_hash: string }>();
  if (row === null) throw new GitViseError('NOT_FOUND', 'no active key with that id');

  await c.env.D1.prepare('UPDATE api_keys SET revoked_at = unixepoch() WHERE id = ?1').bind(id).run();
  // Drop the cached identity now, so the key stops working here without waiting for the cache TTL.
  await c.env.KV.delete(apiKeyCacheKey(row.key_hash));
  return c.body(null, 204);
});

function nameValue(value: unknown): string {
  if (value === undefined) return 'cli';
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    throw new GitViseError('INVALID_REQUEST', 'name must be 1-64 characters');
  }
  return value.trim();
}
