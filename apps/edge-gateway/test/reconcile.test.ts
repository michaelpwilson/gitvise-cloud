import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { ensureOrganization, findOrganization, recordGrant } from '../src/billing/ledger';
import { reconcileBilling } from '../src/billing/reconcile';
import { httpEnv, testEnv, uniqueId } from './support/bindings';

/** Grants credit on the guard and writes the matching ledger row, as the webhook path does. */
async function funded(orgId: string, bucket: 'monthly' | 'topup', amountPence: number): Promise<void> {
  await ensureOrganization(testEnv.D1, orgId, orgId);
  const ref = uniqueId('grant');
  const result = await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref, bucket, amountPence });
  await recordGrant(testEnv.D1, orgId, bucket === 'monthly' ? 'subscription_grant' : 'topup_purchase', ref, result);
}

/**
 * Spends on the guard but does NOT write D1, which is what happens when the inline usage write fails. The usage
 * record stays in the guard's outbox until a flush writes it.
 */
async function spendUnpersisted(orgId: string, actualPence: number): Promise<string> {
  const guard = testEnv.BILLING_GUARD.getByName(orgId);
  const requestId = uniqueId('req');
  const hold = await guard.reserve({ requestId, estimatePence: actualPence });
  expect(hold.ok).toBe(true);
  await guard.settle({
    requestId,
    actualPence,
    usage: { orgId, userId: 'user-1', tier: 'fast-3b', model: 'test-model', promptTokens: 1, completionTokens: 1 },
  });
  return requestId;
}

async function usageRows(orgId: string): Promise<number> {
  const row = await testEnv.D1.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE org_id = ?1').bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('billing reconciliation', () => {
  it('flushes unpersisted usage into D1, and the ledger then matches the live balance', async () => {
    const orgId = uniqueId('org');
    await funded(orgId, 'monthly', 100);
    const requestId = await spendUnpersisted(orgId, 3);
    const guard = testEnv.BILLING_GUARD.getByName(orgId);

    expect((await guard.status()).outboxDepth).toBe(1);
    expect(await usageRows(orgId)).toBe(0);

    const report = await reconcileBilling(testEnv, { orgIds: [orgId] });

    expect(report.orgs).toEqual([
      expect.objectContaining({
        orgId,
        outcome: 'balanced',
        flushed: 1,
        flushFailed: 0,
        live: { monthlyPence: 97, topupPence: 0 },
        ledger: { monthlyPence: 97, topupPence: 0 },
      }),
    ]);
    expect((await guard.status()).outboxDepth).toBe(0);
    expect(await usageRows(orgId)).toBe(1);
    const usage = await testEnv.D1.prepare('SELECT id, cost_pence FROM usage_events WHERE org_id = ?1').bind(orgId).first<{ id: string; cost_pence: number }>();
    expect(usage).toEqual({ id: requestId, cost_pence: 3 });

    // The mirror on the organisation row now equals the live guard balance.
    const org = await findOrganization(testEnv.D1, orgId);
    expect(org).toMatchObject({ monthly_credits_remaining_pence: 97, topup_credits_remaining_pence: 0 });
  });

  it('reports drift when the guard holds credit that no ledger row explains', async () => {
    const orgId = uniqueId('org');
    await ensureOrganization(testEnv.D1, orgId, orgId);
    // A grant applied on the guard with no ledger row. This is the drift the reconciliation exists to catch.
    await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: uniqueId('untracked'), bucket: 'topup', amountPence: 500 });

    const report = await reconcileBilling(testEnv, { orgIds: [orgId] });

    expect(report.mismatches).toBe(1);
    expect(report.orgs[0]).toMatchObject({
      outcome: 'mismatch',
      live: { monthlyPence: 0, topupPence: 500 },
      ledger: { monthlyPence: 0, topupPence: 0 },
    });
    // The guard is authoritative, so it is not changed. The mirror follows it.
    expect((await testEnv.BILLING_GUARD.getByName(orgId).status()).topupPence).toBe(500);
    expect((await findOrganization(testEnv.D1, orgId))?.topup_credits_remaining_pence).toBe(500);
  });

  it('is idempotent: a second run finds nothing to flush and leaves the balances as they were', async () => {
    const orgId = uniqueId('org');
    await funded(orgId, 'monthly', 50);
    await spendUnpersisted(orgId, 2);
    await reconcileBilling(testEnv, { orgIds: [orgId] });
    const before = await testEnv.BILLING_GUARD.getByName(orgId).status();

    const second = await reconcileBilling(testEnv, { orgIds: [orgId] });

    expect(second.flushed).toBe(0);
    expect(second.orgs[0]?.outcome).toBe('balanced');
    expect(await testEnv.BILLING_GUARD.getByName(orgId).status()).toEqual(before);
    expect(await usageRows(orgId)).toBe(1);
  });

  it('the scheduled handler runs the reconciliation in the background and flushes unpersisted usage', async () => {
    const orgId = uniqueId('org');
    await funded(orgId, 'monthly', 40);
    await spendUnpersisted(orgId, 4);

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const controller = { cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry: () => undefined } as unknown as ScheduledController;

    worker.scheduled(controller, httpEnv(), ctx);
    await Promise.all(pending);

    // Two background jobs: session pruning, then reconciliation.
    expect(pending).toHaveLength(2);
    expect(await usageRows(orgId)).toBe(1);
    expect((await testEnv.BILLING_GUARD.getByName(orgId).status()).outboxDepth).toBe(0);
  });
});
