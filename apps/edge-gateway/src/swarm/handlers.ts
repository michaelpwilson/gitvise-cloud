import {
  SwarmOrchestrator,
  type InferenceEvent,
  type InferenceRequest,
  type InferenceTier,
  type JsonValue,
  type SwarmQueuePort,
} from '@gitvise/core';
import { NonRetryableTaskError, type SwarmTaskHandler, type SwarmTaskMessage } from '@gitvise/adapter-cloudflare';
import { SANDBOX_CAPACITY, SANDBOX_IMAGE, type EdgeServices } from '../composition';
import type { MeteredInferenceDecorator } from '../billing/metered-inference';
import { CreditExhaustedError } from '../billing/errors';
import { commitPatch } from './commit-patch';
import { childFlowFor, MAX_PATCH_CHARS, parsePlanText, PLAN_SCHEMA, rejectInvalidFlow, validatePlan } from './plan-dag';

/**
 * Baseline executors for swarm steps. Each one validates its input, then dispatches into the engine, the sandbox,
 * or the metered inference path. It returns a JSON result that is stored on the step.
 *
 * Every LLM call is metered. Handlers bill the `orgId` stamped into their input when the flow was submitted. That
 * stamp is set by the route from the caller's API key, so a flow cannot name another org to bill.
 */

export const BASELINE_TASK_QUEUES = ['plan-dag', 'sandbox-exec', 'debate-critique', 'commit-patch'] as const;

/** The services a handler uses. `EdgeServices` satisfies this; tests pass fakes for the parts they exercise. */
export type HandlerServices = Pick<EdgeServices, 'engine' | 'sandbox' | 'snapshots' | 'blobs' | 'metered'> & {
  readonly swarmQueue: SwarmQueuePort;
};

const MAX_PROMPT_CHARS = 16_000;
const MAX_STDOUT_CHARS = 8_000;
const SANDBOX_MEMORY_MIB = 1024;
const SANDBOX_VCPUS = 1;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const PLAN_SYSTEM_PROMPT =
  'You are the planner for a software change. Break the goal into a short, ordered DAG of steps. Reply with one JSON ' +
  'object and nothing else, matching this schema exactly. Every dependsOn entry must name an id in steps. The graph ' +
  `must not contain cycles.\n\n${PLAN_SCHEMA}`;
const CRITIC_SYSTEM_PROMPT =
  'You are a critic in a design debate. Find the strongest concrete flaw in the proposal and say what would fix it. ' +
  'Be brief. Plain text.';

export function createBaselineHandlers(services: HandlerServices): Record<string, SwarmTaskHandler> {
  return {
    'plan-dag': async (task) => {
      const orgId = idField(task, 'orgId');
      const repoId = idField(task, 'repoId');
      const commitHash = shaField(task, 'commitHash');
      const goal = textField(task, 'goal', MAX_PROMPT_CHARS);

      const reply = await complete(services.metered, task, orgId, {
        tier: 'architect-30b',
        maxOutputTokens: 2_048,
        temperature: 0.2,
        messages: [
          { role: 'system', content: PLAN_SYSTEM_PROMPT },
          { role: 'user', content: goal },
        ],
      });

      // Parse, check the schema, then build the child flow. The flow's cycle check and its enqueue both run in
      // core's orchestrator, which rejects a cyclic plan before anything is queued.
      const plan = validatePlan(parsePlanText(reply));
      const spec = await childFlowFor(
        { parentFlowId: task.flowId, parentTaskId: task.taskId, orgId, repoId, commitHash },
        plan,
      );
      try {
        const outcome = await new SwarmOrchestrator(services.swarmQueue).submitFlow(spec);
        return { childFlowId: spec.flowId, steps: plan.steps.length, created: outcome.created, order: [...outcome.order] };
      } catch (error) {
        return rejectInvalidFlow(error);
      }
    },

    'sandbox-exec': async (task) => {
      const repoId = idField(task, 'repoId');
      const commitHash = shaField(task, 'commitHash');
      const command = argvField(task, 'command');
      const timeoutMs = timeoutField(task, 60_000);

      const result = await services.engine.sandbox.run({
        repoId,
        commitHash,
        sandbox: { image: SANDBOX_IMAGE, vcpus: SANDBOX_VCPUS, memoryMiB: SANDBOX_MEMORY_MIB, network: 'none' },
        command,
        timeoutMs,
        env: {},
      });
      if (result.exitCode !== 0) {
        // Failing commands are final: a retry would run the same command against the same commit.
        throw new NonRetryableTaskError(
          `command exited with ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}: ${result.stderr.slice(0, 500)}`,
        );
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, MAX_STDOUT_CHARS),
        durationMs: result.durationMs,
      };
    },

    'debate-critique': async (task) => {
      const orgId = idField(task, 'orgId');
      const proposal = textField(task, 'proposal', MAX_PROMPT_CHARS);
      const critique = await complete(services.metered, task, orgId, {
        tier: 'worker-7b',
        maxOutputTokens: 1_024,
        temperature: 0.3,
        messages: [
          { role: 'system', content: CRITIC_SYSTEM_PROMPT },
          { role: 'user', content: proposal },
        ],
      });
      return { critique };
    },

    'commit-patch': async (task) => {
      const repoId = idField(task, 'repoId');
      const commitHash = shaField(task, 'commitHash');
      const patch = textField(task, 'patch', MAX_PATCH_CHARS);

      const outcome = await commitPatch(
        {
          sandbox: services.sandbox,
          blobs: services.blobs,
          snapshots: services.snapshots,
          sandboxImage: SANDBOX_IMAGE,
          sandboxVcpus: SANDBOX_CAPACITY.vcpus,
          sandboxMemoryMiB: SANDBOX_MEMORY_MIB,
        },
        { repoId, commitHash, patch, label: task.taskId },
      );
      return {
        applies: true,
        persisted: true,
        commitHash: outcome.commitHash,
        parentHash: outcome.parentHash,
        packSha256: outcome.packSha256,
        packBytes: outcome.packBytes,
        snapshot: outcome.snapshot,
      };
    },
  };
}

/**
 * Runs a metered completion and returns the full text.
 *
 * The request id includes a fresh random part for each attempt. A retry is a new call that consumes tokens, so it
 * must be billed. Reusing the task id would make every retry settle as a duplicate and cost nothing. Duplicate
 * deliveries of one attempt are still bounded: the step only succeeds once.
 */
async function complete(
  metered: MeteredInferenceDecorator,
  task: SwarmTaskMessage,
  orgId: string,
  call: {
    readonly tier: InferenceTier;
    readonly messages: InferenceRequest['messages'];
    readonly maxOutputTokens: number;
    readonly temperature: number;
  },
): Promise<string> {
  const request: InferenceRequest = {
    requestId: `${task.flowId}:${task.taskId}:${crypto.randomUUID()}`,
    tier: call.tier,
    messages: call.messages,
    maxOutputTokens: call.maxOutputTokens,
    temperature: call.temperature,
  };
  let stream: ReadableStream<InferenceEvent>;
  try {
    stream = await metered.open(request, { orgId, userId: `swarm:${task.flowId}` });
  } catch (error) {
    // Out of credit does not clear by retrying, so it fails the step at once rather than burning attempts.
    if (error instanceof CreditExhaustedError) throw new NonRetryableTaskError('organisation has no remaining credit');
    throw error;
  }
  let text = '';
  for await (const event of readable(stream)) {
    if (event.type === 'token') text += event.text;
  }
  return text;
}

/** Async iteration over a ReadableStream, which the Workers runtime supports directly. */
async function* readable<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function field(task: SwarmTaskMessage, key: string): JsonValue {
  const value = task.input[key];
  if (value === undefined) throw new NonRetryableTaskError(`input.${key} is required`);
  return value;
}

function idField(task: SwarmTaskMessage, key: string): string {
  const value = field(task, key);
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new NonRetryableTaskError(`input.${key} must be an identifier`);
  }
  return value;
}

function shaField(task: SwarmTaskMessage, key: string): string {
  const value = field(task, key);
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new NonRetryableTaskError(`input.${key} must be a full git object id`);
  }
  return value;
}

function textField(task: SwarmTaskMessage, key: string, maxLength: number): string {
  const value = field(task, key);
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new NonRetryableTaskError(`input.${key} must be non-empty text of at most ${maxLength} characters`);
  }
  return value;
}

function argvField(task: SwarmTaskMessage, key: string): string[] {
  const value = field(task, key);
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || !value.every((item) => typeof item === 'string')) {
    throw new NonRetryableTaskError(`input.${key} must be an array of 1-64 strings`);
  }
  return value as string[];
}

function timeoutField(task: SwarmTaskMessage, fallback: number): number {
  const value = task.input['timeoutMs'];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000 || value > 600_000) {
    throw new NonRetryableTaskError('input.timeoutMs must be an integer from 1000 to 600000');
  }
  return value;
}
