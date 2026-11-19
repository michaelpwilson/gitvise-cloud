import type { GitViseBindings } from '@gitvise/adapter-cloudflare';
import type { BillingGuardDurableObject } from './billing/billing-guard';

/**
 * Everything the gateway Worker is bound to. `GitViseBindings` covers the adapter bindings. This adds the
 * D1 and KV bindings the gateway uses directly, the billing Durable Object, and the secrets and prices
 * for Stripe.
 *
 * Secrets are set with `wrangler secret put`. Prices and URLs are plain vars in wrangler.jsonc.
 */
export interface GatewayEnv extends GitViseBindings {
  /** D1 database holding the commit-to-packfile index, billing, identity, and the Stripe event log. */
  readonly D1: D1Database;
  /** KV namespace for API-key lookups (short-lived cache) and deployment config. */
  readonly KV: KVNamespace;
  /** Single writer for each organisation's live credit balance, addressed by org id. */
  readonly BILLING_GUARD: DurableObjectNamespace<BillingGuardDurableObject>;

  /**
   * Secret. Operator key for internal jobs only (manual reconciliation under `/api/admin/*`). It is never a tenant
   * credential: `/v1/*` and `/api/billing/*` refuse it. Set with `wrangler secret put GATEWAY_API_TOKEN`.
   */
  readonly GATEWAY_API_TOKEN?: string | undefined;
  /**
   * Secret. HMAC key that signs dashboard session tokens. Without it, sign-up and sign-in refuse, and session
   * cookies are never accepted. Set with `wrangler secret put SESSION_SECRET`, using at least 32 random bytes.
   */
  readonly SESSION_SECRET?: string | undefined;

  /** Secret. Stripe API key used for Checkout sessions. */
  readonly STRIPE_SECRET_KEY?: string | undefined;
  /** Secret. Signing secret for webhook endpoints (`whsec_...`). Without it, the webhook route refuses everything. */
  readonly STRIPE_WEBHOOK_SECRET?: string | undefined;
  /** Price ids. Plain vars in wrangler.jsonc. Empty means that product cannot be purchased. */
  readonly STRIPE_PRICE_PRO?: string | undefined;
  readonly STRIPE_PRICE_BUSINESS_SEAT?: string | undefined;
  readonly STRIPE_PRICE_ENTERPRISE_SEAT?: string | undefined;
  readonly STRIPE_PRICE_TOPUP_15?: string | undefined;
  /** Where Checkout sends the customer back to. Must be an https URL you control. */
  readonly BILLING_RETURN_URL?: string | undefined;
}
