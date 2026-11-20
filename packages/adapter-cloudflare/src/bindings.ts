import type { GitViseSandbox } from './sandbox/sandbox-container';
import type { RealtimeRoom } from './realtime/realtime-room';
import type { SwarmFlowState } from './swarm/swarm-flow-state';
import type { WorktreeMutex } from './swarm/worktree-mutex';
import type { SwarmFlowParams, SwarmTaskMessage } from './swarm/swarm-types';

/**
 * Bindings the adapters read from. The edge gateway's generated `Env` satisfies
 * this structurally, so adapters never depend on generated wrangler types.
 */
export interface GitViseBindings {
  /** Workers AI binding. */
  readonly AI: Ai;
  /** R2 bucket holding content-addressed blobs (packfiles, LFS objects). */
  readonly R2: R2Bucket;
  /** Vectorize index for cross-agent trajectory memory. */
  readonly VECTORIZE: VectorizeIndex;
  /** Workflow running one instance per swarm flow. */
  readonly WORKFLOWS: Workflow<SwarmFlowParams>;
  /** Queue carrying individual swarm task messages. */
  readonly QUEUES: Queue<SwarmTaskMessage>;
  /** Container-backed sandbox Durable Objects, one per lease. */
  readonly CONTAINERS: DurableObjectNamespace<GitViseSandbox>;
  /** Flow state, one Durable Object per flow id. */
  readonly SWARM_FLOWS: DurableObjectNamespace<SwarmFlowState>;
  /** Worktree mutexes, one Durable Object per worktree id. */
  readonly WORKTREE_MUTEX: DurableObjectNamespace<WorktreeMutex>;
  /** Realtime rooms, one Durable Object per room. */
  readonly REALTIME_ROOMS: DurableObjectNamespace<RealtimeRoom>;

  /** Workers AI model used for the `fast-3b` tier. */
  readonly AI_MODEL_FAST_3B?: string;
  /** Workers AI model used for the `worker-7b` tier. */
  readonly AI_MODEL_WORKER_7B?: string;
  /** Workers AI model used for the `architect-30b` tier. */
  readonly AI_MODEL_ARCHITECT_30B?: string;
  /** Workers AI embedding model. Its output width must match the Vectorize index (1024 for bge-large). */
  readonly AI_MODEL_EMBED?: string;
  /** Optional external OpenAI-compatible endpoint for long architect prompts. Empty disables it. */
  readonly ARCHITECT_FALLBACK_URL?: string;
  readonly ARCHITECT_FALLBACK_MODEL?: string;
  /** Secret. Set with `wrangler secret put ARCHITECT_FALLBACK_API_KEY`. */
  readonly ARCHITECT_FALLBACK_API_KEY?: string;
}
