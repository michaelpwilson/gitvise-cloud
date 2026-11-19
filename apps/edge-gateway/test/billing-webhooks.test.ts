import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { GatewayEnv } from '../src/env';
import { RetryableWebhookError } from '../src/billing/errors';
import { applyStripeEvent } from '../src/billing/webhooks';
import { computeStripeSignature, type StripeEvent } from '../src/billing/stripe';
import { testEnv, uniqueId, httpEnv, TEST_SECRETS } from './support/bindings';
import { addMember, bearer, mintKey, registerAccount } from './support/auth';

const WEBHOOK_SECRET = TEST_SECRETS.STRIPE_WEBHOOK_SECRET;

function deps() {
  return { db: testEnv.D1, guards: testEnv.BILLING_GUARD };
}

function checkoutCompleted(id: string, metadata: Record<string, string>, extra: Record<string, unknown> = {}): StripeEvent {
  return { id, type: 'checkout.session.completed', data: { object: { metadata, ...extra } } };
}

function subscriptionCheckout(id: string, orgId: string, tier: string, seats: number, subscriptionId: string): StripeEvent {
  return checkoutCompleted(
    id,
    { orgId, kind: 'subscription', tier, seats: String(seats) },
    { subscription: subscriptionId, customer: `cus_${orgId}` },
  );
}

function topupCheckout(id: string, orgId: string): StripeEvent {
  return checkoutCompleted(id, { orgId, kind: 'topup', creditPence: '1500' });
}

function invoicePaid(id: string, subscriptionId: string): StripeEvent {
  return { id, type: 'invoice.paid', data: { object: { subscription: subscriptionId } } };
}

function subscriptionDeleted(id: string, subscriptionId: string): StripeEvent {
  return { id, type: 'customer.subscription.deleted', data: { object: { id: subscriptionId } } };
}

describe('Stripe event handlers', () => {
  it('grants a top-up pack once, however many times the event is applied', async () => {
    const orgId = uniqueId('org');
    await applyStripeEvent(topupCheckout('evt_topup_once', orgId), deps());
    await applyStripeEvent(topupCheckout('evt_topup_once', orgId), deps());

    const status = await testEnv.BILLING_GUARD.getByName(orgId).status();
    expect(status.topupPence).toBe(1500);
  });

  it('a business subscription sets pooled monthly credit for every seat', async () => {
    const orgId = uniqueId('org');
    const subId = uniqueId('sub');
    await applyStripeEvent(subscriptionCheckout('evt_biz', orgId, 'business', 3, subId), deps());

    const status = await testEnv.BILLING_GUARD.getByName(orgId).status();
    expect(status.monthlyPence).toBe(3 * 1200);

    const org = await testEnv.D1.prepare('SELECT tier, seats FROM organizations WHERE id = ?').bind(orgId).first<{ tier: string; seats: number }>();
    expect(org).toEqual({ tier: 'business', seats: 3 });
  });

  it('invoice.paid resets monthly credit to the allowance and keeps top-up credit', async () => {
    const orgId = uniqueId('org');
    const subId = uniqueId('sub');
    const guard = testEnv.BILLING_GUARD.getByName(orgId);

    await applyStripeEvent(topupCheckout('evt_topup_keep', orgId), deps());
    await applyStripeEvent(subscriptionCheckout('evt_sub_keep', orgId, 'business', 2, subId), deps());

    // Spend 500 pence of monthly credit during the period.
    const usage = { orgId, userId: 'user-1', tier: 'fast-3b' as const, model: 'test', promptTokens: 0, completionTokens: 0 };
    await guard.reserve({ requestId: 'period-spend', estimatePence: 500 });
    await guard.settle({ requestId: 'period-spend', actualPence: 500, usage });
    expect((await guard.status()).monthlyPence).toBe(2 * 1200 - 500);

    await applyStripeEvent(invoicePaid('evt_inv_next', subId), deps());

    const status = await guard.status();
    expect(status.monthlyPence).toBe(2 * 1200);
    expect(status.topupPence).toBe(1500);
  });

  it('invoice.paid for a subscription we have not recorded yet is retryable, so Stripe redelivers it', async () => {
    await expect(applyStripeEvent(invoicePaid('evt_orphan', uniqueId('sub')), deps())).rejects.toBeInstanceOf(
      RetryableWebhookError,
    );
  });

  it('a cancelled subscription clears the plan and monthly credit, but keeps top-up credit', async () => {
    const orgId = uniqueId('org');
    const subId = uniqueId('sub');
    await applyStripeEvent(topupCheckout('evt_topup_cancel', orgId), deps());
    await applyStripeEvent(subscriptionCheckout('evt_sub_cancel', orgId, 'enterprise', 1, subId), deps());

    await applyStripeEvent(subscriptionDeleted('evt_deleted', subId), deps());

    const status = await testEnv.BILLING_GUARD.getByName(orgId).status();
    expect(status.monthlyPence).toBe(0);
    expect(status.topupPence).toBe(1500);

    const org = await testEnv.D1.prepare('SELECT tier, saml_sso_enabled, b4_audit_log_enabled FROM organizations WHERE id = ?')
      .bind(orgId)
      .first<{ tier: string; saml_sso_enabled: number; b4_audit_log_enabled: number }>();
    expect(org).toEqual({ tier: 'none', saml_sso_enabled: 0, b4_audit_log_enabled: 0 });
  });

  it('an enterprise subscription enables SAML/SSO and the B4 audit log', async () => {
    const orgId = uniqueId('org');
    await applyStripeEvent(subscriptionCheckout('evt_ent', orgId, 'enterprise', 4, uniqueId('sub')), deps());

    const org = await testEnv.D1.prepare('SELECT saml_sso_enabled, b4_audit_log_enabled, monthly_credits_remaining_pence AS monthly FROM organizations WHERE id = ?')
      .bind(orgId)
      .first<{ saml_sso_enabled: number; b4_audit_log_enabled: number; monthly: number }>();
    expect(org).toEqual({ saml_sso_enabled: 1, b4_audit_log_enabled: 1, monthly: 4 * 2000 });
  });

  it('the usage ledger is append-only: UPDATE and DELETE are refused by the database', async () => {
    const orgId = uniqueId('org');
    await applyStripeEvent(topupCheckout('evt_ledger', orgId), deps());

    await expect(testEnv.D1.prepare('UPDATE credit_ledger SET amount_pence = 0 WHERE org_id = ?').bind(orgId).run()).rejects.toThrow(
      /append-only/,
    );
    await expect(testEnv.D1.prepare('DELETE FROM credit_ledger WHERE org_id = ?').bind(orgId).run()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('HTTP routes', () => {
  const env: GatewayEnv = httpEnv({
    // Declared so the tier is available and the call reaches the metering check, rather than failing on config.
    AI_MODEL_FAST_3B: '@cf/meta/llama-3.2-3b-instruct',
  });

  it('GET /api/health answers without a token', async () => {
    const response = await app.request('/api/health', {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('GET /api/billing/status needs a tenant credential and reports the caller’s own org only', async () => {
    const account = await registerAccount(env);
    const other = await registerAccount(env);
    await applyStripeEvent(topupCheckout(uniqueId('evt'), account.orgId), deps());
    await applyStripeEvent(topupCheckout(uniqueId('evt'), other.orgId), deps());
    const url = '/api/billing/status';

    expect((await app.request(url, {}, env)).status).toBe(401);
    // The operator token is not a tenant credential.
    expect((await app.request(url, { headers: bearer(TEST_SECRETS.GATEWAY_API_TOKEN) }, env)).status).toBe(401);

    const key = await mintKey(env, account);
    const authorised = await app.request(url, { headers: bearer(key.key) }, env);
    expect(authorised.status).toBe(200);
    const body = (await authorised.json()) as { orgId: string; balancePence: { topup: number; available: number }; hardCap: boolean };
    expect(body.orgId).toBe(account.orgId);
    expect(body.balancePence).toMatchObject({ topup: 1500, available: 1500 });
    expect(body.hardCap).toBe(true);

    // A query string naming another org changes nothing.
    const spoofed = await app.request(`${url}?orgId=${other.orgId}`, { headers: bearer(key.key) }, env);
    expect(((await spoofed.json()) as { orgId: string }).orgId).toBe(account.orgId);
  });

  it('the inference route answers 402 with a top-up hint when the organisation has no credit', async () => {
    const account = await registerAccount(env);
    const key = await mintKey(env, account);
    const response = await app.request(
      '/v1/inference/fast-3b',
      {
        method: 'POST',
        headers: { ...bearer(key.key), 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: uniqueId('req'),
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
      env,
    );

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string }; topUp: { path: string; body: { kind: string } } };
    expect(body.error.code).toBe('CREDITS_EXHAUSTED');
    expect(body.topUp).toMatchObject({ path: '/api/billing/checkout', body: { kind: 'topup' } });
  });

  it('the webhook accepts a correctly signed event, applies it once, and acknowledges replays', async () => {
    const orgId = uniqueId('org');
    const payload = JSON.stringify(topupCheckout(uniqueId('evt'), orgId));
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPost = async () => {
      const signature = await computeStripeSignature(WEBHOOK_SECRET, timestamp, payload);
      return app.request(
        '/api/webhooks/stripe',
        { method: 'POST', headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }, body: payload },
        env,
      );
    };

    const first = await signedPost();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, handled: true });

    const replay = await signedPost();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });

    expect((await testEnv.BILLING_GUARD.getByName(orgId).status()).topupPence).toBe(1500);
  });

  it('checkout is owner-only, fails closed when Stripe is not configured, and validates the purchase kind', async () => {
    const owner = await registerAccount(env);
    const ownerKey = await mintKey(env, owner);
    const headers = { ...bearer(ownerKey.key), 'content-type': 'application/json' };

    const unconfigured = await app.request(
      '/api/billing/checkout',
      { method: 'POST', headers, body: JSON.stringify({ kind: 'topup' }) },
      env,
    );
    expect(unconfigured.status).toBe(503);

    const badKind = await app.request(
      '/api/billing/checkout',
      { method: 'POST', headers, body: JSON.stringify({ kind: 'refund' }) },
      httpEnv({ STRIPE_SECRET_KEY: 'sk_test', BILLING_RETURN_URL: 'https://example.test/billing' }),
    );
    expect(badKind.status).toBe(400);

    // A member's key cannot buy anything, even though it authenticates.
    const member = await addMember(env, owner);
    const memberKey = await mintKey(env, member);
    const forbidden = await app.request(
      '/api/billing/checkout',
      { method: 'POST', headers: { ...bearer(memberKey.key), 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'topup' }) },
      httpEnv({ STRIPE_SECRET_KEY: 'sk_test', BILLING_RETURN_URL: 'https://example.test/billing', STRIPE_PRICE_TOPUP_15: 'price_x' }),
    );
    expect(forbidden.status).toBe(403);
  });

  it('the webhook refuses a bad signature and a missing webhook secret', async () => {
    const payload = JSON.stringify(topupCheckout(uniqueId('evt'), uniqueId('org')));
    const badSignature = await app.request(
      '/api/webhooks/stripe',
      { method: 'POST', headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=00` }, body: payload },
      env,
    );
    expect(badSignature.status).toBe(400);

    const unconfigured = await app.request(
      '/api/webhooks/stripe',
      { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: payload },
      { ...env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as GatewayEnv,
    );
    expect(unconfigured.status).toBe(503);
  });
});
