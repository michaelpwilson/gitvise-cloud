import { DurableObject } from 'cloudflare:workers';
import type { UsageFacts, UsageRecord } from './usage';

/**
 * Single writer for one organisation's live credit balance. Addressed by `orgId`.
 *
 * Each LLM call goes through three steps:
 *  1. `reserve` places a hold for the estimated cost. A hold counts against the balance, so concurrent
 *     calls cannot all spend the same credit.
 *  2. The model runs.
 *  3. `settle` removes the hold, debits the actual cost once, and writes the usage record to an outbox in the same
 *     synchronous step. Retries with the same request id are no-ops.
 *
 * The outbox is what makes usage durable. A record stays there until the D1 ledger has it, and `ackUsage` removes it.
 * If the inline D1 write fails, the scheduled reconciliation finds the record and writes it. Nothing is debited
 * without a record existing somewhere that can still be written.
 *
 * Race safety. Every method reads and writes state through the synchronous KV API (`ctx.storage.kv`) with no
 * `await` between the read and the write. Each method therefore runs to completion before any other RPC can
 * interleave. An asynchronous read-modify-write would not be safe: another request could read the old balance
 * during the gap, and the balance check would be wrong. The `await` on `storage.get` was exactly that gap.
 *
 * A hold that is never settled (for example, the Worker died mid-stream) expires after `HOLD_TTL_MS`.
 */

/** Longest a reservation may stand before it is treated as abandoned. */
export const HOLD_TTL_MS = 15 * 60 * 1000;

interface Hold {
  readonly amountPence: number;
  readonly expiresAtMs: number;
}

interface BillingState {
  monthlyPence: number;
  topupPence: number;
  hardCap: boolean;
  holds: Record<string, Hold>;
}

export interface BillingStatus {
  readonly monthlyPence: number;
  readonly topupPence: number;
  readonly heldPence: number;
  readonly availablePence: number;
  readonly hardCap: boolean;
  /** Usage records settled here but not yet acknowledged by D1. Non-zero means D1 is behind. */
  readonly outboxDepth: number;
}

export type ReserveResult =
  | { readonly ok: true; readonly availablePence: number }
  | { readonly ok: false; readonly reason: 'exhausted'; readonly availablePence: number };

export interface SettleInput {
  readonly requestId: string;
  readonly actualPence: number;
  readonly usage: UsageFacts;
}

export interface GrantResult {
  readonly applied: boolean;
  readonly bucket: 'monthly' | 'topup';
  /** Signed change in the bucket this call made. Zero when `applied` is false. */
  readonly deltaPence: number;
  readonly monthlyPence: number;
  readonly topupPence: number;
}

const STATE_KEY = 'state';
const OUTBOX_PREFIX = 'outbox:';
const SETTLED_PREFIX = 'settled:';
const REF_PREFIX = 'ref:';

export class BillingGuardDurableObject extends DurableObject<unknown> {
  /** Current balances and outstanding holds. Expired holds are dropped as part of the read. */
  async status(): Promise<BillingStatus> {
    const state = this.load();
    const heldPence = pruneAndSum(state, Date.now());
    this.save(state);
    const outboxDepth = [...this.ctx.storage.kv.list({ prefix: OUTBOX_PREFIX })].length;
    return toStatus(state, heldPence, outboxDepth);
  }

  /** Turns the hard cap on or off. Off means the org may overdraw, and the overage is still recorded. */
  async setHardCap(enabled: boolean): Promise<void> {
    const state = this.load();
    state.hardCap = enabled;
    this.save(state);
  }

  /** Adds credit to one bucket. Idempotent on `ref`, so a redelivered webhook cannot grant twice. */
  async grant(input: { readonly ref: string; readonly bucket: 'monthly' | 'topup'; readonly amountPence: number }): Promise<GrantResult> {
    assertPence(input.amountPence);
    const marker = refKey(input.ref);
    const state = this.load();
    if (this.ctx.storage.kv.get(marker) !== undefined) return grantResult(state, false, input.bucket, 0);

    if (input.bucket === 'monthly') state.monthlyPence += input.amountPence;
    else state.topupPence += input.amountPence;
    this.save(state);
    this.ctx.storage.kv.put(marker, true);
    return grantResult(state, true, input.bucket, input.amountPence);
  }

  /**
   * Replaces the monthly allowance at the start of a billing period. The top-up bucket is left alone,
   * because top-up credit does not expire. Idempotent on `ref`.
   */
  async resetMonthly(input: { readonly ref: string; readonly amountPence: number }): Promise<GrantResult> {
    assertPence(input.amountPence);
    const marker = refKey(input.ref);
    const state = this.load();
    if (this.ctx.storage.kv.get(marker) !== undefined) return grantResult(state, false, 'monthly', 0);

    const delta = input.amountPence - state.monthlyPence;
    state.monthlyPence = input.amountPence;
    this.save(state);
    this.ctx.storage.kv.put(marker, true);
    return grantResult(state, true, 'monthly', delta);
  }

  /**
   * Places a hold for `estimatePence` if the balance covers it. Refused only when the hard cap is on and
   * nothing is available. Calls with the same `requestId` are idempotent.
   */
  async reserve(input: { readonly requestId: string; readonly estimatePence: number }): Promise<ReserveResult> {
    assertPence(input.estimatePence);
    const now = Date.now();
    const state = this.load();
    const heldPence = pruneAndSum(state, now);
    const availablePence = state.monthlyPence + state.topupPence - heldPence;

    if (state.holds[input.requestId] !== undefined) {
      this.save(state);
      return { ok: true, availablePence };
    }
    if (state.hardCap && availablePence <= 0) {
      this.save(state);
      return { ok: false, reason: 'exhausted', availablePence };
    }

    state.holds[input.requestId] = { amountPence: input.estimatePence, expiresAtMs: now + HOLD_TTL_MS };
    this.save(state);
    return { ok: true, availablePence };
  }

  /** Drops a hold without charging. Used when the call fails before any tokens are produced. */
  async release(requestId: string): Promise<void> {
    const state = this.load();
    if (state.holds[requestId] === undefined) return;
    delete state.holds[requestId];
    this.save(state);
  }

  /**
   * Debits the actual cost, removes the hold, and writes the usage record to the outbox. Monthly credit is spent
   * first, then top-up. Idempotent on `requestId`: a second settlement returns the first record with
   * `duplicate: true` and debits nothing.
   */
  async settle(input: SettleInput): Promise<UsageRecord> {
    assertPence(input.actualPence);
    const settledKey = `${SETTLED_PREFIX}${input.requestId}`;
    const prior = this.ctx.storage.kv.get<UsageRecord>(settledKey);
    if (prior !== undefined) return { ...prior, duplicate: true };

    const state = this.load();
    delete state.holds[input.requestId];

    const costPence = Math.ceil(input.actualPence);
    const monthlyDebitPence = Math.min(Math.max(state.monthlyPence, 0), costPence);
    const topupDebitPence = costPence - monthlyDebitPence;
    state.monthlyPence -= monthlyDebitPence;
    state.topupPence -= topupDebitPence;

    const record: UsageRecord = {
      ...input.usage,
      requestId: input.requestId,
      costPence,
      monthlyDebitPence,
      topupDebitPence,
      monthlyPenceAfter: state.monthlyPence,
      topupPenceAfter: state.topupPence,
      duplicate: false,
    };
    // All three writes are synchronous, so they land together or not at all.
    this.save(state);
    this.ctx.storage.kv.put(settledKey, record);
    this.ctx.storage.kv.put(outboxKey(input.requestId), record);
    return record;
  }

  /** Usage records not yet acknowledged by D1, oldest key first. Used by the scheduled reconciliation. */
  async pendingUsage(limit: number): Promise<UsageRecord[]> {
    return [...this.ctx.storage.kv.list<UsageRecord>({ prefix: OUTBOX_PREFIX, limit })].map(([, record]) => record);
  }

  /** Removes a record from the outbox once D1 holds it. Idempotent. */
  async ackUsage(requestId: string): Promise<void> {
    this.ctx.storage.kv.delete(outboxKey(requestId));
  }

  private load(): BillingState {
    return this.ctx.storage.kv.get<BillingState>(STATE_KEY) ?? structuredClone(DEFAULT_STATE);
  }

  private save(state: BillingState): void {
    this.ctx.storage.kv.put(STATE_KEY, state);
  }
}

const DEFAULT_STATE: BillingState = { monthlyPence: 0, topupPence: 0, hardCap: true, holds: {} };

function grantResult(state: BillingState, applied: boolean, bucket: 'monthly' | 'topup', deltaPence: number): GrantResult {
  return {
    applied,
    bucket,
    deltaPence: applied ? deltaPence : 0,
    monthlyPence: state.monthlyPence,
    topupPence: state.topupPence,
  };
}

function refKey(ref: string): string {
  return `${REF_PREFIX}${ref}`;
}

function outboxKey(requestId: string): string {
  return `${OUTBOX_PREFIX}${requestId}`;
}

function assertPence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`pence amount must be a non-negative integer, got ${value}`);
  }
}

/** Drops expired holds in place and returns the sum of the live ones. */
function pruneAndSum(state: BillingState, nowMs: number): number {
  let total = 0;
  for (const [id, hold] of Object.entries(state.holds)) {
    if (hold.expiresAtMs <= nowMs) {
      delete state.holds[id];
    } else {
      total += hold.amountPence;
    }
  }
  return total;
}

function toStatus(state: BillingState, heldPence: number, outboxDepth: number): BillingStatus {
  return {
    monthlyPence: state.monthlyPence,
    topupPence: state.topupPence,
    heldPence,
    availablePence: state.monthlyPence + state.topupPence - heldPence,
    hardCap: state.hardCap,
    outboxDepth,
  };
}
