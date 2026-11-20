import type { GatewayEnv } from '../env';
import { API_CONTAINER_INSTANCE } from '../api-container';
import { invalid, objectBody, stringField } from '../internal/validate';
import { signedInternalHeaders } from '../internal/outbound';
import { API_JOBS_QUEUE, type ApiJobMessage, type DeliveryStatus } from './api-job-message';

export { API_JOBS_QUEUE };

/**
 * The job path between apps/api and the gateway's Queue. The gateway holds three kinds of state, all in per-key
 * Durable Objects (see src/kv/gateway-kv-entry.ts):
 *
 *  - a claim per jobId, so a repeated submit cannot enqueue the same job twice (409 to the caller);
 *  - a done marker per delivered job, so a redelivered message is acked without running the processor again;
 *  - an in-flight claim per job, so two consumers cannot deliver the same job at once.
 *
 * Flows add a pending counter per parent. Each child that completes decrements its parent's counter once, and the
 * parent is enqueued when the counter reaches zero. A retried child therefore never counts twice.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a jobId is remembered. Matches the retention apps/api gives completed jobs. */
const CLAIM_TTL_MS = 30 * DAY_MS;
/** How long a delivery claim holds. Longer than the delivery timeout, so an expired claim cannot start a second run. */
const INFLIGHT_TTL_MS = 10 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 9 * 60 * 1000;
const DELIVERY_PATH = '/internal/queues/deliver';
/** Origin for a container request. The container ignores it, so only the path matters. */
const CONTAINER_ORIGIN = 'http://api-container';
const MAX_DELAY_SECONDS = 12 * 60 * 60;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;
const MAX_FLOW_NODES = 500;
const MAX_FLOW_DEPTH = 32;

export interface EnqueueJobInput {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId?: string | undefined;
  readonly data: unknown;
  readonly delayMs?: number | undefined;
  readonly attempts?: number | undefined;
}

export interface EnqueueOutcome {
  readonly id: string;
  readonly created: boolean;
}

/** A node of a flow tree, as apps/api posts it. Children run before their parent. */
export interface FlowNodeInput {
  readonly name: string;
  readonly queueName: string;
  readonly data: Record<string, unknown>;
  readonly jobId: string;
  readonly attempts: number;
  readonly children: readonly FlowNodeInput[];
}

export async function enqueueJob(env: GatewayEnv, input: EnqueueJobInput): Promise<EnqueueOutcome> {
  const jobId = input.jobId ?? `${input.queue}:${crypto.randomUUID()}`;
  const claim = claimKey(input.queue, jobId);
  if (!(await entry(env, claim).put('1', { ifAbsent: true, ttlMs: CLAIM_TTL_MS }))) {
    return { id: jobId, created: false };
  }
  const message: ApiJobMessage = {
    queue: input.queue,
    jobName: input.jobName,
    jobId,
    data: input.data,
    maxAttempts: input.attempts ?? 1,
  };
  try {
    await env.API_JOBS.send(message, { delaySeconds: delaySeconds(input.delayMs) });
  } catch (error) {
    // The message never reached the queue, so the claim must not block a later, correct submit.
    await entry(env, claim).delete();
    throw error;
  }
  return { id: jobId, created: true };
}

/**
 * Enqueues a whole flow tree. Every node's claim is taken first, so a repeated submit is refused before anything is
 * written. Parents are recorded before any leaf is sent, so a fast completion always finds the record it needs.
 *
 * A failure after the first send is not rolled back. Undoing the claims would let a retry re-send leaves that
 * already ran. The caller should treat a 5xx on a flow submit as an unknown outcome and submit under new job ids.
 */
export async function enqueueFlow(env: GatewayEnv, root: FlowNodeInput): Promise<EnqueueOutcome> {
  const planned: PlannedNode[] = [];
  flatten(root, undefined, 0, planned);
  const unique = new Set(planned.map((node) => claimKey(node.message.queue, node.message.jobId)));
  if (unique.size !== planned.length) throw invalid('flow job ids must be unique');

  const claimed: string[] = [];
  for (const node of planned) {
    const key = claimKey(node.message.queue, node.message.jobId);
    if (!(await entry(env, key).put('1', { ifAbsent: true, ttlMs: CLAIM_TTL_MS }))) {
      await Promise.all(claimed.map((taken) => entry(env, taken).delete()));
      return { id: root.jobId, created: false };
    }
    claimed.push(key);
  }

  for (const node of planned) {
    if (node.childCount === 0) continue;
    const jobId = node.message.jobId;
    await entry(env, nodeKey(jobId)).put(JSON.stringify(node.message), { ttlMs: CLAIM_TTL_MS });
    await entry(env, pendingKey(jobId)).put(String(node.childCount), { ttlMs: CLAIM_TTL_MS });
  }
  for (const node of planned) {
    if (node.childCount > 0) continue;
    await env.API_JOBS.send(node.message, { delaySeconds: 0 });
  }
  return { id: root.jobId, created: true };
}

/**
 * Consumer for `gitvise-api-jobs`. Each message is delivered once to the apps/api container, and redelivery is
 * absorbed by the done marker. A message is acked when it is settled (completed, failed past its attempts, or
 * unrecoverable). Anything else is retried under the queue's policy.
 */
export async function deliverApiJobs(batch: MessageBatch<ApiJobMessage>, env: GatewayEnv): Promise<void> {
  for (const message of batch.messages) {
    await deliverOne(message, env);
  }
}

async function deliverOne(message: Message<ApiJobMessage>, env: GatewayEnv): Promise<void> {
  const job = message.body;
  const settled = await entry(env, doneKey(job.jobId)).get();
  if (settled !== undefined) {
    // Already settled. A completed job may still owe its flow parent a count if the earlier run stopped before that.
    if (settled === 'completed') await progressFlow(env, job);
    message.ack();
    return;
  }

  const inflight = inflightKey(job.jobId);
  if (!(await entry(env, inflight).put('1', { ifAbsent: true, ttlMs: INFLIGHT_TTL_MS }))) {
    message.retry({ delaySeconds: 30 });
    return;
  }
  try {
    const status = await deliver(env, job, message.attempts - 1);
    if (status === 'no-processor') {
      message.retry({ delaySeconds: MAX_RETRY_DELAY_SECONDS });
      return;
    }
    await entry(env, doneKey(job.jobId)).put(status, { ttlMs: CLAIM_TTL_MS });
    if (status === 'completed') await progressFlow(env, job);
    message.ack();
  } catch (error: unknown) {
    if (error instanceof ProcessorFailed && message.attempts >= job.maxAttempts) {
      // The processor threw on its last allowed attempt. Record the failure and stop, as BullMQ does.
      await entry(env, doneKey(job.jobId)).put('failed', { ttlMs: CLAIM_TTL_MS });
      message.ack();
      return;
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  } finally {
    await entry(env, inflight).delete().catch(() => false);
  }
}

/**
 * POSTs one job to apps/api, through the `GitViseApiContainer` binding. Resolves with the status the container
 * reports. Throws `ProcessorFailed` when the processor threw (a 5xx), and `TransportFailed` for everything else,
 * which does not count as an attempt.
 */
async function deliver(env: GatewayEnv, job: ApiJobMessage, attemptsMade: number): Promise<DeliveryStatus> {
  const secret = env.INTERNAL_GATEWAY_SECRET ?? '';
  if (secret === '') throw new TransportFailed('delivery is not configured');

  const body = new TextEncoder().encode(
    JSON.stringify({ queue: job.queue, jobName: job.jobName, jobId: job.jobId, data: job.data, attemptsMade, maxAttempts: job.maxAttempts }),
  );
  const headers = await signedInternalHeaders(secret, 'POST', DELIVERY_PATH, body);
  const request = new Request(`${CONTAINER_ORIGIN}${DELIVERY_PATH}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
  let response: Response;
  try {
    const container = env.GitViseApiContainer.getByName(API_CONTAINER_INSTANCE);
    response = await withTimeout(container.fetch(request), DELIVERY_TIMEOUT_MS);
  } catch (error: unknown) {
    throw new TransportFailed(error instanceof Error ? error.message : 'delivery request failed');
  }
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new ProcessorFailed(response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new TransportFailed(`delivery answered ${response.status}`);
  }
  const reply = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
  if (reply?.status === 'completed' || reply?.status === 'unrecoverable' || reply?.status === 'no-processor') {
    return reply.status;
  }
  throw new TransportFailed('delivery reply was not a known status');
}

/** Counts a completed child toward its parent, and enqueues the parent once every child has completed. */
async function progressFlow(env: GatewayEnv, job: ApiJobMessage): Promise<void> {
  if (job.parentJobId === undefined) return;
  const parent = job.parentJobId;

  // Count this child once. A repeat finds the claim and skips the decrement.
  if (await entry(env, countedKey(job.jobId)).put('1', { ifAbsent: true, ttlMs: CLAIM_TTL_MS })) {
    if ((await entry(env, pendingKey(parent)).get()) !== undefined) {
      await entry(env, pendingKey(parent)).increment(-1);
    }
  }

  // Release the parent once, when no children remain. A failed send gives the claim back so a retry can send it.
  if ((await entry(env, pendingKey(parent)).get()) !== '0') return;
  if (!(await entry(env, releasedKey(parent)).put('1', { ifAbsent: true, ttlMs: CLAIM_TTL_MS }))) return;
  const record = await entry(env, nodeKey(parent)).get();
  if (record === undefined) {
    await entry(env, releasedKey(parent)).delete();
    return;
  }
  try {
    await env.API_JOBS.send(JSON.parse(record) as ApiJobMessage, { delaySeconds: 0 });
  } catch (error) {
    await entry(env, releasedKey(parent)).delete();
    throw error;
  }
}

/** Rejects when `work` has not settled within `ms`. A container stub has no abort signal, so the race is the bound. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('delivery timed out')), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

export class ProcessorFailed extends Error {
  constructor(readonly status: number) {
    super(`processor failed with status ${status}`);
  }
}

export class TransportFailed extends Error {}

function retryDelaySeconds(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_SECONDS, 30 * 2 ** Math.max(0, attempts - 1));
}

function delaySeconds(delayMs: number | undefined): number {
  if (delayMs === undefined) return 0;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw invalid('delayMs must be a non-negative integer');
  const seconds = Math.ceil(delayMs / 1000);
  if (seconds > MAX_DELAY_SECONDS) throw invalid('delayMs must be at most 12 hours');
  return seconds;
}

interface PlannedNode {
  readonly message: ApiJobMessage;
  readonly childCount: number;
}

function flatten(node: FlowNodeInput, parentJobId: string | undefined, depth: number, out: PlannedNode[]): void {
  if (depth > MAX_FLOW_DEPTH) throw invalid(`flows nest at most ${MAX_FLOW_DEPTH} levels deep`);
  if (out.length >= MAX_FLOW_NODES) throw invalid(`flows hold at most ${MAX_FLOW_NODES} nodes`);
  out.push({
    message: {
      queue: node.queueName,
      jobName: node.name,
      jobId: node.jobId,
      data: node.data,
      maxAttempts: node.attempts,
      ...(parentJobId === undefined ? {} : { parentJobId }),
    },
    childCount: node.children.length,
  });
  for (const child of node.children) flatten(child, node.jobId, depth + 1, out);
}

/** Parses a flow tree body. Every field the gateway uses is checked, and the rest is ignored. */
export function parseFlowTree(value: unknown, depth = 0): FlowNodeInput {
  const node = objectBody(value, 'flow node');
  const children = node['children'] === undefined ? [] : node['children'];
  if (!Array.isArray(children)) throw invalid('flow node children must be an array');
  const opts = objectBody(node['opts'], 'flow node opts');
  const attempts = opts['attempts'] === undefined ? 1 : opts['attempts'];
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100) {
    throw invalid('flow node attempts must be an integer from 1 to 100');
  }
  return {
    name: stringField(node['name'], 'flow node name', 128),
    queueName: stringField(node['queueName'], 'flow node queueName', 128),
    data: objectBody(node['data'], 'flow node data'),
    jobId: stringField(opts['jobId'], 'flow node opts.jobId', 256),
    attempts,
    children: children.map((child: unknown) => {
      if (depth + 1 > MAX_FLOW_DEPTH) throw invalid(`flows nest at most ${MAX_FLOW_DEPTH} levels deep`);
      return parseFlowTree(child, depth + 1);
    }),
  };
}

function entry(env: GatewayEnv, key: string) {
  return env.KV_ENTRIES.getByName(key);
}

const claimKey = (queue: string, jobId: string): string => `job-claim:${queue}:${jobId}`;
const doneKey = (jobId: string): string => `job-done:${jobId}`;
const inflightKey = (jobId: string): string => `job-inflight:${jobId}`;
const countedKey = (jobId: string): string => `flow-counted:${jobId}`;
const pendingKey = (jobId: string): string => `flow-pending:${jobId}`;
const nodeKey = (jobId: string): string => `flow-node:${jobId}`;
const releasedKey = (jobId: string): string => `flow-released:${jobId}`;
