import type { GatewayEnv } from '../env';
import type { BillingGuardDurableObject } from './billing-guard';
import { ledgerTotals, recordUsage, refreshMirror } from './ledger';

/**
 * Reconciles each organisation's live balances against the D1 ledger, and retries usage rows that never reached D1.
 *
 * Two steps per org:
 *  1. Flush. Write every outbox record to D1, then acknowledge it. The writes are idempotent on the request id, so
 *     a record that did reach D1 before a failed ack is harmless to write again.
 *  2. Compare. The ledger sum per bucket must equal the guard's balance. The guard is authoritative, so a mismatch
 *     is reported and never corrected automatically. The mirror on `organizations` is refreshed to the guard's values.
 *
 * A comparison made while usage is still in flight is skipped. A mismatch is re-sampled once before it counts, since
 * a settlement can land between the two reads.
 */

export interface ReconcileOptions {
  /** Restricts the run to these orgs. Defaults to every org in D1. */
  readonly orgIds?: readonly string[];
  /** Upper bound on orgs per run, so one scheduled invocation stays inside its CPU and subrequest limits. */
  readonly maxOrgs?: number;
  /** Outbox records flushed per org per run. */
  readonly outboxBatch?: number;
}

export type ReconcileOutcome = 'balanced' | 'mismatch' | 'in-flight';

export interface OrgReconciliation {
  readonly orgId: string;
  readonly outcome: ReconcileOutcome;
  readonly flushed: number;
  readonly flushFailed: number;
  readonly live: { readonly monthlyPence: number; readonly topupPence: number };
  readonly ledger: { readonly monthlyPence: number; readonly topupPence: number };
}

export interface ReconcileReport {
  readonly checkedAtMs: number;
  readonly orgs: readonly OrgReconciliation[];
  readonly flushed: number;
  readonly flushFailed: number;
  readonly mismatches: number;
  readonly inFlight: number;
}

const DEFAULT_MAX_ORGS = 500;
const DEFAULT_OUTBOX_BATCH = 200;

export async function reconcileBilling(
  env: Pick<GatewayEnv, 'D1' | 'BILLING_GUARD'>,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const orgIds = options.orgIds ?? (await listOrgIds(env.D1, options.maxOrgs ?? DEFAULT_MAX_ORGS));
  const results: OrgReconciliation[] = [];
  for (const orgId of orgIds) {
    results.push(await reconcileOrg(env, orgId, options.outboxBatch ?? DEFAULT_OUTBOX_BATCH));
  }
  return {
    checkedAtMs: Date.now(),
    orgs: results,
    flushed: sum(results, (result) => result.flushed),
    flushFailed: sum(results, (result) => result.flushFailed),
    mismatches: results.filter((result) => result.outcome === 'mismatch').length,
    inFlight: results.filter((result) => result.outcome === 'in-flight').length,
  };
}

async function reconcileOrg(
  env: Pick<GatewayEnv, 'D1' | 'BILLING_GUARD'>,
  orgId: string,
  outboxBatch: number,
): Promise<OrgReconciliation> {
  const guard = env.BILLING_GUARD.getByName(orgId);
  const flush = await flushOutbox(env.D1, guard, orgId, outboxBatch);

  let sample = await sampleOrg(env.D1, guard, orgId);
  if (sample.outcome === 'mismatch') {
    // Re-sample before reporting, so a settlement that landed between the two reads does not look like drift.
    sample = await sampleOrg(env.D1, guard, orgId);
  }

  if (sample.outcome === 'mismatch') {
    console.error(
      `billing drift for ${orgId}: live monthly=${sample.live.monthlyPence} topup=${sample.live.topupPence}, ` +
        `ledger monthly=${sample.ledger.monthlyPence} topup=${sample.ledger.topupPence}`,
    );
  }
  if (sample.outcome !== 'in-flight') {
    await refreshMirror(env.D1, orgId, sample.live.monthlyPence, sample.live.topupPence);
  }

  return {
    orgId,
    outcome: sample.outcome,
    flushed: flush.flushed,
    flushFailed: flush.failed,
    live: sample.live,
    ledger: sample.ledger,
  };
}

async function flushOutbox(
  db: D1Database,
  guard: DurableObjectStub<BillingGuardDurableObject>,
  orgId: string,
  batch: number,
): Promise<{ readonly flushed: number; readonly failed: number }> {
  const pending = await guard.pendingUsage(batch);
  let flushed = 0;
  let failed = 0;
  for (const record of pending) {
    try {
      // The record is written with its own debits and ledger rows, but not the mirror. The mirror is refreshed later
      // from the guard, so an old record cannot move it backwards.
      await recordUsage(db, record, { refreshMirror: false });
      await guard.ackUsage(record.requestId);
      flushed += 1;
    } catch (error) {
      failed += 1;
      console.error(`outbox flush failed for ${orgId}/${record.requestId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { flushed, failed };
}

async function sampleOrg(
  db: D1Database,
  guard: DurableObjectStub<BillingGuardDurableObject>,
  orgId: string,
): Promise<{
  readonly outcome: ReconcileOutcome;
  readonly live: { readonly monthlyPence: number; readonly topupPence: number };
  readonly ledger: { readonly monthlyPence: number; readonly topupPence: number };
}> {
  // Ledger first, then the guard. A settlement that happens in between leaves an outbox row behind, and that marks
  // the sample as in flight rather than as a mismatch.
  const ledger = await ledgerTotals(db, orgId);
  const live = await guard.status();
  const liveBalances = { monthlyPence: live.monthlyPence, topupPence: live.topupPence };
  if (live.outboxDepth > 0) return { outcome: 'in-flight', live: liveBalances, ledger };
  const balanced = live.monthlyPence === ledger.monthlyPence && live.topupPence === ledger.topupPence;
  return { outcome: balanced ? 'balanced' : 'mismatch', live: liveBalances, ledger };
}

async function listOrgIds(db: D1Database, limit: number): Promise<string[]> {
  const rows = await db.prepare('SELECT id FROM organizations ORDER BY id LIMIT ?1').bind(limit).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
