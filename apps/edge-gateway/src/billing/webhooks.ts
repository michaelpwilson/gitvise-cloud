import type { BillingGuardDurableObject } from './billing-guard';
import { RetryableWebhookError } from './errors';
import {
  applyPlan,
  clearPlan,
  ensureOrganization,
  findSubscription,
  recordGrant,
  upsertSubscription,
} from './ledger';
import { isPaidTier, monthlyAllotmentPence, PLANS, TOPUP_PACK } from './plans';
import { stringField, type StripeEvent, type StripeObject } from './stripe';

/** Stripe events this service acts on. Anything else is acknowledged and ignored. */
export const HANDLED_STRIPE_EVENTS: readonly string[] = [
  'checkout.session.completed',
  'invoice.paid',
  'customer.subscription.deleted',
];

export interface BillingEventDeps {
  readonly db: D1Database;
  readonly guards: DurableObjectNamespace<BillingGuardDurableObject>;
}

export type BillingEventOutcome = 'applied' | 'ignored';

/**
 * Applies one Stripe event to billing state. Each step is idempotent on `event.id`, so a redelivered event
 * changes nothing. A missing subscription throws `RetryableWebhookError`, so Stripe redelivers the event
 * after the checkout that creates it has been processed.
 */
export async function applyStripeEvent(event: StripeEvent, deps: BillingEventDeps): Promise<BillingEventOutcome> {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event, deps);
    case 'invoice.paid':
      return onInvoicePaid(event, deps);
    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event, deps);
    default:
      return 'ignored';
  }
}

async function onCheckoutCompleted(event: StripeEvent, deps: BillingEventDeps): Promise<BillingEventOutcome> {
  const session = event.data.object;
  const metadata = metadataOf(session);
  const orgId = metadata.orgId;
  if (orgId === undefined || orgId === '') return 'ignored';

  const guard = deps.guards.getByName(orgId);
  await ensureOrganization(deps.db, orgId, orgId);

  if (metadata.kind === 'topup') {
    // Only the one pack we sell is accepted. Anything else is a misconfigured price, not a credit.
    if (Number(metadata.creditPence) !== TOPUP_PACK.creditsPence) return 'ignored';
    const result = await guard.grant({ ref: event.id, bucket: 'topup', amountPence: TOPUP_PACK.creditsPence });
    await recordGrant(deps.db, orgId, 'topup_purchase', event.id, result);
    return 'applied';
  }

  if (metadata.kind === 'subscription') {
    const tier = metadata.tier;
    if (!isPaidTier(tier)) return 'ignored';
    const seats = PLANS[tier].perSeat ? parseSeats(metadata.seats) : 1;
    if (seats === undefined) return 'ignored';

    const subscriptionId = stringField(session, 'subscription');
    if (subscriptionId === undefined) return 'ignored';
    const customerId = stringField(session, 'customer') ?? null;

    await applyPlan(deps.db, {
      orgId,
      tier,
      seats,
      stripeCustomerId: customerId,
      samlSso: PLANS[tier].samlSso,
      b4AuditLog: PLANS[tier].b4AuditLog,
    });
    await upsertSubscription(deps.db, {
      id: subscriptionId,
      orgId,
      tier,
      seats,
      status: 'active',
      currentPeriodEnd: null,
    });
    const result = await guard.resetMonthly({ ref: event.id, amountPence: monthlyAllotmentPence(tier, seats) });
    await recordGrant(deps.db, orgId, 'subscription_grant', event.id, result);
    return 'applied';
  }

  return 'ignored';
}

async function onInvoicePaid(event: StripeEvent, deps: BillingEventDeps): Promise<BillingEventOutcome> {
  const subscriptionId = stringField(event.data.object, 'subscription');
  // One-off invoices have no subscription. They carry no monthly allowance to reset.
  if (subscriptionId === undefined) return 'ignored';

  const subscription = await findSubscription(deps.db, subscriptionId);
  if (subscription === null) throw new RetryableWebhookError(`subscription ${subscriptionId} is not known yet`);
  if (!isPaidTier(subscription.tier)) return 'ignored';

  // Resets the monthly bucket only. The top-up bucket is non-expiring and is not touched.
  const guard = deps.guards.getByName(subscription.org_id);
  const result = await guard.resetMonthly({
    ref: event.id,
    amountPence: monthlyAllotmentPence(subscription.tier, subscription.seats),
  });
  await recordGrant(deps.db, subscription.org_id, 'monthly_reset', event.id, result);
  return 'applied';
}

async function onSubscriptionDeleted(event: StripeEvent, deps: BillingEventDeps): Promise<BillingEventOutcome> {
  const subscriptionId = stringField(event.data.object, 'id');
  if (subscriptionId === undefined) return 'ignored';

  const subscription = await findSubscription(deps.db, subscriptionId);
  if (subscription === null) return 'ignored';

  await upsertSubscription(deps.db, {
    id: subscriptionId,
    orgId: subscription.org_id,
    tier: isPaidTier(subscription.tier) ? subscription.tier : 'pro',
    seats: subscription.seats,
    status: 'canceled',
    currentPeriodEnd: null,
  });
  await clearPlan(deps.db, subscription.org_id);

  // Remove the monthly allowance, but keep any top-up credit the customer has bought.
  const guard = deps.guards.getByName(subscription.org_id);
  const result = await guard.resetMonthly({ ref: event.id, amountPence: 0 });
  await recordGrant(deps.db, subscription.org_id, 'monthly_reset', event.id, result);
  return 'applied';
}

/** The metadata keys this service writes at checkout. Anything else on the session is ignored. */
interface CheckoutMetadata {
  orgId?: string | undefined;
  kind?: string | undefined;
  tier?: string | undefined;
  seats?: string | undefined;
  creditPence?: string | undefined;
}

function metadataOf(object: StripeObject): CheckoutMetadata {
  const raw = object['metadata'];
  if (typeof raw !== 'object' || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const pick = (key: string): string | undefined => (typeof source[key] === 'string' ? (source[key] as string) : undefined);
  return {
    orgId: pick('orgId'),
    kind: pick('kind'),
    tier: pick('tier'),
    seats: pick('seats'),
    creditPence: pick('creditPence'),
  };
}

function parseSeats(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seats = Number(value);
  return Number.isSafeInteger(seats) && seats >= 1 && seats <= 10_000 ? seats : undefined;
}
