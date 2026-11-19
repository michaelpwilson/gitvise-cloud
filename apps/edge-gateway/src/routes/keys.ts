import { Hono } from 'hono';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { base64url, randomBytes, randomHex, sha256Hex } from '../crypto';
import { readJson } from '../http';
import { API_KEY_PREFIX, requirePrincipal, requireSession } from '../auth/principal';

/**
 * API keys for CLI and IDE clients. Minting needs a dashboard session, so a stolen key cannot mint more keys.
 * Listing and revoking work with either credential, and only on keys that belong to the caller.
 */
export const keyRoutes = new Hono<AppEnv>();

/** The public start of a key shown in lists: `gv_live_` plus 8 random characters. Never enough to authenticate. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

/** One row of `api_keys`, as read for listing. The digest is selected nowhere on this path. */
interface KeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string | null;
  readonly created_at: number;
  readonly last_used_at: number | null;
}

/** Active keys for the caller. Revoked keys are omitted. The secret and its digest are never returned. */
keyRoutes.get('/', requirePrincipal, async (c) => {
  const principal = c.get('principal');
  const result = await c.env.D1.prepare(
    `SELECT id, name, prefix, created_at, last_used_at
       FROM api_keys
      WHERE user_id = ?1 AND org_id = ?2 AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC`,
  )
    .bind(principal.userId, principal.orgId)
    .all<KeyRow>();

  c.header('cache-control', 'no-store');
  return c.json({ keys: result.results.map(keySummary) });
});

keyRoutes.post('/', requireSession, async (c) => {
  const principal = c.get('principal');
  const body = await readJson<{ name?: unknown }>(c.req.raw).catch(() => ({}) as { name?: unknown });
  const name = nameValue(body.name);

  // 32 random bytes is 256 bits. The plaintext is returned once and only its digest is stored.
  const key = `${API_KEY_PREFIX}${base64url(randomBytes(32))}`;
  const id = `key-${randomHex(8)}`;
  const prefix = key.slice(0, DISPLAY_PREFIX_LENGTH);
  const createdAt = Math.floor(Date.now() / 1000);
  await c.env.D1.prepare(
    'INSERT INTO api_keys (id, key_hash, org_id, user_id, role, name, prefix, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
  )
    .bind(id, await sha256Hex(key), principal.orgId, principal.userId, principal.role, name, prefix, createdAt)
    .run();

  c.header('cache-control', 'no-store');
  return c.json(
    {
      id,
      name,
      role: principal.role,
      prefix,
      createdAt: isoFromUnix(createdAt),
      lastUsedAt: null,
      key,
    },
    201,
  );
});

keyRoutes.delete('/:id', requirePrincipal, async (c) => {
  const principal = c.get('principal');
  const id = c.req.param('id');
  // Revocation is the row itself. Every request checks the row, so the key stops working on the next request.
  const result = await c.env.D1.prepare(
    'UPDATE api_keys SET revoked_at = unixepoch() WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL',
  )
    .bind(id, principal.userId)
    .run();
  if (result.meta.changes === 0) throw new GitViseError('NOT_FOUND', 'no active key with that id');
  return c.body(null, 204);
});

function keySummary(row: KeyRow): {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
} {
  return {
    id: row.id,
    name: row.name,
    // Keys minted before the prefix column existed have no stored prefix. Every key starts with this one.
    prefix: row.prefix ?? API_KEY_PREFIX,
    createdAt: isoFromUnix(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : isoFromUnix(row.last_used_at),
  };
}

/** D1 stores unix seconds. The API speaks ISO 8601, which is what every client parses. */
function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function nameValue(value: unknown): string {
  if (value === undefined) return 'cli';
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    throw new GitViseError('INVALID_REQUEST', 'name must be 1-64 characters');
  }
  return value.trim();
}
