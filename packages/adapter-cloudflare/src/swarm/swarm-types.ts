import type { JsonValue } from '@gitvise/core';

/** Workflow params. One Workflow instance drives one flow. */
export interface SwarmFlowParams {
  readonly flowId: string;
  readonly repoId: string;
}

/** Message placed on the task queue for one ready step. */
export interface SwarmTaskMessage {
  readonly flowId: string;
  readonly taskId: string;
  readonly queue: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

/**
 * A step whose dependencies have all succeeded and which is still queued. `inputJson` stays a string
 * so Workflow step results remain simple, serialisable values.
 */
export interface ReadyStep {
  readonly taskId: string;
  readonly queue: string;
  readonly inputJson: string;
}

/** Event the Workflow waits for. Sent each time a step reaches a terminal status. */
export const STEP_SETTLED_EVENT = 'step-settled';

/** Queue messages are capped at 128 KB by the platform. Stay under it with headroom. */
export const MAX_TASK_MESSAGE_BYTES = 120 * 1024;

export type FlowEnqueueOutcome =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly code: 'CONFLICT'; readonly message: string };
