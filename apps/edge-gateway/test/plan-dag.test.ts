import { describe, expect, it } from 'vitest';
import type { InferenceEvent, InferencePort, SwarmFlowSpec, SwarmQueuePort } from '@gitvise/core';
import { NonRetryableTaskError, type SwarmTaskMessage } from '@gitvise/adapter-cloudflare';
import { MeteredInferenceDecorator } from '../src/billing/metered-inference';
import { createBaselineHandlers, type HandlerServices } from '../src/swarm/handlers';
import { testEnv, uniqueId } from './support/bindings';

/** Inner model double. It streams `reply` as tokens, then a usage event, like the real adapter. */
function modelReplying(reply: string): InferencePort {
  return {
    availableTiers: () => ['fast-3b', 'worker-7b', 'architect-30b'],
    embed: async () => [],
    stream: () =>
      new ReadableStream<InferenceEvent>({
        start(controller) {
          for (let offset = 0; offset < reply.length; offset += 40) {
            controller.enqueue({ type: 'token', text: reply.slice(offset, offset + 40) });
          }
          controller.enqueue({
            type: 'usage',
            usage: { tier: 'architect-30b', promptTokens: 50, completionTokens: 50, totalTokens: 100 },
          });
          controller.close();
        },
      }),
  };
}

/** Records every enqueued flow, as the Workflow-backed queue would receive it. */
class RecordingQueue {
  readonly flows: SwarmFlowSpec[] = [];
  readonly port = {
    enqueueFlow: async (flow: SwarmFlowSpec) => {
      const created = !this.flows.some((existing) => existing.flowId === flow.flowId);
      if (created) this.flows.push(flow);
      return { created };
    },
  } as unknown as SwarmQueuePort;
}

async function fundedOrg(amountPence = 10_000): Promise<string> {
  const orgId = uniqueId('org');
  await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: 'seed', bucket: 'monthly', amountPence });
  return orgId;
}

function harness(reply: string, queue: RecordingQueue) {
  const metered = new MeteredInferenceDecorator({
    inner: modelReplying(reply),
    guards: testEnv.BILLING_GUARD,
    externalFallbackConfigured: false,
    describeModel: () => 'test-model',
  });
  // plan-dag uses only the metered path and the queue. The other services are unused here.
  const services = { metered, swarmQueue: queue.port } as unknown as HandlerServices;
  return createBaselineHandlers(services)['plan-dag']!;
}

function planTask(orgId: string, goal = 'refactor the parser'): SwarmTaskMessage {
  return {
    flowId: `${orgId}:flow-${crypto.randomUUID().slice(0, 8)}`,
    taskId: 'plan',
    queue: 'plan-dag',
    input: { orgId, repoId: `${orgId}:app`, commitHash: 'ab'.repeat(20), goal },
  };
}

const VALID_PLAN = {
  steps: [
    { id: 'probe', type: 'sandbox-exec', dependsOn: [], payload: { command: ['npm', 'test'], timeoutMs: 5_000 } },
    { id: 'critique', type: 'debate-critique', dependsOn: ['probe'], payload: { proposal: 'split the parser module' } },
    { id: 'apply', type: 'commit-patch', dependsOn: ['probe', 'critique'], payload: { patch: 'diff --git a/x b/x\n' } },
  ],
};

describe('plan-dag', () => {
  it('parses a fenced structured plan and enqueues it as a child flow with stamped inputs', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();
    const reply = '```json\n' + JSON.stringify(VALID_PLAN) + '\n```';
    const task = planTask(orgId);

    const result = (await harness(reply, queue)(task)) as { childFlowId: string; steps: number; order: string[] };

    expect(result.steps).toBe(3);
    expect(result.order).toEqual(['probe', 'critique', 'apply']);
    expect(queue.flows).toHaveLength(1);

    const flow = queue.flows[0]!;
    expect(flow.flowId).toBe(result.childFlowId);
    expect(flow.flowId).toMatch(/^plan-[0-9a-f]{40}$/);
    expect(flow.repoId).toBe(`${orgId}:app`);
    expect(flow.specHash).toMatch(/^[0-9a-f]{64}$/);

    const probe = flow.tasks.find((t) => t.taskId === 'probe')!;
    expect(probe.queue).toBe('sandbox-exec');
    expect(probe.input).toEqual({ command: ['npm', 'test'], timeoutMs: 5_000, orgId, repoId: `${orgId}:app`, commitHash: 'ab'.repeat(20) });

    const critique = flow.tasks.find((t) => t.taskId === 'critique')!;
    expect(critique.dependsOn).toEqual(['probe']);
    // Debate steps are not tied to a commit, so the base commit is not stamped onto them.
    expect(critique.input).toEqual({ proposal: 'split the parser module', orgId, repoId: `${orgId}:app` });

    const apply = flow.tasks.find((t) => t.taskId === 'apply')!;
    expect(apply.queue).toBe('commit-patch');
    expect(apply.dependsOn).toEqual(['probe', 'critique']);
    expect(apply.input).toMatchObject({ patch: 'diff --git a/x b/x\n', commitHash: 'ab'.repeat(20), orgId });
  });

  it('gives the same child flow id on a retried submission, so retries enqueue nothing new', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();
    const task = planTask(orgId);
    const handler = harness(JSON.stringify(VALID_PLAN), queue);

    const first = (await handler(task)) as { childFlowId: string };
    const second = (await handler(task)) as { childFlowId: string; created: boolean };

    expect(second.childFlowId).toBe(first.childFlowId);
    expect(second.created).toBe(false);
    expect(queue.flows).toHaveLength(1);
  });

  it('rejects a cyclic plan with a non-retryable failure, and enqueues nothing', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();
    const cyclic = {
      steps: [
        { id: 'a', type: 'debate-critique', dependsOn: ['b'], payload: { proposal: 'first' } },
        { id: 'b', type: 'debate-critique', dependsOn: ['a'], payload: { proposal: 'second' } },
      ],
    };

    const attempt = harness(JSON.stringify(cyclic), queue)(planTask(orgId));
    await expect(attempt).rejects.toBeInstanceOf(NonRetryableTaskError);
    await expect(attempt).rejects.toThrow(/cycle/);
    expect(queue.flows).toHaveLength(0);
  });

  it('rejects a dependency on a step that does not exist', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();
    const plan = { steps: [{ id: 'a', type: 'debate-critique', dependsOn: ['ghost'], payload: { proposal: 'x' } }] };

    await expect(harness(JSON.stringify(plan), queue)(planTask(orgId))).rejects.toThrow(/unknown step ghost/);
    expect(queue.flows).toHaveLength(0);
  });

  it('rejects a step type outside the three allowed types', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();
    const plan = { steps: [{ id: 'a', type: 'shell', dependsOn: [], payload: { command: ['rm', '-rf', '/'] } }] };

    await expect(harness(JSON.stringify(plan), queue)(planTask(orgId))).rejects.toBeInstanceOf(NonRetryableTaskError);
    expect(queue.flows).toHaveLength(0);
  });

  it('rejects a reply that is not JSON', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();

    await expect(harness('Sure! Here is a plan: first do the thing.', queue)(planTask(orgId))).rejects.toThrow(/not valid JSON/);
    expect(queue.flows).toHaveLength(0);
  });

  it('rejects a payload that tries to name an org, so the model cannot re-target billing or data', async () => {
    const orgId = await fundedOrg();
    const queue = new RecordingQueue();
    const plan = {
      steps: [{ id: 'a', type: 'debate-critique', dependsOn: [], payload: { proposal: 'x', orgId: 'org-someone-else' } }],
    };

    await expect(harness(JSON.stringify(plan), queue)(planTask(orgId))).rejects.toThrow(/payload\.orgId is not allowed/);
    expect(queue.flows).toHaveLength(0);
  });

  it('fails once, without a model call, when the org has no credit', async () => {
    const orgId = uniqueId('org');
    const queue = new RecordingQueue();

    await expect(harness(JSON.stringify(VALID_PLAN), queue)(planTask(orgId))).rejects.toThrow(/no remaining credit/);
    expect(queue.flows).toHaveLength(0);
  });
});
