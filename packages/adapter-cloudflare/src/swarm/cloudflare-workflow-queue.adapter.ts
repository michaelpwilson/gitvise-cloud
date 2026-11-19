import {
  GitViseError,
  type JsonValue,
  type SwarmEnqueueResult,
  type SwarmFlowSpec,
  type SwarmQueuePort,
  type SwarmStepStatus,
  type WorktreeMutexLease,
} from '@gitvise/core';
import type { GitViseBindings } from '../bindings';
import { sha256Hex } from '../shared/bytes';
import { errorMessage, upstreamError } from '../shared/errors';
import { MAX_TASK_MESSAGE_BYTES, STEP_SETTLED_EVENT } from './swarm-types';

export type SwarmQueueBindings = Pick<GitViseBindings, 'SWARM_FLOWS' | 'WORKFLOWS' | 'WORKTREE_MUTEX'>;

const MAX_TASKS_PER_FLOW = 256;
const MAX_RESULT_BYTES = 64 * 1024;
const FLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * `SwarmQueuePort` on Cloudflare. A `SwarmFlowState` Durable Object holds each flow's step table,
 * a `SwarmFlowWorkflow` instance drives the DAG, and a `WorktreeMutex` Durable Object per worktree
 * serialises writers. The Queue carries individual step messages and is wired in the gateway.
 */
export class CloudflareWorkflowQueueAdapter implements SwarmQueuePort {
  constructor(private readonly env: SwarmQueueBindings) {}

  async enqueueFlow(flow: SwarmFlowSpec): Promise<SwarmEnqueueResult> {
    validateFlow(flow);
    const outcome = await this.env.SWARM_FLOWS.getByName(flow.flowId).enqueue(flow);
    if (!outcome.ok) throw new GitViseError('CONFLICT', outcome.message);
    // Re-submitting is idempotent. Make sure the instance exists even if an earlier attempt failed to start it.
    await this.ensureWorkflow(flow.flowId, flow.repoId);
    return { created: outcome.created };
  }

  async getStepStatus(flowId: string, taskId: string): Promise<SwarmStepStatus | undefined> {
    return this.env.SWARM_FLOWS.getByName(flowId).status(taskId);
  }

  async compareAndSetStepStatus(
    flowId: string,
    taskId: string,
    expected: SwarmStepStatus,
    next: SwarmStepStatus,
  ): Promise<boolean> {
    const applied = await this.env.SWARM_FLOWS.getByName(flowId).cas(taskId, expected, next);
    if (applied && (next === 'succeeded' || next === 'failed')) {
      await this.signalSettled(flowId, taskId);
    }
    return applied;
  }

  /** Persists a handler's JSON result on its step. Bounded so one step cannot exhaust DO storage. */
  async recordStepResult(flowId: string, taskId: string, result: JsonValue): Promise<void> {
    const encoded = JSON.stringify(result);
    if (new TextEncoder().encode(encoded).byteLength > MAX_RESULT_BYTES) {
      throw new GitViseError('INVALID_REQUEST', `step result exceeds ${MAX_RESULT_BYTES} bytes`);
    }
    const stored = this.env.SWARM_FLOWS.getByName(flowId).setResult(taskId, encoded);
    if (!stored) throw new GitViseError('NOT_FOUND', `step ${flowId}/${taskId} does not exist`);
  }

  /** Reads a step's stored result. `undefined` means the step is unknown; `null` means it has no result yet. */
  async readStepResult(flowId: string, taskId: string): Promise<JsonValue | null | undefined> {
    const encoded = await this.env.SWARM_FLOWS.getByName(flowId).readResult(taskId);
    return encoded === null || encoded === undefined ? encoded : (JSON.parse(encoded) as JsonValue);
  }

  async acquireWorktreeMutex(
    worktreeId: string,
    owner: string,
    ttlMs: number,
  ): Promise<WorktreeMutexLease | undefined> {
    const lease = await this.env.WORKTREE_MUTEX.getByName(worktreeId).acquire(worktreeId, owner, ttlMs);
    return lease ?? undefined;
  }

  async releaseWorktreeMutex(lease: WorktreeMutexLease): Promise<boolean> {
    return this.env.WORKTREE_MUTEX.getByName(lease.worktreeId).release(lease.token);
  }

  private async ensureWorkflow(flowId: string, repoId: string): Promise<void> {
    const id = await workflowInstanceId(flowId);
    try {
      await this.env.WORKFLOWS.create({ id, params: { flowId, repoId } });
    } catch (error) {
      // Creating an instance that already exists is the normal path for a re-submit.
      if (/already exists|duplicate/i.test(errorMessage(error))) return;
      throw upstreamError('starting the swarm workflow failed', error);
    }
  }

  /**
   * Wakes the flow's Workflow. If the instance has already finished, the send fails. That is harmless,
   * since nothing is waiting, so it is logged and not raised.
   */
  private async signalSettled(flowId: string, taskId: string): Promise<void> {
    try {
      const instance = await this.env.WORKFLOWS.get(await workflowInstanceId(flowId));
      await instance.sendEvent({ type: STEP_SETTLED_EVENT, payload: { taskId } });
    } catch (error) {
      console.warn(`swarm flow ${flowId}: no running workflow to notify about ${taskId}: ${errorMessage(error)}`);
    }
  }
}

/** Workflow instance ids are capped at 100 characters, and flow ids may be longer. Hash them. */
export function workflowInstanceId(flowId: string): Promise<string> {
  return sha256Hex(`swarm-flow:${flowId}`);
}

function validateFlow(flow: SwarmFlowSpec): void {
  if (!FLOW_ID_PATTERN.test(flow.flowId)) throw new GitViseError('INVALID_REQUEST', 'flowId is malformed');
  if (flow.tasks.length === 0 || flow.tasks.length > MAX_TASKS_PER_FLOW) {
    throw new GitViseError('INVALID_REQUEST', `a flow needs 1-${MAX_TASKS_PER_FLOW} tasks`);
  }
  const ids = new Set<string>();
  for (const task of flow.tasks) {
    if (!TASK_ID_PATTERN.test(task.taskId)) throw new GitViseError('INVALID_REQUEST', 'taskId is malformed');
    if (ids.has(task.taskId)) throw new GitViseError('INVALID_REQUEST', `duplicate taskId ${task.taskId}`);
    ids.add(task.taskId);
    if (JSON.stringify(task.input).length > MAX_TASK_MESSAGE_BYTES) {
      throw new GitViseError('INVALID_REQUEST', `task ${task.taskId} input exceeds the queue message limit`);
    }
  }
  for (const task of flow.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new GitViseError('INVALID_REQUEST', `task ${task.taskId} depends on unknown ${dep}`);
    }
  }
  assertAcyclic(flow);
}

function assertAcyclic(flow: SwarmFlowSpec): void {
  const deps = new Map(flow.tasks.map((task) => [task.taskId, task.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (taskId: string): void => {
    const current = state.get(taskId);
    if (current === 'done') return;
    if (current === 'visiting') throw new GitViseError('INVALID_REQUEST', `dependency cycle through ${taskId}`);
    state.set(taskId, 'visiting');
    for (const dep of deps.get(taskId) ?? []) visit(dep);
    state.set(taskId, 'done');
  };
  for (const taskId of deps.keys()) visit(taskId);
}
