import {
  GitViseError,
  VECTOR_RECORD_KINDS,
  type JsonPrimitive,
  type VectorMatch,
  type VectorMemoryPort,
  type VectorQuery,
  type VectorRecord,
  type VectorRecordKind,
} from '@gitvise/core';
import { chunk } from '../shared/bytes';
import { upstreamError } from '../shared/errors';

const UPSERT_BATCH = 500;
const MAX_TOP_K = 50;
const KIND_KEY = 'kind';

/**
 * `VectorMemoryPort` over a Vectorize index. The index must use the cosine metric and have a metadata
 * index on `kind` (`wrangler vectorize create-metadata-index <name> --property-name=kind --type=string`),
 * or the `kind` filter returns nothing.
 *
 * Namespaces are a first-class Vectorize concept, so queries never cross tenants.
 */
export class CloudflareVectorizeAdapter implements VectorMemoryPort {
  constructor(private readonly index: VectorizeIndex) {}

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const record of records) {
      if (record.payload[KIND_KEY] !== undefined) {
        throw new GitViseError('INVALID_REQUEST', `payload may not use the reserved key "${KIND_KEY}"`);
      }
    }
    for (const group of chunk(records, UPSERT_BATCH)) {
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
      throw new GitViseError('INVALID_REQUEST', `topK must be an integer from 1 to ${MAX_TOP_K}`);
    }
    if (query.kind !== undefined && !(VECTOR_RECORD_KINDS as readonly string[]).includes(query.kind)) {
      throw new GitViseError('INVALID_REQUEST', 'kind is not supported');
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
}

function isRecordKind(value: unknown): value is VectorRecordKind {
  return typeof value === 'string' && (VECTOR_RECORD_KINDS as readonly string[]).includes(value);
}
