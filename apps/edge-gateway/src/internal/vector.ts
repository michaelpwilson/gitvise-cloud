import {
  GitViseError,
  VECTOR_RECORD_KINDS,
  type VectorDeleteFilter,
  type VectorQuery,
  type VectorRecord,
  type VectorRecordKind,
} from '@gitvise/core';
import { CloudflareVectorizeAdapter } from '@gitvise/adapter-cloudflare';
import type { GatewayEnv } from '../env';

/**
 * The `/internal/ports/vector/*` handlers behind apps/api's `CloudVectorMemoryPort`. These only check the wire shape.
 * The adapter enforces the rules: filter well-formedness, the reserved `kind` key, topK, and the payload-filter refusal.
 * Namespaces are passed through unchanged, because the sender scoped them.
 */

const MAX_RECORDS_PER_UPSERT = 500;
const MAX_ID_CHARS = 256;

/** The adapter is cheap to build and has no state of its own. The D1 index and the Vectorize binding are the state. */
function vectors(env: GatewayEnv): CloudflareVectorizeAdapter {
  return new CloudflareVectorizeAdapter(env.VECTORIZE, env.D1);
}

export async function upsertVectors(env: GatewayEnv, body: { records?: unknown }): Promise<number> {
  if (!Array.isArray(body.records)) throw new GitViseError('INVALID_REQUEST', 'records must be an array');
  if (body.records.length > MAX_RECORDS_PER_UPSERT) {
    throw new GitViseError('INVALID_REQUEST', `records must hold at most ${MAX_RECORDS_PER_UPSERT} entries`);
  }
  const records = body.records.map(parseRecord);
  await vectors(env).upsert(records);
  return records.length;
}

export async function queryVectors(env: GatewayEnv, body: unknown) {
  const raw = objectOf(body, 'body');
  const embedding = parseEmbedding(raw['embedding']);
  const matches = await vectors(env).query({
    namespace: requireId(raw['namespace'], 'namespace'),
    embedding: Float32Array.from(embedding),
    topK: raw['topK'] as number,
    ...(raw['kind'] === undefined || raw['kind'] === null ? {} : { kind: parseKind(raw['kind']) }),
    ...(raw['minScore'] === undefined || raw['minScore'] === null ? {} : { minScore: parseMinScore(raw['minScore']) }),
    ...(raw['payload'] === undefined || raw['payload'] === null ? {} : { payload: objectOf(raw['payload'], 'payload') as NonNullable<VectorQuery['payload']> }),
  });
  return { matches };
}

export async function deleteVectors(env: GatewayEnv, body: unknown): Promise<void> {
  await vectors(env).deleteByFilter(parseDeleteFilter(body));
}

/** Shape only. The adapter rejects malformed values, such as an empty `payloadIn` list or an invalid key. */
export function parseDeleteFilter(body: unknown): VectorDeleteFilter {
  const raw = objectOf(body, 'body');
  const kind = raw['kind'] === undefined || raw['kind'] === null ? undefined : parseKind(raw['kind']);
  const payload = raw['payload'] === undefined || raw['payload'] === null ? undefined : objectOf(raw['payload'], 'payload');
  const payloadIn = raw['payloadIn'] === undefined || raw['payloadIn'] === null ? undefined : objectOf(raw['payloadIn'], 'payloadIn');
  return {
    namespace: requireId(raw['namespace'], 'namespace'),
    ...(kind === undefined ? {} : { kind }),
    ...(payload === undefined ? {} : { payload: payload as NonNullable<VectorDeleteFilter['payload']> }),
    ...(payloadIn === undefined ? {} : { payloadIn: payloadIn as NonNullable<VectorDeleteFilter['payloadIn']> }),
  };
}

function parseRecord(value: unknown): VectorRecord {
  const raw = objectOf(value, 'each record');
  return {
    id: requireId(raw['id'], 'records[].id'),
    namespace: requireId(raw['namespace'], 'records[].namespace'),
    kind: parseKind(raw['kind']),
    embedding: Float32Array.from(parseEmbedding(raw['embedding'])),
    payload: objectOf(raw['payload'], 'records[].payload') as VectorRecord['payload'],
  };
}

function parseEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new GitViseError('INVALID_REQUEST', 'embedding must be a non-empty array of finite numbers');
  }
  return value as number[];
}

function parseMinScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GitViseError('INVALID_REQUEST', 'minScore must be a finite number');
  }
  return value;
}

function parseKind(value: unknown): VectorRecordKind {
  if (typeof value !== 'string' || !(VECTOR_RECORD_KINDS as readonly string[]).includes(value)) {
    throw new GitViseError('INVALID_REQUEST', 'kind is not supported');
  }
  return value as VectorRecordKind;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ID_CHARS) {
    throw new GitViseError('INVALID_REQUEST', `${field} must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
  }
  return value;
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitViseError('INVALID_REQUEST', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
