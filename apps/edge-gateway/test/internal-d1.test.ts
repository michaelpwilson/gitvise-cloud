import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { constraintFailure } from '../src/internal/d1';
import { INTERNAL_HEADERS, verifyInternalSignature } from '../src/internal/signature';
import { httpEnv, testEnv } from './support/bindings';
import { callInternal as call, signedHeaders } from './support/internal';

const PARENT = 'internal_d1_parent';
const CHILD = 'internal_d1_child';

beforeAll(async () => {
  // Real tables, so the constraints come from SQLite itself, not a stub. The names are unique to this file.
  await testEnv.D1.exec(`CREATE TABLE IF NOT EXISTS ${PARENT} (id TEXT PRIMARY KEY)`);
  await testEnv.D1.exec(
    `CREATE TABLE IF NOT EXISTS ${CHILD} (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES ${PARENT}(id), code TEXT UNIQUE NOT NULL)`,
  );
  await testEnv.D1.prepare(`INSERT OR IGNORE INTO ${PARENT} (id) VALUES ('p1')`).run();
  await testEnv.D1.prepare(`DELETE FROM ${CHILD}`).run();
  await testEnv.D1.prepare(`INSERT INTO ${CHILD} (id, parent_id, code) VALUES ('c1', 'p1', 'taken')`).run();
});

describe('gitvise-internal-v1 verification', () => {
  it('matches a golden vector computed with the apps/api signing scheme', async () => {
    // Expected signature computed with HMAC-SHA256 over the canonical string, outside this code. A mismatch means
    // the gateway no longer agrees with apps/api on the wire format.
    const body = '{"sql":"SELECT 1","params":[],"method":"all"}';
    const ok = await verifyInternalSignature({
      secret: 'internal-gateway-secret-test-0123456789abcdef',
      method: 'POST',
      pathAndQuery: '/internal/d1/query',
      headers: new Headers({
        [INTERNAL_HEADERS.timestamp]: '1763592000000',
        [INTERNAL_HEADERS.nonce]: 'nonce-golden-0001',
        [INTERNAL_HEADERS.contentSha256]: 'a8cf756a8702bfc20c37f64f091f4db2a4deef0820fce8fbd5dd176d6954efc5',
        [INTERNAL_HEADERS.signature]: '5d06c31fd9cca261ccf7d1d0a1329229e4bb9360fc7a13bf3aa653d698b49ab5',
      }),
      body: new TextEncoder().encode(body),
      nowMs: 1763592000000,
    });
    expect(ok).toBe(true);
  });

  it('refuses a request with no signature headers', async () => {
    const response = await app.request(
      '/internal/d1/query',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sql":"SELECT 1","params":[],"method":"all"}' },
      httpEnv(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', message: 'signature check failed' });
  });

  it('refuses a signature made with the wrong secret', async () => {
    const path = '/internal/d1/query';
    const body = '{"sql":"SELECT 1","params":[],"method":"all"}';
    const response = await app.request(
      path,
      { method: 'POST', headers: await signedHeaders('POST', path, body, { secret: 'not-the-secret-0123456789abcdef' }), body },
      httpEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a body that differs from the digest that was signed', async () => {
    const path = '/internal/d1/query';
    const headers = await signedHeaders('POST', path, '{"sql":"SELECT 1","params":[],"method":"all"}');
    const response = await app.request(
      path,
      { method: 'POST', headers, body: '{"sql":"DELETE FROM users","params":[],"method":"run"}' },
      httpEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('refuses a timestamp outside the skew window', async () => {
    const path = '/internal/d1/query';
    const body = '{"sql":"SELECT 1","params":[],"method":"all"}';
    const stale = Date.now() - 10 * 60_000;
    const response = await app.request(
      path,
      { method: 'POST', headers: await signedHeaders('POST', path, body, { timestamp: stale }), body },
      httpEnv(),
    );
    expect(response.status).toBe(401);
  });

  it('refuses everything when the secret is not configured', async () => {
    const response = await call('/internal/d1/query', { sql: 'SELECT 1', params: [], method: 'all' }, httpEnv({ INTERNAL_GATEWAY_SECRET: undefined }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'UNCONFIGURED', message: 'internal gateway secret is not configured' });
  });
});

describe('POST /internal/d1/query', () => {
  it('returns positional rows for all, values, and get', async () => {
    const all = await call('/internal/d1/query', { sql: `SELECT id, code FROM ${CHILD} ORDER BY id`, params: [], method: 'all' });
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ rows: [['c1', 'taken']] });

    const values = await call('/internal/d1/query', { sql: `SELECT id FROM ${PARENT} WHERE id = ?`, params: ['p1'], method: 'values' });
    expect(await values.json()).toEqual({ rows: [['p1']] });

    const get = await call('/internal/d1/query', { sql: `SELECT id FROM ${CHILD} ORDER BY id`, params: [], method: 'get' });
    expect(await get.json()).toEqual({ rows: [['c1']] });
  });

  it('runs a write with the run method and returns no rows', async () => {
    const response = await call('/internal/d1/query', {
      sql: `INSERT INTO ${PARENT} (id) VALUES (?)`,
      params: ['p-run'],
      method: 'run',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [] });
  });

  it('answers 409 with the SQLite constraint code for a UNIQUE violation', async () => {
    const response = await call('/internal/d1/query', {
      sql: `INSERT INTO ${CHILD} (id, parent_id, code) VALUES (?, ?, ?)`,
      params: ['c-dup-unique', 'p1', 'taken'],
      method: 'run',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(body.message).toContain('UNIQUE constraint failed');
  });

  it('answers 409 with SQLITE_CONSTRAINT_PRIMARYKEY for a duplicate text primary key', async () => {
    const response = await call('/internal/d1/query', {
      sql: `INSERT INTO ${CHILD} (id, parent_id, code) VALUES (?, ?, ?)`,
      params: ['c1', 'p1', 'fresh-code'],
      method: 'run',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
  });

  it('answers 409 with SQLITE_CONSTRAINT_FOREIGNKEY for a missing parent', async () => {
    const response = await call('/internal/d1/query', {
      sql: `INSERT INTO ${CHILD} (id, parent_id, code) VALUES (?, ?, ?)`,
      params: ['c-orphan', 'no-such-parent', 'orphan-code'],
      method: 'run',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('answers 409 for a NOT NULL violation, which is also a constraint', async () => {
    const response = await call('/internal/d1/query', {
      sql: `INSERT INTO ${CHILD} (id, parent_id, code) VALUES (?, ?, ?)`,
      params: ['c-null', 'p1', null],
      method: 'run',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('SQLITE_CONSTRAINT_NOTNULL');
  });

  it('keeps a non-constraint D1 error on its existing status, 500 INTERNAL', async () => {
    const response = await call('/internal/d1/query', { sql: 'SELEC nope', params: [], method: 'all' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  it('rejects a malformed statement with 400 before it reaches D1', async () => {
    const response = await call('/internal/d1/query', { sql: 'SELECT 1', params: [], method: 'stream' });
    expect(response.status).toBe(400);
  });
});

describe('POST /internal/d1/batch', () => {
  it('applies every statement and returns one result per statement', async () => {
    const response = await call('/internal/d1/batch', {
      statements: [
        { sql: `INSERT INTO ${PARENT} (id) VALUES (?)`, params: ['p-batch-ok'], method: 'run' },
        { sql: `SELECT id FROM ${PARENT} WHERE id = ?`, params: ['p-batch-ok'], method: 'all' },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ rows: [] }, { rows: [['p-batch-ok']] }] });
  });

  it('answers 409 when one statement violates a constraint', async () => {
    const response = await call('/internal/d1/batch', {
      statements: [
        { sql: `INSERT INTO ${PARENT} (id) VALUES (?)`, params: ['p-batch-rollback'], method: 'run' },
        { sql: `INSERT INTO ${CHILD} (id, parent_id, code) VALUES (?, ?, ?)`, params: ['c-batch-dup', 'p1', 'taken'], method: 'run' },
      ],
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });

  it('rolls back the whole batch when a constraint fails, so the earlier insert is not visible', async () => {
    const rolledBack = await call('/internal/d1/query', {
      sql: `SELECT id FROM ${PARENT} WHERE id = ?`,
      params: ['p-batch-rollback'],
      method: 'all',
    });
    expect(await rolledBack.json()).toEqual({ rows: [] });
  });

  it('answers 409 for a constraint failure in a FOREIGN KEY batch', async () => {
    const response = await call('/internal/d1/batch', {
      statements: [{ sql: `INSERT INTO ${CHILD} (id, parent_id, code) VALUES (?, ?, ?)`, params: ['c-fk-batch', 'missing', 'fk-code'], method: 'run' }],
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('keeps a non-constraint batch error on 500', async () => {
    const response = await call('/internal/d1/batch', {
      statements: [{ sql: 'SELEC nope', params: [], method: 'run' }],
    });
    expect(response.status).toBe(500);
  });

  it('rejects an empty batch with 400', async () => {
    const response = await call('/internal/d1/batch', { statements: [] });
    expect(response.status).toBe(400);
  });
});

describe('constraintFailure', () => {
  it('reads the extended code from a D1 message', () => {
    const error = new Error('D1_ERROR: UNIQUE constraint failed: t.c: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)');
    expect(constraintFailure(error)?.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });

  it('finds the constraint named only in the cause', () => {
    const error = Object.assign(new Error('D1_ERROR: failed'), { cause: new Error('FOREIGN KEY constraint failed: SQLITE_CONSTRAINT') });
    expect(constraintFailure(error)?.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('falls back to SQLITE_CONSTRAINT when only the base name is present', () => {
    expect(constraintFailure(new Error('SQLITE_CONSTRAINT: something'))?.code).toBe('SQLITE_CONSTRAINT');
  });

  it('maps a phrased constraint message when the base name is missing', () => {
    expect(constraintFailure(new Error('PRIMARY KEY constraint failed: t.id'))?.code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
  });

  it('returns undefined for a non-constraint error, so it is rethrown', () => {
    expect(constraintFailure(new Error('D1_ERROR: near "SELEC": syntax error'))).toBeUndefined();
    expect(constraintFailure('boom')).toBeUndefined();
    expect(constraintFailure(undefined)).toBeUndefined();
  });
});
