import { GitViseError, type JsonValue, type SwarmQueuePort } from '@gitvise/core';
import { errorMessage } from '../shared/errors';
import type { SwarmTaskMessage } from './swarm-types';

/**
 * Executes one step. Must be idempotent: queue delivery is at-least-once and failed steps are retried.
 * A handler may return a JSON result, which is stored on the step when `recordResult` is configured.
 */
export type SwarmTaskHandler = (task: SwarmTaskMessage) => Promise<JsonValue | void>;

/**
 * Throw this from a handler when retrying cannot help, such as a bad input or a failing command.
 * The step fails on the first attempt and the message is acknowledged.
 */
export class NonRetryableTaskError extends Error {
  override readonly name = 'NonRetryableTaskError';
}

export interface SwarmTaskConsumerOptions {
  /** Executors keyed by logical queue name (`SwarmTaskSpec.queue`). */
  readonly handlers: Readonly<Record<string, SwarmTaskHandler>>;
  readonly swarm: SwarmQueuePort;
  /** Persists a handler's return value before the step is marked succeeded. */
  readonly recordResult?: (task: SwarmTaskMessage, result: JsonValue) => Promise<void>;
  /** Attempts before a step is marked failed. Matches the queue's `max_retries` plus the first try. */
  readonly maxAttempts?: number;
  readonly retryDelaySeconds?: number;
}

/**
 * Builds the `queue()` handler for the swarm task queue. Each message moves its step
 * `running -> succeeded` or `running -> failed` through compare-and-set, so a late duplicate cannot
 * overwrite a settled step.
 */
export function createSwarmTaskConsumer(options: SwarmTaskConsumerOptions) {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelaySeconds = options.retryDelaySeconds ?? 5;

  return async function consumeSwarmTasks(batch: MessageBatch<SwarmTaskMessage>): Promise<void> {
    for (const message of batch.messages) {
      const task = message.body;
      const handler = options.handlers[task.queue];

      if (handler === undefined) {
        // No executor is registered for this queue. Retrying cannot help, so fail the step now.
        await options.swarm.compareAndSetStepStatus(task.flowId, task.taskId, 'running', 'failed');
        message.ack();
        continue;
      }

      try {
        const result = await handler(task);
        if (result !== undefined && options.recordResult !== undefined) {
          await options.recordResult(task, result);
        }
        await options.swarm.compareAndSetStepStatus(task.flowId, task.taskId, 'running', 'succeeded');
        message.ack();
      } catch (error) {
        if (isRetryable(error) && message.attempts < maxAttempts) {
          message.retry({ delaySeconds: retryDelaySeconds });
          continue;
        }
        console.error(`swarm task ${task.flowId}/${task.taskId} failed: ${errorMessage(error)}`);
        await options.swarm.compareAndSetStepStatus(task.flowId, task.taskId, 'running', 'failed');
        message.ack();
      }
    }
  };
}

/** Validation and policy errors are final. Everything else (transient upstream, lock contention) may retry. */
function isRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableTaskError) return false;
  if (error instanceof GitViseError && error.code === 'INVALID_REQUEST') return false;
  return true;
}
