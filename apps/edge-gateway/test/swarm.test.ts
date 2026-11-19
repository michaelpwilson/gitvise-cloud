import { describe, expect, it, vi } from 'vitest';
import type { SwarmFlowSpec, SwarmQueuePort, SwarmStepStatus } from '@gitvise/core';
import {
  createSwarmTaskConsumer,
  NonRetryableTaskError,
  type SwarmTaskMessage,
} from '@gitvise/adapter-cloudflare';
import { GitViseError } from '@gitvise/core';
import { testEnv, uniqueId } from './support/bindings';

function message(task: Partial<SwarmTaskMessage>, attempts: number) {
  return {
    body: { flowId: 'flow-1', taskId: 'task-1', queue: 'sandbox-exec', input: {}, ...task } as SwarmTaskMessage,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

/** Records every status transition the consumer asks for. Returns `applied` for each one. */
function fakeSwarm(): { port: SwarmQueuePort; transitions: Array<[SwarmStepStatus, SwarmStepStatus]>; results: unknown[] } {
  const transitions: Array<[SwarmStepStatus, SwarmStepStatus]> = [];
  const results: unknown[] = [];
  const port = {
    compareAndSetStepStatus: async (_flow: string, _task: string, expected: SwarmStepStatus, next: SwarmStepStatus) => {
      transitions.push([expected, next]);
      return true;
    },
    recordStepResult: async (_flow: string, _task: string, result: unknown) => {
      results.push(result);
    },
  } as unknown as SwarmQueuePort;
  return { port, transitions, results };
}

describe('swarm task consumer', () => {
  it('records a handler result, marks the step succeeded, and acknowledges the message', async () => {
    const swarm = fakeSwarm();
    const recordResult = vi.fn(async () => undefined);
    const consume = createSwarmTaskConsumer({
      handlers: { 'sandbox-exec': async () => ({ exitCode: 0 }) },
      swarm: swarm.port,
      recordResult,
    });
    const msg = message({}, 1);

    await consume({ messages: [msg] } as unknown as MessageBatch<SwarmTaskMessage>);

    expect(recordResult).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }), { exitCode: 0 });
    expect(swarm.transitions).toEqual([['running', 'succeeded']]);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries a transient failure with a delay, while attempts remain', async () => {
    const swarm = fakeSwarm();
    const consume = createSwarmTaskConsumer({
      handlers: { 'sandbox-exec': async () => { throw new Error('upstream blip'); } },
      swarm: swarm.port,
      maxAttempts: 3,
      retryDelaySeconds: 7,
    });
    const msg = message({}, 1);

    await consume({ messages: [msg] } as unknown as MessageBatch<SwarmTaskMessage>);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 7 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(swarm.transitions).toEqual([]);
  });

  it('marks the step failed and acknowledges once retries are exhausted', async () => {
    const swarm = fakeSwarm();
    const consume = createSwarmTaskConsumer({
      handlers: { 'sandbox-exec': async () => { throw new Error('still broken'); } },
      swarm: swarm.port,
      maxAttempts: 3,
    });
    const msg = message({}, 3);

    await consume({ messages: [msg] } as unknown as MessageBatch<SwarmTaskMessage>);

    expect(swarm.transitions).toEqual([['running', 'failed']]);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('does not retry a NonRetryableTaskError, even on the first attempt', async () => {
    const swarm = fakeSwarm();
    const consume = createSwarmTaskConsumer({
      handlers: { 'sandbox-exec': async () => { throw new NonRetryableTaskError('command exited with 1'); } },
      swarm: swarm.port,
    });
    const msg = message({}, 1);

    await consume({ messages: [msg] } as unknown as MessageBatch<SwarmTaskMessage>);

    expect(msg.retry).not.toHaveBeenCalled();
    expect(swarm.transitions).toEqual([['running', 'failed']]);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('does not retry an INVALID_REQUEST, because the same input will fail again', async () => {
    const swarm = fakeSwarm();
    const consume = createSwarmTaskConsumer({
      handlers: { 'sandbox-exec': async () => { throw new GitViseError('INVALID_REQUEST', 'bad env'); } },
      swarm: swarm.port,
    });
    const msg = message({}, 1);

    await consume({ messages: [msg] } as unknown as MessageBatch<SwarmTaskMessage>);

    expect(msg.retry).not.toHaveBeenCalled();
    expect(swarm.transitions).toEqual([['running', 'failed']]);
  });

  it('fails a step on a queue that has no handler, without retrying', async () => {
    const swarm = fakeSwarm();
    const consume = createSwarmTaskConsumer({ handlers: {}, swarm: swarm.port });
    const msg = message({ queue: 'unknown-queue' }, 1);

    await consume({ messages: [msg] } as unknown as MessageBatch<SwarmTaskMessage>);

    expect(swarm.transitions).toEqual([['running', 'failed']]);
    expect(msg.retry).not.toHaveBeenCalled();
  });
});

describe('SwarmFlowState dependency graph', () => {
  function flow(flowId: string): SwarmFlowSpec {
    return {
      flowId,
      repoId: 'repo-demo',
      tasks: [
        { taskId: 'plan', queue: 'plan-dag', input: { goal: 'add login' }, dependsOn: [] },
        { taskId: 'exec', queue: 'sandbox-exec', input: { command: ['npm', 'test'] }, dependsOn: ['plan'] },
        { taskId: 'critique', queue: 'debate-critique', input: { proposal: 'x' }, dependsOn: ['plan'] },
        { taskId: 'commit', queue: 'commit-patch', input: { patch: 'x' }, dependsOn: ['exec', 'critique'] },
      ],
    } as unknown as SwarmFlowSpec;
  }

  it('releases a step only after all its dependencies have succeeded', async () => {
    const flowId = uniqueId('flow');
    const state = testEnv.SWARM_FLOWS.getByName(flowId);
    await state.enqueue(flow(flowId));

    expect((await state.readyTasks()).map((task) => task.taskId)).toEqual(['plan']);
    expect(await state.progress()).toBe('waiting');

    await state.claim('plan');
    await state.cas('plan', 'running', 'succeeded');

    expect((await state.readyTasks()).map((task) => task.taskId).sort()).toEqual(['critique', 'exec']);
  });

  it('fails every transitive dependant when a step fails, so the flow cannot stall', async () => {
    const flowId = uniqueId('flow');
    const state = testEnv.SWARM_FLOWS.getByName(flowId);
    await state.enqueue(flow(flowId));

    await state.claim('plan');
    await state.cas('plan', 'running', 'failed');

    expect(await state.status('exec')).toBe('failed');
    expect(await state.status('critique')).toBe('failed');
    expect(await state.status('commit')).toBe('failed');
    expect(await state.progress()).toBe('done');
  });

  it('stores a step result and reads it back, and reports unknown steps as undefined', async () => {
    const flowId = uniqueId('flow');
    const state = testEnv.SWARM_FLOWS.getByName(flowId);
    await state.enqueue(flow(flowId));

    expect(await state.readResult('plan')).toBeNull();
    expect(await state.setResult('plan', JSON.stringify({ plan: 'steps' }))).toBe(true);
    expect(await state.readResult('plan')).toBe(JSON.stringify({ plan: 'steps' }));
    expect(await state.setResult('no-such-step', '{}')).toBe(false);
    expect(await state.readResult('no-such-step')).toBeUndefined();
  });

  it('refuses a second submission of the same flow with a different spec hash', async () => {
    const flowId = uniqueId('flow');
    const state = testEnv.SWARM_FLOWS.getByName(flowId);
    const first = await state.enqueue({ ...flow(flowId), specHash: 'hash-a' } as SwarmFlowSpec);
    const second = await state.enqueue({ ...flow(flowId), specHash: 'hash-b' } as SwarmFlowSpec);

    expect(first).toEqual({ ok: true, created: true });
    expect(second).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
});
