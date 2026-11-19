import type { InferenceTier } from '@gitvise/core';

/**
 * Commercial catalogue. All money is integer pence (GBP).
 *
 * PLACEHOLDER VALUES: the model cost rates below are engineering assumptions, not measured Workers AI
 * prices. Re-derive them from your actual usage before launch, and keep the Stripe prices in sync.
 */

export type PaidTier = 'pro' | 'business' | 'enterprise';

export interface PlanDefinition {
  readonly tier: PaidTier;
  readonly label: string;
  /** Per seat per month, in pence. Pro is single-seat, so its price is the whole plan. */
  readonly monthlyPricePencePerSeat: number;
  /** Credits included per seat each billing period. Pooled across the organisation for multi-seat plans. */
  readonly includedCreditsPencePerSeat: number;
  readonly perSeat: boolean;
  readonly samlSso: boolean;
  readonly b4AuditLog: boolean;
}

export const PLANS: Readonly<Record<PaidTier, PlanDefinition>> = {
  pro: {
    tier: 'pro',
    label: 'Pro',
    monthlyPricePencePerSeat: 1900,
    includedCreditsPencePerSeat: 800,
    perSeat: false,
    samlSso: false,
    b4AuditLog: false,
  },
  business: {
    tier: 'business',
    label: 'Business',
    monthlyPricePencePerSeat: 2900,
    includedCreditsPencePerSeat: 1200,
    perSeat: true,
    samlSso: false,
    b4AuditLog: false,
  },
  enterprise: {
    tier: 'enterprise',
    label: 'Enterprise',
    monthlyPricePencePerSeat: 4900,
    includedCreditsPencePerSeat: 2000,
    perSeat: true,
    samlSso: true,
    b4AuditLog: true,
  },
};

export const TOPUP_PACK = {
  label: '£15 credit top-up',
  pricePence: 1500,
  creditsPence: 1500,
} as const;

export const PAID_TIERS: readonly PaidTier[] = ['pro', 'business', 'enterprise'];

export function isPaidTier(value: unknown): value is PaidTier {
  return typeof value === 'string' && (PAID_TIERS as readonly string[]).includes(value);
}

/** Included credits for a subscription: Pro is always one seat; other tiers pool `seats` × allowance. */
export function monthlyAllotmentPence(tier: PaidTier, seats: number): number {
  const plan = PLANS[tier];
  return plan.includedCreditsPencePerSeat * (plan.perSeat ? seats : 1);
}

/**
 * Cost rates in pence per million tokens (PLACEHOLDER, see above). The external fallback is priced
 * separately because it is billed by another provider.
 */
export const MODEL_RATE_PENCE_PER_MILLION_TOKENS: Readonly<Record<InferenceTier, number>> = {
  'fast-3b': 5,
  'worker-7b': 10,
  'architect-30b': 60,
};

export const EXTERNAL_FALLBACK_RATE_PENCE_PER_MILLION_TOKENS = 100;

/** Cost in pence, rounded up so a call is never billed as free. */
export function costPence(tokens: number, ratePencePerMillion: number): number {
  return Math.ceil((tokens * ratePencePerMillion) / 1_000_000);
}
