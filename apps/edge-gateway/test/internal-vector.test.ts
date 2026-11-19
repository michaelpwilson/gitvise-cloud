import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { httpEnv, uniqueId } from './support/bindings';
import { fakeVectorize, type FakeVectorize } from './support/fake-vectorize';
import { callInternal as call, signedHeaders } from './support/internal';

/** Vectors of the right shape. The fake only compares them, so the values need not be meaningful. */
const EMBEDDING = [0.1, 0.2, 0.3];

function record(id: string, namespace: string, kind: string, payload: Record<string, string | number | boolean>) {
  return { id, namespace, kind, embedding: EMBEDDING, payload };
}

/** A fresh fake and env per test, so no test sees another's vectors or deletes. */
function setup(): { vectorize: FakeVectorize; env: ReturnType<typeof httpEnv> } {
  const vectorize = fakeVectorize();
  return { vectorize, env: httpEnv({ VECTORIZE: vectorize as unknown as VectorizeIndex }) };
}

async function upsert(env: ReturnType<typeof httpEnv>, records: unknown[]) {
  return call('/internal/ports/vector/upsert', { records }, env);
}

describe('POST /internal/ports/vector/upsert', () => {
  it('writes the vectors and returns a count', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    const response = await upsert(env, [
      record(`${ns}-a`, ns, 'code-embedding', { filePath: 'src/a.ts', isWiki: false }),
      record(`${ns}-b`, ns, 'code-embedding', { filePath: 'src/b.ts', isWiki: false }),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ upserted: 2 });
    expect(vectorize.vectors.has(`${ns}-a`)).toBe(true);
    expect(vectorize.vectors.get(`${ns}-a`)?.namespace).toBe(ns);
  });

  it('refuses the reserved payload key kind before writing anything', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    const response = await upsert(env, [record(`${ns}-x`, ns, 'code-embedding', { kind: 'spoof' })]);
    expect(response.status).toBe(400);
    expect(vectorize.vectors.size).toBe(0);
  });

  it('refuses an unknown kind', async () => {
    const { env } = setup();
    const ns = uniqueId('repo');
    expect((await upsert(env, [record(`${ns}-x`, ns, 'not-a-kind', {})])).status).toBe(400);
  });
});

describe('POST /internal/ports/vector/query', () => {
  it('returns matches from the caller namespace only, in the apps/api shape', async () => {
    const { env } = setup();
    const mine = uniqueId('mine');
    const theirs = uniqueId('theirs');
    await upsert(env, [record(`${mine}-1`, mine, 'code-embedding', { filePath: 'a' }), record(`${theirs}-1`, theirs, 'code-embedding', { filePath: 'a' })]);

    const response = await call('/internal/ports/vector/query', {
      namespace: mine,
      embedding: EMBEDDING,
      topK: 10,
      kind: 'code-embedding',
    }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matches: Array<{ id: string; kind: string; score: number; payload: unknown }> };
    expect(body.matches.map((match) => match.id)).toEqual([`${mine}-1`]);
    expect(body.matches[0]).toMatchObject({ kind: 'code-embedding', payload: { filePath: 'a' } });
    expect(typeof body.matches[0]?.score).toBe('number');
  });

  it('refuses a payload filter instead of ignoring it', async () => {
    const { env } = setup();
    const ns = uniqueId('repo');
    const response = await call('/internal/ports/vector/query', {
      namespace: ns,
      embedding: EMBEDDING,
      topK: 5,
      payload: { isWiki: false },
    }, env);
    expect(response.status).toBe(400);
  });
});

describe('POST /internal/ports/vector/delete', () => {
  it('deletes exactly the vectors the filter selects, and removes them from the index', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    await upsert(env, [
      record(`${ns}-a`, ns, 'code-embedding', { filePath: 'src/a.ts', isWiki: false }),
      record(`${ns}-b`, ns, 'code-embedding', { filePath: 'src/b.ts', isWiki: false }),
      record(`${ns}-c`, ns, 'code-embedding', { filePath: 'src/c.ts', isWiki: false }),
    ]);

    const response = await call('/internal/ports/vector/delete', {
      namespace: ns,
      kind: 'code-embedding',
      payload: { isWiki: false },
      payloadIn: { filePath: ['src/a.ts', 'src/b.ts'] },
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(vectorize.deletes).toEqual([[`${ns}-a`, `${ns}-b`]]);
    expect([...vectorize.vectors.keys()]).toEqual([`${ns}-c`]);
  });

  it('never deletes another namespace, even when the payload matches', async () => {
    const { vectorize, env } = setup();
    const mine = uniqueId('mine');
    const theirs = uniqueId('theirs');
    await upsert(env, [
      record(`${mine}-1`, mine, 'code-embedding', { filePath: 'shared.ts' }),
      record(`${theirs}-1`, theirs, 'code-embedding', { filePath: 'shared.ts' }),
    ]);

    await call('/internal/ports/vector/delete', { namespace: mine, payloadIn: { filePath: ['shared.ts'] } }, env);

    expect(vectorize.deletes).toEqual([[`${mine}-1`]]);
    expect(vectorize.vectors.has(`${theirs}-1`)).toBe(true);
  });

  it('matches a boolean payload field exactly', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    await upsert(env, [
      record(`${ns}-src`, ns, 'code-embedding', { filePath: 'a', isWiki: false }),
      record(`${ns}-wiki`, ns, 'code-embedding', { filePath: 'a', isWiki: true }),
    ]);
    await call('/internal/ports/vector/delete', { namespace: ns, payload: { isWiki: false } }, env);
    expect(vectorize.deletes).toEqual([[`${ns}-src`]]);
    expect(vectorize.vectors.has(`${ns}-wiki`)).toBe(true);
  });

  it('returns deleted 0 and calls nothing when the filter matches no vector', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    const response = await call('/internal/ports/vector/delete', { namespace: ns, payloadIn: { filePath: ['missing.ts'] } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(vectorize.deletes).toEqual([]);
  });

  it('keeps the index row when Vectorize fails, so a retry still finds the vector', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    await upsert(env, [record(`${ns}-a`, ns, 'code-embedding', { filePath: 'a.ts' })]);

    vectorize.failNextDelete = 'vectorize unavailable';
    const failed = await call('/internal/ports/vector/delete', { namespace: ns, payloadIn: { filePath: ['a.ts'] } }, env);
    expect(failed.status).toBe(502);
    expect(vectorize.vectors.has(`${ns}-a`)).toBe(true);

    const retried = await call('/internal/ports/vector/delete', { namespace: ns, payloadIn: { filePath: ['a.ts'] } }, env);
    expect(await retried.json()).toEqual({ ok: true });
    expect(vectorize.vectors.has(`${ns}-a`)).toBe(false);
  });

  it('deletes every match across more than one page', async () => {
    const { vectorize, env } = setup();
    const ns = uniqueId('repo');
    // 120 vectors is more than one page of 50 index rows, so the loop has to run more than once.
    const records = Array.from({ length: 120 }, (_, i) => record(`${ns}-${i}`, ns, 'code-embedding', { filePath: 'big.ts' }));
    for (let i = 0; i < records.length; i += 50) await upsert(env, records.slice(i, i + 50));

    const response = await call('/internal/ports/vector/delete', { namespace: ns, kind: 'code-embedding' }, env);
    expect(await response.json()).toEqual({ ok: true });
    expect(vectorize.vectors.size).toBe(0);
  });

  it('refuses an empty payloadIn list, which would match nothing', async () => {
    const { env } = setup();
    const response = await call('/internal/ports/vector/delete', { namespace: uniqueId('repo'), payloadIn: { filePath: [] } }, env);
    expect(response.status).toBe(400);
  });

  it('refuses a payload key that is not a plain identifier, so it cannot shape the JSON path', async () => {
    const { env } = setup();
    const response = await call('/internal/ports/vector/delete', { namespace: uniqueId('repo'), payload: { 'a.b"]': 'x' } }, env);
    expect(response.status).toBe(400);
  });

  it('refuses a missing namespace', async () => {
    const { env } = setup();
    expect((await call('/internal/ports/vector/delete', { kind: 'code-embedding' }, env)).status).toBe(400);
  });

  it('refuses an unsigned delete', async () => {
    const { env } = setup();
    const response = await app.request(
      '/internal/ports/vector/delete',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'repo' }) },
      env,
    );
    expect(response.status).toBe(401);
  });

  it('refuses a tampered signed delete body', async () => {
    const { env } = setup();
    const path = '/internal/ports/vector/delete';
    const headers = await signedHeaders('POST', path, JSON.stringify({ namespace: 'repo-a' }));
    const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ namespace: 'repo-b' }) }, env);
    expect(response.status).toBe(401);
  });
});
