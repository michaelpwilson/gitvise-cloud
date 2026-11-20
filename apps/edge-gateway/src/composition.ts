import { GitViseEngine, type BlobRef, type BlobKind, type InferenceTier } from '@gitvise/core';
import {
  CloudflareContainerSandboxAdapter,
  CloudflareDurableRealtimeAdapter,
  CloudflareR2BlobStorageAdapter,
  CloudflareVectorizeAdapter,
  CloudflareWorkersAiInferenceAdapter,
  CloudflareWorkflowQueueAdapter,
  type CommitSnapshotLocator,
  type ExternalFallback,
} from '@gitvise/adapter-cloudflare';
import type { GatewayEnv } from './env';
import { DirectInferenceDisabled, MeteredInferenceDecorator } from './billing/metered-inference';
import { recordUsage } from './billing/ledger';

/** The one sandbox image this deployment builds (see ./Dockerfile). */
export const SANDBOX_IMAGE = 'gitvise-sandbox';

/**
 * Size of the container instance type in wrangler.jsonc. `standard-2` is 1 vCPU and 6 GiB.
 * Requests above it are refused, because the platform sizes containers per app, not per lease.
 */
export const SANDBOX_CAPACITY = { vcpus: 1, memoryMiB: 6144 } as const;

export interface EdgeServices {
  /** The engine for every port except inference. Its inference port refuses direct calls. */
  readonly engine: GitViseEngine;
  readonly sandbox: CloudflareContainerSandboxAdapter;
  readonly swarmQueue: CloudflareWorkflowQueueAdapter;
  readonly snapshots: D1CommitSnapshots;
  readonly blobs: CloudflareR2BlobStorageAdapter;
  /** The only way to run inference. Every call reserves credit and settles it on the final usage event. */
  readonly metered: MeteredInferenceDecorator;
  /** The room adapter itself, with agent events. The engine's realtime service wraps it and omits those. */
  readonly realtime: CloudflareDurableRealtimeAdapter;
}

/**
 * Composition root for the gateway. Every core port is built from Cloudflare bindings here, so the
 * routes below only ever talk to `GitViseEngine` or the metered decorator. Cheap enough to build per request.
 */
export function createEdgeServices(env: GatewayEnv): EdgeServices {
  const blobs = new CloudflareR2BlobStorageAdapter(env.R2);
  const snapshots = new D1CommitSnapshots(env.D1);
  const sandbox = new CloudflareContainerSandboxAdapter({
    containers: env.CONTAINERS,
    image: SANDBOX_IMAGE,
    capacity: SANDBOX_CAPACITY,
    snapshots,
    blobs,
  });
  const swarmQueue = new CloudflareWorkflowQueueAdapter(env);

  const fallback = externalFallback(env);
  const models: { readonly [tier in InferenceTier]?: string | undefined } = {
    'fast-3b': env.AI_MODEL_FAST_3B,
    'worker-7b': env.AI_MODEL_WORKER_7B,
    'architect-30b': env.AI_MODEL_ARCHITECT_30B,
  };
  const embeddingModel = env.AI_MODEL_EMBED;
  const rawInference = new CloudflareWorkersAiInferenceAdapter({
    ai: env.AI,
    models,
    embeddingModel,
    fallback,
  });

  const metered = new MeteredInferenceDecorator({
    inner: rawInference,
    guards: env.BILLING_GUARD,
    externalFallbackConfigured: fallback !== undefined,
    describeModel: (tier, external) => (external ? `external:${fallback?.model ?? ''}` : (models[tier] ?? tier)),
    embeddingModel,
    onSettled: (record) => recordUsage(env.D1, record),
  });

  const realtime = new CloudflareDurableRealtimeAdapter(env.REALTIME_ROOMS);
  const engine = new GitViseEngine({
    sandbox,
    swarmQueue,
    realtime,
    vectorMemory: new CloudflareVectorizeAdapter(env.VECTORIZE, env.D1),
    blobStorage: blobs,
    inference: new DirectInferenceDisabled(rawInference),
  });

  return { engine, sandbox, swarmQueue, snapshots, blobs, metered, realtime };
}

function externalFallback(env: GatewayEnv): ExternalFallback | undefined {
  const baseUrl = (env.ARCHITECT_FALLBACK_URL ?? '').trim();
  if (baseUrl === '') return undefined;
  const model = (env.ARCHITECT_FALLBACK_MODEL ?? '').trim();
  if (model === '') {
    throw new Error('ARCHITECT_FALLBACK_MODEL must be set when ARCHITECT_FALLBACK_URL is set');
  }
  return { baseUrl, model, apiKey: env.ARCHITECT_FALLBACK_API_KEY };
}

/**
 * Commit-to-packfile index on D1, with each commit's parent. Snapshots are immutable: a commit maps to one packfile,
 * forever.
 */
export class D1CommitSnapshots implements CommitSnapshotLocator {
  constructor(private readonly db: D1Database) {}

  async locate(repoId: string, commitHash: string): Promise<BlobRef | undefined> {
    const row = await this.db
      .prepare('SELECT blob_sha256 FROM commit_snapshots WHERE repo_id = ?1 AND commit_hash = ?2')
      .bind(repoId, commitHash)
      .first<{ blob_sha256: string }>();
    if (row === null) return undefined;
    const kind: BlobKind = 'packfile';
    return { kind, sha256: row.blob_sha256 };
  }

  /**
   * Records the mapping. Re-recording the same packfile is fine; pointing a commit elsewhere is a conflict.
   * `parentHash` is the commit this one was built on, or null for a root commit.
   */
  async record(
    repoId: string,
    commitHash: string,
    sha256: string,
    parentHash: string | null = null,
  ): Promise<'created' | 'unchanged'> {
    const result = await this.db
      .prepare(
        `INSERT INTO commit_snapshots (repo_id, commit_hash, blob_sha256, parent_hash)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (repo_id, commit_hash) DO NOTHING`,
      )
      .bind(repoId, commitHash, sha256, parentHash)
      .run();
    if (result.meta.changes > 0) return 'created';

    const existing = await this.locate(repoId, commitHash);
    if (existing?.sha256 !== sha256) {
      throw new CommitSnapshotConflict(repoId, commitHash);
    }
    return 'unchanged';
  }
}

export class CommitSnapshotConflict extends Error {
  constructor(repoId: string, commitHash: string) {
    super(`commit ${commitHash} in ${repoId} already has a different snapshot`);
    this.name = 'CommitSnapshotConflict';
  }
}
