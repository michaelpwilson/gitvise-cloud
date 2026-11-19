import type { InferenceTier } from '@gitvise/core';

/** What a call consumed and who made it. The guard records these in its outbox at the moment it debits. */
export interface UsageFacts {
  readonly orgId: string;
  readonly userId: string;
  readonly tier: InferenceTier;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** One immutable usage row, written once per call. `requestId` is the primary key. */
export interface UsageRecord extends UsageFacts {
  readonly requestId: string;
  readonly costPence: number;
  readonly monthlyDebitPence: number;
  readonly topupDebitPence: number;
  /** Balances after this settlement, from the Durable Object. */
  readonly monthlyPenceAfter: number;
  readonly topupPenceAfter: number;
  /** True when this settlement was a replay of an earlier one and debited nothing new. */
  readonly duplicate: boolean;
}
