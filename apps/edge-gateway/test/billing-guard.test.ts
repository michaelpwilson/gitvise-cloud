import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { testEnv, uniqueId } from './support/bindings';

const HOLD_STATE_KEY = 'state';

/** Usage facts for a settlement. The guard stores them in its outbox, so they must be present. */
const USAGE = { orgId: 'org-test', userId: 'user-test', tier: 'fast-3b', model: 'test-model', promptTokens: 1, completionTokens: 1 } as const;

describe('BillingGuardDurableObject', () => {
  it('starts with no credit and the hard cap on', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    const status = await stub.status();
    expect(status).toEqual({ monthlyPence: 0, topupPence: 0, heldPence: 0, availablePence: 0, hardCap: true, outboxDepth: 0 });
  });

  it('refuses a reservation once the hard cap is on and nothing is available', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'grant-1', bucket: 'monthly', amountPence: 100 });

    expect(await stub.reserve({ requestId: 'req-a', estimatePence: 40 })).toMatchObject({ ok: true, availablePence: 100 });
    expect(await stub.reserve({ requestId: 'req-b', estimatePence: 40 })).toMatchObject({ ok: true, availablePence: 60 });
    expect(await stub.reserve({ requestId: 'req-c', estimatePence: 40 })).toMatchObject({ ok: true, availablePence: 20 });

    // 120 pence is now held against a 100 pence balance.
    expect(await stub.reserve({ requestId: 'req-d', estimatePence: 40 })).toEqual({
      ok: false,
      reason: 'exhausted',
      availablePence: -20,
    });
  });

  it('keeps the race-free invariant under 50 concurrent reservations: exactly floor(balance / estimate) succeed', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'grant-race', bucket: 'monthly', amountPence: 100 });

    const attempts = await Promise.all(
      Array.from({ length: 50 }, (_, index) => stub.reserve({ requestId: `race-${index}`, estimatePence: 10 })),
    );

    const accepted = attempts.filter((attempt) => attempt.ok).length;
    const refused = attempts.filter((attempt) => !attempt.ok).length;
    expect(accepted).toBe(10);
    expect(refused).toBe(40);
    expect((await stub.status()).heldPence).toBe(100);
  });

  it('is idempotent on requestId: a repeated reservation holds the credit once', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'grant-1', bucket: 'monthly', amountPence: 50 });

    await Promise.all([
      stub.reserve({ requestId: 'same', estimatePence: 30 }),
      stub.reserve({ requestId: 'same', estimatePence: 30 }),
      stub.reserve({ requestId: 'same', estimatePence: 30 }),
    ]);

    expect((await stub.status()).heldPence).toBe(30);
  });

  it('settles the actual cost, spending monthly credit before top-up, and only once', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'm', bucket: 'monthly', amountPence: 30 });
    await stub.grant({ ref: 't', bucket: 'topup', amountPence: 50 });
    await stub.reserve({ requestId: 'call-1', estimatePence: 40 });

    const first = await stub.settle({ requestId: 'call-1', actualPence: 45, usage: USAGE });
    expect(first).toMatchObject({
      duplicate: false,
      costPence: 45,
      monthlyDebitPence: 30,
      topupDebitPence: 15,
      monthlyPenceAfter: 0,
      topupPenceAfter: 35,
    });

    // Replayed settlement debits nothing and reports the original result.
    const replay = await stub.settle({ requestId: 'call-1', actualPence: 45, usage: USAGE });
    expect(replay).toMatchObject({ duplicate: true, monthlyPenceAfter: 0, topupPenceAfter: 35 });

    const status = await stub.status();
    expect(status.heldPence).toBe(0);
    expect(status.availablePence).toBe(35);
  });

  it('lets a call overdraw when the hard cap is off, and records the overage', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.setHardCap(false);

    expect(await stub.reserve({ requestId: 'free-1', estimatePence: 25 })).toMatchObject({ ok: true });
    const settled = await stub.settle({ requestId: 'free-1', actualPence: 25, usage: USAGE });
    expect(settled.topupPenceAfter).toBe(-25);
  });

  it('grants are idempotent on their ref, so a redelivered webhook cannot credit twice', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));

    const first = await stub.grant({ ref: 'evt_topup', bucket: 'topup', amountPence: 1500 });
    const second = await stub.grant({ ref: 'evt_topup', bucket: 'topup', amountPence: 1500 });

    expect(first).toMatchObject({ applied: true, topupPence: 1500, deltaPence: 1500 });
    expect(second).toMatchObject({ applied: false, topupPence: 1500, deltaPence: 0 });
  });

  it('a monthly reset replaces the allowance and leaves top-up credit alone', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'evt_topup', bucket: 'topup', amountPence: 1500 });
    await stub.resetMonthly({ ref: 'inv_1', amountPence: 800 });

    // Spend some monthly credit, then reset for the next period.
    await stub.reserve({ requestId: 'spend', estimatePence: 300 });
    await stub.settle({ requestId: 'spend', actualPence: 300, usage: USAGE });

    const reset = await stub.resetMonthly({ ref: 'inv_2', amountPence: 800 });
    // 300 was spent from the 800 allowance, so the reset adds 300 back.
    expect(reset).toMatchObject({ applied: true, monthlyPence: 800, topupPence: 1500, deltaPence: 300 });

    const replayed = await stub.resetMonthly({ ref: 'inv_2', amountPence: 800 });
    expect(replayed).toMatchObject({ applied: false, monthlyPence: 800, topupPence: 1500 });
  });

  it('a reset to zero on cancellation keeps top-up credit', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'evt_topup', bucket: 'topup', amountPence: 1500 });
    await stub.resetMonthly({ ref: 'inv_1', amountPence: 800 });

    const cancelled = await stub.resetMonthly({ ref: 'sub_deleted', amountPence: 0 });
    expect(cancelled).toMatchObject({ monthlyPence: 0, topupPence: 1500 });
  });

  it('expired holds stop counting against the balance', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'grant-1', bucket: 'monthly', amountPence: 100 });
    await stub.reserve({ requestId: 'abandoned', estimatePence: 100 });
    expect(await stub.reserve({ requestId: 'blocked', estimatePence: 1 })).toMatchObject({ ok: false });

    // Age the abandoned hold past its TTL, as if the Worker died mid-stream and never settled.
    await runInDurableObject(stub, async (_instance, state) => {
      const current = state.storage.kv.get(HOLD_STATE_KEY) as {
        holds: Record<string, { amountPence: number; expiresAtMs: number }>;
      };
      current.holds['abandoned'] = { amountPence: 100, expiresAtMs: Date.now() - 1 };
      state.storage.kv.put(HOLD_STATE_KEY, current);
    });

    expect(await stub.reserve({ requestId: 'fresh', estimatePence: 60 })).toMatchObject({ ok: true });
    expect((await stub.status()).heldPence).toBe(60);
  });

  it('release drops a hold without charging', async () => {
    const stub = testEnv.BILLING_GUARD.getByName(uniqueId('org'));
    await stub.grant({ ref: 'grant-1', bucket: 'monthly', amountPence: 100 });
    await stub.reserve({ requestId: 'failed-early', estimatePence: 100 });

    await stub.release('failed-early');

    const status = await stub.status();
    expect(status.heldPence).toBe(0);
    expect(status.monthlyPence).toBe(100);
  });
});
