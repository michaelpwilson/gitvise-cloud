import {
  GitViseError,
  VECTOR_RECORD_KINDS,
  type JsonPrimitive,
  type VectorDeleteFilter,
  type VectorFilterValue,
  type VectorMatch,
  type VectorMemoryPort,
  type VectorQuery,
  type VectorRecord,
  type VectorRecordKind,
} from '@gitvise/core';
import { chunk } from '../shared/bytes';
import { invalid, upstreamError } from '../shared/errors';

const UPSERT_BATCH = 500;
/** Rows per D1 index statement. The whole group travels as one JSON parameter, so this bounds its size. */
const INDEX_BATCH = 50;
const DELETE_PAGE = 500;
/** A guard against a delete loop that never empties the index. Reaching it means the index and Vectorize disagree. */
const MAX_DELETE_PAGES = 10_000;
const MAX_TOP_K = 50;
const MAX_IN_VALUES = 1_000;
const KIND_KEY = 'kind';
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * `VectorMemoryPort` over a Vectorize index, with a D1 index beside it. The index must use the cosine metric and have
 * a metadata index on `kind` (`wrangler vectorize create-metadata-index <name> --property-name=kind --type=string`),
 * or the `kind` filter returns nothing.
 *
 * Vectorize deletes only by id, but the port deletes by filter. So every upsert also writes a `vector_index` row (see
 * migration 0006 in the edge gateway) with the record's namespace, kind, and payload. A filter resolves to ids through
 * that table, then `deleteByIds` runs. The index row is written first, so a failed upsert can leave a stale row, which
 * is harmless, but never a vector that no filter can find.
 *
 * Namespaces are a first-class Vectorize concept, so queries never cross tenants.
 */
export class CloudflareVectorizeAdapter implements VectorMemoryPort {
  constructor(
    private readonly index: VectorizeIndex,
    private readonly db: D1Database,
  ) {}

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const record of records) {
      if (record.payload[KIND_KEY] !== undefined) {
        throw invalid(`payload may not use the reserved key "${KIND_KEY}"`);
      }
    }
    for (const group of chunk(records, UPSERT_BATCH)) {
      for (const rows of chunk(group, INDEX_BATCH)) {
        await this.writeIndex(rows);
      }
      const vectors = group.map((record) => ({
        id: record.id,
        namespace: record.namespace,
        values: Array.from(record.embedding),
        metadata: { ...record.payload, [KIND_KEY]: record.kind },
      }));
      try {
        await this.index.upsert(vectors);
      } catch (error) {
        throw upstreamError('vector upsert failed', error);
      }
    }
  }

  async query(query: VectorQuery): Promise<readonly VectorMatch[]> {
    if (!Number.isSafeInteger(query.topK) || query.topK < 1 || query.topK > MAX_TOP_K) {
      throw invalid(`topK must be an integer from 1 to ${MAX_TOP_K}`);
    }
    if (query.kind !== undefined && !(VECTOR_RECORD_KINDS as readonly string[]).includes(query.kind)) {
      throw invalid('kind is not supported');
    }
    if (query.payload !== undefined && Object.keys(query.payload).length > 0) {
      // Vectorize filters on indexed metadata only, so a payload filter cannot be honoured. Refusing is safer than
      // returning matches the caller did not ask for.
      throw invalid('payload filters are not supported by the vector index');
    }

    let result: VectorizeMatches;
    try {
      result = await this.index.query(Array.from(query.embedding), {
        topK: query.topK,
        namespace: query.namespace,
        returnMetadata: 'all',
        ...(query.kind === undefined ? {} : { filter: { [KIND_KEY]: query.kind } }),
      });
    } catch (error) {
      throw upstreamError('vector query failed', error);
    }

    const matches: VectorMatch[] = [];
    for (const match of result.matches) {
      if (query.minScore !== undefined && match.score < query.minScore) continue;
      const { [KIND_KEY]: kind, ...payload } = match.metadata ?? {};
      if (!isRecordKind(kind)) continue;
      matches.push({ id: match.id, kind, score: match.score, payload: payload as Record<string, JsonPrimitive> });
    }
    return matches;
  }

  /**
   * Removes every vector the filter selects, a page at a time. Each page leaves Vectorize first and the index second, so
   * a failure partway leaves at most index rows whose vectors are already gone, and a retry clears them.
   */
  async deleteByFilter(filter: VectorDeleteFilter): Promise<void> {
    assertFilter(filter);
    const { sql, params } = selectIdsSql(filter);
    for (let page = 0; page < MAX_DELETE_PAGES; page += 1) {
      const rows = await this.db.prepare(sql).bind(...params).all<{ id: string }>();
      const ids = rows.results.map((row) => row.id);
      if (ids.length === 0) return;
      try {
        await this.index.deleteByIds(ids);
      } catch (error) {
        throw upstreamError('vector delete failed', error);
      }
      await this.db.prepare(DELETE_INDEX_SQL).bind(JSON.stringify(ids)).run();
    }
    throw upstreamError('vector delete did not converge', new Error('the index and Vectorize disagree'));
  }

  private async writeIndex(records: readonly VectorRecord[]): Promise<void> {
    const rows = records.map((record) => ({
      id: record.id,
      namespace: record.namespace,
      kind: record.kind,
      payload: record.payload,
    }));
    await this.db.prepare(UPSERT_INDEX_SQL).bind(JSON.stringify(rows)).run();
  }
}

const UPSERT_INDEX_SQL = `INSERT INTO vector_index (id, namespace, kind, payload)
  SELECT json_extract(value, '$.id'), json_extract(value, '$.namespace'), json_extract(value, '$.kind'), json_extract(value, '$.payload')
  FROM json_each(?1) WHERE 1
  ON CONFLICT (id) DO UPDATE SET namespace = excluded.namespace, kind = excluded.kind, payload = excluded.payload`;

const DELETE_INDEX_SQL = 'DELETE FROM vector_index WHERE id IN (SELECT value FROM json_each(?1))';

/**
 * Builds the id selection for a filter. Every value is bound. Each payload key becomes a bound JSON path (`$.key`),
 * and keys were checked against a strict identifier pattern before this runs.
 */
function selectIdsSql(filter: VectorDeleteFilter): { sql: string; params: unknown[] } {
  let sql = 'SELECT id FROM vector_index WHERE namespace = ?';
  const params: unknown[] = [filter.namespace];
  if (filter.kind !== undefined) {
    sql += ' AND kind = ?';
    params.push(filter.kind);
  }
  for (const [key, value] of Object.entries(filter.payload ?? {})) {
    sql += ' AND json_extract(payload, ?) = ?';
    params.push(`$.${key}`, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  for (const [key, values] of Object.entries(filter.payloadIn ?? {})) {
    sql += ' AND json_extract(payload, ?) IN (SELECT value FROM json_each(?))';
    params.push(`$.${key}`, JSON.stringify(values));
  }
  sql += ` LIMIT ${DELETE_PAGE}`;
  return { sql, params };
}

/** Rejects a filter the index cannot honour. Every clause must be well-formed, or the delete would match the wrong rows. */
function assertFilter(filter: VectorDeleteFilter): void {
  if (typeof filter.namespace !== 'string' || filter.namespace === '') {
    throw invalid('filter.namespace must be a non-empty string');
  }
  if (filter.kind !== undefined && !(VECTOR_RECORD_KINDS as readonly string[]).includes(filter.kind)) {
    throw invalid('kind is not supported');
  }
  for (const [key, value] of Object.entries(filter.payload ?? {})) {
    checkKey(key);
    if (!isFilterValue(value)) throw invalid(`payload.${key} must be a string, number, or boolean`);
  }
  for (const [key, values] of Object.entries(filter.payloadIn ?? {})) {
    checkKey(key);
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_IN_VALUES) {
      throw invalid(`payloadIn.${key} must be a non-empty array of up to ${MAX_IN_VALUES} strings`);
    }
    if (!values.every((value) => typeof value === 'string')) throw invalid(`payloadIn.${key} must hold only strings`);
  }
}

function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw invalid(`payload key "${key}" is not a valid identifier`);
}

function isFilterValue(value: unknown): value is VectorFilterValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecordKind(value: unknown): value is VectorRecordKind {
  return typeof value === 'string' && (VECTOR_RECORD_KINDS as readonly string[]).includes(value);
}
