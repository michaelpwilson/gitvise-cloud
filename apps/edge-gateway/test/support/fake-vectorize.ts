/**
 * In-memory stand-in for the Vectorize binding. The test Worker does not bind Vectorize, and tests must not touch
 * a remote index. It implements the calls the gateway makes: upsert, query, and deleteByIds. Every delete is recorded,
 * so a test can assert exactly which ids were removed.
 */
export interface StoredVector {
  readonly id: string;
  readonly values: number[];
  readonly namespace?: string;
  readonly metadata: Record<string, unknown>;
}

export interface FakeVectorize {
  readonly vectors: Map<string, StoredVector>;
  /** Every deleteByIds call, in order. */
  readonly deletes: string[][];
  /** When set, the next deleteByIds call throws this message. Cleared after one use. */
  failNextDelete: string | undefined;
  upsert(vectors: StoredVector[]): Promise<{ mutationId: string }>;
  query(
    values: number[],
    options: { topK: number; namespace?: string; filter?: Record<string, unknown>; returnMetadata?: unknown },
  ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> | undefined; namespace?: string | undefined }> }>;
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
}

export function fakeVectorize(): FakeVectorize {
  const vectors = new Map<string, StoredVector>();
  const deletes: string[][] = [];
  const fake: FakeVectorize = {
    vectors,
    deletes,
    failNextDelete: undefined,
    async upsert(batch) {
      for (const vector of batch) vectors.set(vector.id, vector);
      return { mutationId: `up-${batch.length}` };
    },
    async query(values, options) {
      const matches = [...vectors.values()]
        .filter((vector) => options.namespace === undefined || vector.namespace === options.namespace)
        .filter((vector) =>
          Object.entries(options.filter ?? {}).every(([key, value]) => vector.metadata[key] === value),
        )
        .map((vector) => ({
          id: vector.id,
          score: cosine(values, vector.values),
          namespace: vector.namespace,
          metadata: vector.metadata,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { matches };
    },
    async deleteByIds(ids) {
      deletes.push([...ids]);
      if (fake.failNextDelete !== undefined) {
        const message = fake.failNextDelete;
        fake.failNextDelete = undefined;
        throw new Error(message);
      }
      for (const id of ids) vectors.delete(id);
      return { mutationId: `del-${ids.length}` };
    },
  };
  return fake;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
