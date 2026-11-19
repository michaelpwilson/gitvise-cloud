import { describe, expect, it } from 'vitest';
import { computeStripeSignature, verifyStripeSignature } from '../src/billing/stripe';

const SECRET = 'whsec_test_secret';
const PAYLOAD = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { subscription: 'sub_1' } } });

async function headerFor(timestamp: number, payload = PAYLOAD, secret = SECRET): Promise<string> {
  return `t=${timestamp},v1=${await computeStripeSignature(secret, timestamp, payload)}`;
}

describe('verifyStripeSignature', () => {
  const now = 1_800_000_000;

  it('accepts a payload signed with the webhook secret, inside the tolerance window', async () => {
    const valid = await verifyStripeSignature({
      payload: PAYLOAD,
      header: await headerFor(now),
      secret: SECRET,
      nowSeconds: now + 10,
    });
    expect(valid).toBe(true);
  });

  it('rejects a payload that was changed after signing', async () => {
    const tampered = PAYLOAD.replace('sub_1', 'sub_2');
    expect(
      await verifyStripeSignature({ payload: tampered, header: await headerFor(now), secret: SECRET, nowSeconds: now }),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', async () => {
    expect(
      await verifyStripeSignature({
        payload: PAYLOAD,
        header: await headerFor(now, PAYLOAD, 'whsec_other'),
        secret: SECRET,
        nowSeconds: now,
      }),
    ).toBe(false);
  });

  it('rejects a signed event older than the 300 second tolerance, which blocks replay', async () => {
    expect(
      await verifyStripeSignature({ payload: PAYLOAD, header: await headerFor(now), secret: SECRET, nowSeconds: now + 301 }),
    ).toBe(false);
  });

  it('rejects a timestamp from the future by the same margin', async () => {
    expect(
      await verifyStripeSignature({ payload: PAYLOAD, header: await headerFor(now + 1_000), secret: SECRET, nowSeconds: now }),
    ).toBe(false);
  });

  it('accepts when any of several v1 signatures matches, as Stripe sends during secret rotation', async () => {
    const good = await computeStripeSignature(SECRET, now, PAYLOAD);
    const stale = await computeStripeSignature('whsec_rotated_out', now, PAYLOAD);
    const header = `t=${now},v1=${stale},v1=${good}`;
    expect(await verifyStripeSignature({ payload: PAYLOAD, header, secret: SECRET, nowSeconds: now })).toBe(true);
  });

  it('rejects a missing header, a malformed header, and an empty secret', async () => {
    expect(await verifyStripeSignature({ payload: PAYLOAD, header: null, secret: SECRET, nowSeconds: now })).toBe(false);
    expect(await verifyStripeSignature({ payload: PAYLOAD, header: 'garbage', secret: SECRET, nowSeconds: now })).toBe(false);
    expect(await verifyStripeSignature({ payload: PAYLOAD, header: `t=${now},v1=zz`, secret: SECRET, nowSeconds: now })).toBe(
      false,
    );
    expect(
      await verifyStripeSignature({ payload: PAYLOAD, header: await headerFor(now), secret: '', nowSeconds: now }),
    ).toBe(false);
  });
});
