import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiJobMessage } from '../src/queues/api-job-message';
import { deliverApiJobs } from '../src/queues/api-jobs';
import { verifyInternalSignature } from '../src/internal/signature';
import type { GatewayEnv } from '../src/env';
import { httpEnv, TEST_SECRETS, testEnv, uniqueId } from './support/bindings';
import { callInternalWith } from './support/internal';

interface Sent {
  readonly body: ApiJobMessage;
  readonly options?: { delaySeconds?: number } | undefined;
}

interface ContainerCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** Requests the apps/api container has received, and the reply it gives. `stubContainer` sets both. */
let containerCalls: ContainerCall[] = [];
let containerReply: () => Response | Promise<Response> = () => new Response(null, { status: 500 });

/** Stands in for the `GitViseApiContainer` namespace. Every instance records what it is sent, then answers with `containerReply`. */
const fakeApiContainer = {
  getByName: () => ({
    fetch: async (request: Request): Promise<Response> => {
      containerCalls.push({ url: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      return containerReply();
    },
  }),
};

/** Records every message the gateway sends to the job queue, in order. */
function fakeJobQueue(): { sent: Sent[]; env: GatewayEnv } {
  const sent: Sent[] = [];
  const queue = {
    send: async (body: ApiJobMessage, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    },
  };
  return {
    sent,
    env: httpEnv({
      API_JOBS: queue as unknown as GatewayEnv['API_JOBS'],
      GitViseApiContainer: fakeApiContainer as unknown as GatewayEnv['GitViseApiContainer'],
    }),
  };
}

function message(body: ApiJobMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

async function deliver(env: GatewayEnv, messages: ReturnType<typeof message>[]): Promise<void> {
  await deliverApiJobs({ messages } as unknown as MessageBatch<ApiJobMessage>, env);
}

/** Stubs the apps/api container. Each delivery is recorded, then answered with `reply`. */
function stubContainer(reply: () => Response | Promise<Response>): ContainerCall[] {
  containerCalls = [];
  containerReply = reply;
  return containerCalls;
}

const completed = () => new Response(JSON.stringify({ status: 'completed' }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/internal/queues/send', () => {
  it('enqueues a job and answers its id', async () => {
    const { sent, env } = fakeJobQueue();
    const jobId = uniqueId('ci-job');
    const response = await callInternalWith('POST', '/internal/queues/send', {
      env,
      payload: { queue: 'ci', jobName: 'run-check', jobId, data: { repo: 'r1' } },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: jobId });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ queue: 'ci', jobName: 'run-check', jobId, data: { repo: 'r1' } });
  });

  it('answers 409 for a jobId that was already submitted, and enqueues it once', async () => {
    const { sent, env } = fakeJobQueue();
    const jobId = uniqueId('dup-job');
    const payload = { queue: 'agent', jobName: 'run', jobId, data: {} };
    expect((await callInternalWith('POST', '/internal/queues/send', { env, payload })).status).toBe(202);
    const repeat = await callInternalWith('POST', '/internal/queues/send', { env, payload });
    expect(repeat.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it('frees a jobId whose send failed, so a correct retry can enqueue it', async () => {
    const jobId = uniqueId('flaky-job');
    const failing = httpEnv({
      API_JOBS: { send: async () => Promise.reject(new Error('queue unavailable')) } as unknown as GatewayEnv['API_JOBS'],
    });
    const failed = await callInternalWith('POST', '/internal/queues/send', {
      env: failing,
      payload: { queue: 'ci', jobName: 'j', jobId, data: {} },
    });
    expect(failed.status).toBe(500);

    const { sent, env } = fakeJobQueue();
    const retried = await callInternalWith('POST', '/internal/queues/send', {
      env,
      payload: { queue: 'ci', jobName: 'j', jobId, data: {} },
    });
    expect(retried.status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it('refuses a delay longer than 12 hours', async () => {
    const { env } = fakeJobQueue();
    const response = await callInternalWith('POST', '/internal/queues/send', {
      env,
      payload: { queue: 'ci', jobName: 'j', data: {}, delayMs: 13 * 60 * 60 * 1000 },
    });
    expect(response.status).toBe(400);
  });
});

describe('/internal/queues/flow', () => {
  function flowTree(rootId: string, childIds: [string, string]) {
    const leaf = (jobId: string) => ({ name: `step-${jobId}`, queueName: 'ci', data: { step: jobId }, opts: { jobId, attempts: 1 } });
    return {
      name: 'pipeline',
      queueName: 'ci',
      data: { pipeline: rootId },
      opts: { jobId: rootId, attempts: 1 },
      children: childIds.map(leaf),
    };
  }

  it('enqueues only the leaves, then the parent once every child has completed', async () => {
    const { sent, env } = fakeJobQueue();
    const [root, a, b] = [uniqueId('flow-root'), uniqueId('flow-a'), uniqueId('flow-b')] as const;
    const response = await callInternalWith('POST', '/internal/queues/flow', { env, payload: flowTree(root, [a, b]) });
    expect(response.status).toBe(202);
    expect(sent.map((entry) => entry.body.jobId).sort()).toEqual([a, b].sort());

    const calls = stubContainer(completed);
    await deliver(env, [message(sent[0]!.body)]);
    expect(sent).toHaveLength(2);

    await deliver(env, [message(sent[1]!.body)]);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body).toMatchObject({ jobId: root });
    expect(sent[2]?.body.parentJobId).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('does not count a redelivered child twice, so the parent waits for its other child', async () => {
    const { sent, env } = fakeJobQueue();
    const [root, a, b] = [uniqueId('flow-root'), uniqueId('flow-a'), uniqueId('flow-b')] as const;
    await callInternalWith('POST', '/internal/queues/flow', { env, payload: flowTree(root, [a, b]) });
    stubContainer(completed);

    const childA = sent.find((entry) => entry.body.jobId === a)!.body;
    await deliver(env, [message(childA)]);
    await deliver(env, [message(childA)]);
    await deliver(env, [message(childA)]);
    expect(sent.some((entry) => entry.body.jobId === root)).toBe(false);
  });

  it('refuses a repeated flow submit with 409', async () => {
    const { env } = fakeJobQueue();
    const [root, a] = [uniqueId('flow-root'), uniqueId('flow-a')] as const;
    const payload = flowTree(root, [a, uniqueId('flow-b')]);
    expect((await callInternalWith('POST', '/internal/queues/flow', { env, payload })).status).toBe(202);
    expect((await callInternalWith('POST', '/internal/queues/flow', { env, payload })).status).toBe(409);
  });
});

describe('signed delivery to apps/api', () => {
  it('posts each job to the container with a gitvise-internal-v1 signature over its exact bytes', async () => {
    const { env } = fakeJobQueue();
    const jobId = uniqueId('deliver-job');
    const calls = stubContainer(completed);
    await deliver(env, [message({ queue: 'ci', jobName: 'run', jobId, data: { n: 1 }, maxAttempts: 3 }, 2)]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe('/internal/queues/deliver');
    const body = call.body;
    const headers = call.headers;
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      queue: 'ci',
      jobName: 'run',
      jobId,
      data: { n: 1 },
      attemptsMade: 1,
      maxAttempts: 3,
    });
    const verified = await verifyInternalSignature({
      secret: TEST_SECRETS.INTERNAL_GATEWAY_SECRET,
      method: 'POST',
      pathAndQuery: '/internal/queues/deliver',
      headers,
      body,
    });
    expect(verified).toBe(true);
  });

  it('acks a job once it is delivered, and does not deliver it again on redelivery', async () => {
    const { env } = fakeJobQueue();
    const jobId = uniqueId('once-job');
    const calls = stubContainer(completed);
    const first = message({ queue: 'ci', jobName: 'run', jobId, data: {}, maxAttempts: 1 });
    await deliver(env, [first]);
    expect(first.ack).toHaveBeenCalledTimes(1);

    const redelivered = message({ queue: 'ci', jobName: 'run', jobId, data: {}, maxAttempts: 1 });
    await deliver(env, [redelivered]);
    expect(redelivered.ack).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('retries a job while another consumer holds its in-flight claim', async () => {
    const { env } = fakeJobQueue();
    const jobId = uniqueId('busy-job');
    await testEnv.KV_ENTRIES.getByName(`job-inflight:${jobId}`).put('1', { ifAbsent: true, ttlMs: 60_000 });
    const calls = stubContainer(completed);
    const busy = message({ queue: 'ci', jobName: 'run', jobId, data: {}, maxAttempts: 3 });
    await deliver(env, [busy]);
    expect(busy.retry).toHaveBeenCalledTimes(1);
    expect(busy.ack).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('retries when no processor is registered yet', async () => {
    const { env } = fakeJobQueue();
    stubContainer(() => new Response(JSON.stringify({ status: 'no-processor' }), { status: 200 }));
    const msg = message({ queue: 'ci', jobName: 'run', jobId: uniqueId('np'), data: {}, maxAttempts: 3 });
    await deliver(env, [msg]);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks an unrecoverable job without retrying it', async () => {
    const { env } = fakeJobQueue();
    stubContainer(() => new Response(JSON.stringify({ status: 'unrecoverable' }), { status: 200 }));
    const msg = message({ queue: 'ci', jobName: 'run', jobId: uniqueId('unrec'), data: {}, maxAttempts: 3 });
    await deliver(env, [msg]);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries a processor failure while attempts remain, and stops after the last attempt', async () => {
    const { env } = fakeJobQueue();
    stubContainer(() => new Response('boom', { status: 500 }));

    const early = message({ queue: 'ci', jobName: 'run', jobId: uniqueId('fail-early'), data: {}, maxAttempts: 3 }, 1);
    await deliver(env, [early]);
    expect(early.retry).toHaveBeenCalledTimes(1);

    const last = message({ queue: 'ci', jobName: 'run', jobId: uniqueId('fail-last'), data: {}, maxAttempts: 2 }, 2);
    await deliver(env, [last]);
    expect(last.ack).toHaveBeenCalledTimes(1);
    expect(last.retry).not.toHaveBeenCalled();
  });

  it('retries a transport failure without counting it as an attempt', async () => {
    const { env } = fakeJobQueue();
    stubContainer(() => {
      throw new Error('connection reset');
    });
    const msg = message({ queue: 'ci', jobName: 'run', jobId: uniqueId('net'), data: {}, maxAttempts: 1 }, 1);
    await deliver(env, [msg]);
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('releases a flow parent only after its child is settled, not when a child is retried', async () => {
    const { sent, env } = fakeJobQueue();
    const [root, a] = [uniqueId('flow-root'), uniqueId('flow-a')] as const;
    await callInternalWith('POST', '/internal/queues/flow', {
      env,
      payload: {
        name: 'p',
        queueName: 'ci',
        data: {},
        opts: { jobId: root, attempts: 1 },
        children: [{ name: 'c', queueName: 'ci', data: {}, opts: { jobId: a, attempts: 1 } }],
      },
    });
    stubContainer(() => new Response('boom', { status: 500 }));
    const child = sent.find((entry) => entry.body.jobId === a)!.body;
    // Three allowed attempts, so this failure is retried rather than recorded as final.
    const failing = message({ ...child, maxAttempts: 3 }, 1);
    await deliver(env, [failing]);
    expect(failing.retry).toHaveBeenCalledTimes(1);
    expect(sent.some((entry) => entry.body.jobId === root)).toBe(false);
  });
});
