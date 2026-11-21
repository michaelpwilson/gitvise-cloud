import { GitViseError } from '@gitvise/core';
import { isPaidTier, PLANS } from './plans';
import { setSubscriptionQuantity, subscriptionItemId } from './stripe';

/**
 * Changes an organisation's seat count on its active Business or Enterprise subscription. Stripe is changed first, and
 * the local mirror is written only after Stripe accepts the change, so the database never claims a seat count Stripe
 * did not apply. Pro is a fixed single seat and is refused.
 *
 * The monthly credit allowance grows with seats on the next invoice, not at once. The next `invoice.paid` recomputes it.
 */
export async function changeSeats(
  input: { readonly db: D1Database; readonly secretKey: string; readonly orgId: string; readonly seats: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{ seats: number }> {
  const subscription = await input.db
    .prepare(
      `SELECT id, tier FROM subscriptions
        WHERE org_id = ?1 AND status IN ('active', 'trialing')
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(input.orgId)
    .first<{ id: string; tier: string }>();
  if (subscription === null) throw new GitViseError('INVALID_STATE', 'there is no active subscription to change');
  if (!isPaidTier(subscription.tier) || !PLANS[subscription.tier].perSeat) {
    throw new GitViseError('INVALID_REQUEST', 'this plan has a fixed single seat');
  }

  const itemId = await subscriptionItemId(input.secretKey, subscription.id, fetchImpl);
  await setSubscriptionQuantity(input.secretKey, subscription.id, itemId, input.seats, fetchImpl);

  await input.db.batch([
    input.db
      .prepare('UPDATE subscriptions SET seats = ?1, updated_at = unixepoch() WHERE id = ?2')
      .bind(input.seats, subscription.id),
    input.db
      .prepare('UPDATE organizations SET seats = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(input.seats, Date.now(), input.orgId),
  ]);
  return { seats: input.seats };
}
