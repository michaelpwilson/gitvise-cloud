// Adapters: one per @gitvise/core port.
export {
  CloudflareContainerSandboxAdapter,
  type CommitSnapshotLocator,
  type ContainerSandboxLease,
  type ContainerSandboxOptions,
  type LeaseDescriptor,
} from './sandbox/cloudflare-container-sandbox.adapter';
export { CloudflareWorkflowQueueAdapter, workflowInstanceId, type SwarmQueueBindings } from './swarm/cloudflare-workflow-queue.adapter';
export { CloudflareDurableRealtimeAdapter } from './realtime/cloudflare-durable-realtime.adapter';
export { CloudflareVectorizeAdapter } from './memory/cloudflare-vectorize.adapter';
export { CloudflareR2BlobStorageAdapter } from './blob/cloudflare-r2-blob.adapter';
export {
  CloudflareWorkersAiInferenceAdapter,
  DEFAULT_FALLBACK_ABOVE_TOKENS,
  estimateTokens,
  type CloudflareInferenceOptions,
  type ExternalFallback,
} from './inference/cloudflare-workers-ai.adapter';

// Queue consumer for swarm step messages.
export {
  createSwarmTaskConsumer,
  NonRetryableTaskError,
  type SwarmTaskConsumerOptions,
  type SwarmTaskHandler,
} from './swarm/swarm-task-consumer';

// Workflow and message types.
export { SwarmFlowWorkflow, type SwarmFlowEnv } from './swarm/swarm-flow.workflow';
export {
  MAX_TASK_MESSAGE_BYTES,
  STEP_SETTLED_EVENT,
  type ReadyStep,
  type SwarmFlowParams,
  type SwarmTaskMessage,
} from './swarm/swarm-types';

// Durable Object classes. The Worker entry point must re-export each of these by name.
export { GitViseSandbox, SANDBOX_AGENT_PORT } from './sandbox/sandbox-container';
export { SwarmFlowState } from './swarm/swarm-flow-state';
export { WorktreeMutex } from './swarm/worktree-mutex';
export { RealtimeRoom, type RoomFrame } from './realtime/realtime-room';

export type { GitViseBindings } from './bindings';

// Byte helpers the gateway needs for HTTP and WebSocket framing.
export { fromBase64, toBase64 } from './shared/bytes';
