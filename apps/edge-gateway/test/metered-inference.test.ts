import { describe, expect, it } from 'vitest';
import type { InferenceEvent, InferencePort, InferenceRequest } from '@gitvise/core';
import { CreditExhaustedError } from '../src/billing/errors';
import { DirectInferenceDisabled, MeteredInferenceDecorator, type UsageRecord } from '../src/billing/metered-inference';
import { testEnv, uniqueId } from './support/bindings';

/** Inner adapter double that streams two tokens and then a single usage event, like the real one. */
function fakeInner(): InferencePort {
  return {
    availableTiers: () => ['fast-3b', 'worker-7b', 'architect-30b'],
    embed: async () => [],
    stream: () =>
      new ReadableStream<InferenceEvent>({
        start(controller) {
          controller.enqueue({ type: 'token', text: 'hel' });
          controller.enqueue({ type: 'token', text: 'lo' });
          controller.enqueue({
            type: 'usage',
            usage: { tier: 'fast-3b', promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          });
          controller.close();
        },
      }),
  };
}

function request(requestId: string): InferenceRequest {
  return { requestId, tier: 'fast-3b', messages: [{ role: 'user', content: 'hi' }] };
}

function decorator(onSettled: (record: UsageRecord) => Promise<void> | void = () => undefined): MeteredInferenceDecorator {
  return new MeteredInferenceDecorator({
    inner: fakeInner(),
    guards: testEnv.BILLING_GUARD,
    externalFallbackConfigured: false,
    describeModel: () => 'test-model',
    onSettled,
  });
}

async function drain(stream: ReadableStream<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return events;
    events.push(next.value);
  }
}

describe('MeteredInferenceDecorator', () => {
  it('settles the cost from the usage event once, and writes one usage record', async () => {
    const orgId = uniqueId('org');
    await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: 'seed', bucket: 'monthly', amountPence: 10 });
    const records: UsageRecord[] = [];

    const stream = await decorator((record) => void records.push(record)).open(request('call-1'), {
      orgId,
      userId: 'user-1',
    });
    const events = await drain(stream);

    expect(events.map((event) => event.type)).toEqual(['token', 'token', 'usage']);
    // 12 tokens at 5 pence per million rounds up to 1 penny.
    expect(records).toEqual([
      expect.objectContaining({
        requestId: 'call-1',
        orgId,
        costPence: 1,
        monthlyDebitPence: 1,
        topupDebitPence: 0,
        monthlyPenceAfter: 9,
        duplicate: false,
      }),
    ]);
    const status = await testEnv.BILLING_GUARD.getByName(orgId).status();
    expect(status).toMatchObject({ monthlyPence: 9, heldPence: 0 });
  });

  it('refuses with CreditExhaustedError (402) before any token is produced when the balance is empty', async () => {
    const orgId = uniqueId('org');

    await expect(decorator().open(request('call-empty'), { orgId, userId: 'user-1' })).rejects.toBeInstanceOf(
      CreditExhaustedError,
    );
    const refusal = await decorator().open(request('call-empty-2'), { orgId, userId: 'user-1' }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CreditExhaustedError);
    expect((refusal as CreditExhaustedError).status).toBe(402);
  });

  it('settles with a character-based estimate when the consumer cancels before the usage event', async () => {
    const orgId = uniqueId('org');
    await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: 'seed', bucket: 'monthly', amountPence: 100 });
    const records: UsageRecord[] = [];

    const stream = await decorator((record) => void records.push(record)).open(request('call-cancel'), {
      orgId,
      userId: 'user-1',
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel('client went away');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestId: 'call-cancel', duplicate: false, costPence: 1 });
    expect((await testEnv.BILLING_GUARD.getByName(orgId).status()).monthlyPence).toBe(99);
  });

  it('records the debit before the usage event reaches the client', async () => {
    const orgId = uniqueId('org');
    await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: 'seed', bucket: 'monthly', amountPence: 10 });
    let recordedBeforeUsage = false;
    let recorded = false;

    const stream = await decorator(() => {
      recorded = true;
    }).open(request('call-order'), { orgId, userId: 'user-1' });
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === 'usage') recordedBeforeUsage = recorded;
    }

    expect(recordedBeforeUsage).toBe(true);
  });
});

describe('DirectInferenceDisabled', () => {
  it('refuses direct stream calls, so unmetered inference cannot reach the engine', () => {
    const guarded = new DirectInferenceDisabled(fakeInner());
    expect(guarded.availableTiers()).toEqual(['fast-3b', 'worker-7b', 'architect-30b']);
    expect(() => guarded.stream()).toThrow(/route calls through MeteredInferenceDecorator/);
  });
});
