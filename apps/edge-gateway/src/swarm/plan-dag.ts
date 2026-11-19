import { GitViseError, type JsonValue, type SwarmFlowSpec } from '@gitvise/core';
import { NonRetryableTaskError } from '@gitvise/adapter-cloudflare';
import { sha256Hex } from '../crypto';

/**
 * Turns a planner's reply into a DAG of swarm steps. The reply is untrusted model output. It is parsed, checked
 * against the schema below, checked for cycles by core's `planSwarmFlow`, and only then enqueued. Anything that
 * fails is a non-retryable task failure, because asking the same model again is not a reliable fix.
 *
 * Child steps are not chained to each other's output. Each one runs against the parent's base commit. A patch step
 * that needs an earlier patch's result is not expressible yet, and the validator does not pretend otherwise.
 */

export const PLAN_STEP_TYPES = ['sandbox-exec', 'debate-critique', 'commit-patch'] as const;
export type PlanStepType = (typeof PLAN_STEP_TYPES)[number];

export const MAX_PLAN_STEPS = 32;
/** Core caps a flow's serialised input at 96 KiB, so a single patch step must stay well under that. */
export const MAX_PATCH_CHARS = 64 * 1024;
const MAX_PROMPT_CHARS = 16_000;
const MAX_ARGV = 64;
const MAX_ARG_CHARS = 4_096;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface PlanStep {
  readonly id: string;
  readonly type: PlanStepType;
  readonly dependsOn: readonly string[];
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface PlanDocument {
  readonly steps: readonly PlanStep[];
}

/** The shape the planner is asked for. Shown to the model verbatim, so it matches what the validator accepts. */
export const PLAN_SCHEMA = `{
  "steps": [
    {
      "id": "short-id",
      "type": "sandbox-exec" | "debate-critique" | "commit-patch",
      "dependsOn": ["ids of steps that must finish first"],
      "payload": {
        "sandbox-exec": { "command": ["argv", "..."], "timeoutMs": 60000 },
        "debate-critique": { "proposal": "text to critique" },
        "commit-patch": { "patch": "a unified diff against the base commit" }
      }[type]
    }
  ]
}`;

/** Parses the model's reply. Accepts a bare JSON object or one inside a single code fence. */
export function parsePlanText(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  const body = fenced?.[1] ?? text;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new NonRetryableTaskError('planner reply is not valid JSON');
  }
}

/** Checks the parsed reply against the schema. Returns a typed plan or throws a non-retryable failure. */
export function validatePlan(value: unknown): PlanDocument {
  if (!isObject(value) || !Array.isArray(value['steps'])) {
    throw new NonRetryableTaskError('planner reply must be an object with a steps array');
  }
  const raw = value['steps'];
  if (raw.length < 1 || raw.length > MAX_PLAN_STEPS) {
    throw new NonRetryableTaskError(`plan must have 1-${MAX_PLAN_STEPS} steps`);
  }

  const ids = new Set<string>();
  const steps: PlanStep[] = raw.map((entry: unknown, index: number) => {
    const where = `steps[${index}]`;
    if (!isObject(entry)) throw new NonRetryableTaskError(`${where} must be an object`);
    const id = entry['id'];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new NonRetryableTaskError(`${where}.id is not a valid identifier`);
    if (ids.has(id)) throw new NonRetryableTaskError(`step id ${id} is used more than once`);
    ids.add(id);

    const type = entry['type'];
    if (typeof type !== 'string' || !(PLAN_STEP_TYPES as readonly string[]).includes(type)) {
      throw new NonRetryableTaskError(`${where}.type must be one of ${PLAN_STEP_TYPES.join(', ')}`);
    }

    const dependsOn = entry['dependsOn'];
    if (!Array.isArray(dependsOn) || !dependsOn.every((item) => typeof item === 'string')) {
      throw new NonRetryableTaskError(`${where}.dependsOn must be an array of step ids`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new NonRetryableTaskError(`${where}.dependsOn lists a step twice`);
    if (dependsOn.includes(id)) throw new NonRetryableTaskError(`step ${id} depends on itself`);

    const payload = entry['payload'];
    if (!isObject(payload)) throw new NonRetryableTaskError(`${where}.payload must be an object`);

    return { id, type: type as PlanStepType, dependsOn: dependsOn as string[], payload: checkPayload(type as PlanStepType, payload, where) };
  });

  // Dependencies must name steps in this plan. Cycles are checked later by core, once the flow is built.
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new NonRetryableTaskError(`step ${step.id} depends on unknown step ${dependency}`);
    }
  }
  return { steps };
}

/** Accepts only the keys each step type uses, and checks each one's size and shape. */
function checkPayload(type: PlanStepType, payload: Record<string, unknown>, where: string): Record<string, JsonValue> {
  const allowed: Readonly<Record<PlanStepType, readonly string[]>> = {
    'sandbox-exec': ['command', 'timeoutMs'],
    'debate-critique': ['proposal'],
    'commit-patch': ['patch'],
  };
  for (const key of Object.keys(payload)) {
    if (!allowed[type].includes(key)) throw new NonRetryableTaskError(`${where}.payload.${key} is not allowed for ${type}`);
  }

  if (type === 'sandbox-exec') {
    const command = payload['command'];
    if (!Array.isArray(command) || command.length < 1 || command.length > MAX_ARGV) {
      throw new NonRetryableTaskError(`${where}.payload.command must be an array of 1-${MAX_ARGV} strings`);
    }
    for (const arg of command) {
      if (typeof arg !== 'string' || arg.length > MAX_ARG_CHARS || arg.includes('\0')) {
        throw new NonRetryableTaskError(`${where}.payload.command has an invalid argument`);
      }
    }
    const timeoutMs = payload['timeoutMs'];
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) {
      throw new NonRetryableTaskError(`${where}.payload.timeoutMs must be an integer from 1000 to 600000`);
    }
    return timeoutMs === undefined ? { command: command as string[] } : { command: command as string[], timeoutMs };
  }

  if (type === 'debate-critique') {
    const proposal = payload['proposal'];
    if (typeof proposal !== 'string' || proposal.trim() === '' || proposal.length > MAX_PROMPT_CHARS) {
      throw new NonRetryableTaskError(`${where}.payload.proposal must be text of at most ${MAX_PROMPT_CHARS} characters`);
    }
    return { proposal };
  }

  const patch = payload['patch'];
  if (typeof patch !== 'string' || patch.trim() === '' || patch.length > MAX_PATCH_CHARS) {
    throw new NonRetryableTaskError(`${where}.payload.patch must be a diff of at most ${MAX_PATCH_CHARS} characters`);
  }
  return { patch };
}

export interface ChildFlowContext {
  /** The parent flow's id. Already scoped to the org by the route that created it. */
  readonly parentFlowId: string;
  /** The parent step, which becomes part of the child flow id so the id is deterministic. */
  readonly parentTaskId: string;
  readonly orgId: string;
  readonly repoId: string;
  readonly commitHash: string;
}

/**
 * Builds the child flow. Each step's input is assembled here from trusted values (org, repo, base commit) plus the
 * validated payload. Nothing the model wrote can set `orgId` or `repoId`.
 */
export async function childFlowFor(context: ChildFlowContext, plan: PlanDocument): Promise<SwarmFlowSpec> {
  const flowId = `plan-${(await sha256Hex(`${context.parentFlowId}:${context.parentTaskId}`)).slice(0, 40)}`;
  const tasks = plan.steps.map((step) => {
    const input: Record<string, JsonValue> = { ...step.payload, orgId: context.orgId, repoId: context.repoId };
    if (step.type !== 'debate-critique') input['commitHash'] = context.commitHash;
    return { taskId: step.id, queue: step.type, dependsOn: [...step.dependsOn], input };
  });
  const unsigned = { flowId, repoId: context.repoId, tasks };
  const specHash = await sha256Hex(JSON.stringify(unsigned));
  return { ...unsigned, specHash };
}

/** Maps core's validation errors into non-retryable task failures, so a rejected plan fails once and says why. */
export function rejectInvalidFlow(error: unknown): never {
  if (error instanceof GitViseError && (error.code === 'INVALID_REQUEST' || error.code === 'CONFLICT')) {
    throw new NonRetryableTaskError(`plan rejected: ${error.message}`);
  }
  throw error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
