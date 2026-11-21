import type { GitViseBindings } from '@gitvise/adapter-cloudflare';
import type { BillingGuardDurableObject } from './billing/billing-guard';
import type { GitViseApiContainer } from './api-container';
import type { GatewayKvEntry } from './kv/gateway-kv-entry';
import type { ApiJobMessage } from './queues/api-job-message';

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
   * One Durable Object per key, for `/internal/kv/*`. Atomic `ifAbsent`, counters, and expiry need a single writer per
   * key, which Workers KV cannot give.
   */
  readonly KV_ENTRIES: DurableObjectNamespace<GatewayKvEntry>;
  /** Queue for jobs the apps/api container runs. The gateway's consumer delivers each one to `GitViseApiContainer`. */
  readonly API_JOBS: Queue<ApiJobMessage>;
  /**
   * The apps/api container. Every request the gateway does not own, and every queue delivery, goes to its single
   * instance (`API_CONTAINER_INSTANCE`). See ./api-container.ts.
   */
  readonly GitViseApiContainer: DurableObjectNamespace<GitViseApiContainer>;
  /** Edge rate limit for requests forwarded to apps/api. Optional so tests and local runs without the binding still work. */
  readonly API_RATE_LIMIT?: RateLimit | undefined;
  /**
   * Public origin of this gateway, with no trailing slash. apps/api calls the gateway's `/internal/*` routes here, so
   * it must reach this Worker. Plain var in wrangler.jsonc.
   */
  readonly CLOUDFLARE_GATEWAY_URL?: string | undefined;

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

  /**
   * Secret. HMAC key for `gitvise-internal-v1` requests from the apps/api container under `/internal/*`. It must
   * match the container's `INTERNAL_GATEWAY_SECRET`. Without it, every internal route refuses. Set with
   * `wrangler secret put INTERNAL_GATEWAY_SECRET`.
   */
  readonly INTERNAL_GATEWAY_SECRET?: string | undefined;

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

  /**
   * Cloudflare Email Service binding, used for the signup confirmation email. Without it, signup refuses to start,
   * so no account is created that cannot be confirmed. Set in wrangler.jsonc under `send_email`.
   */
  readonly EMAIL?: SendEmail | undefined;
  /** Sender of the signup email. Must be on a domain verified for Email Service. Plain var in wrangler.jsonc. */
  readonly SIGNUP_FROM_ADDRESS?: string | undefined;
  /**
   * The public origin the web app is served from, with no trailing slash. The confirmation link and the redirect after
   * confirming both use it. Plain var in wrangler.jsonc.
   */
  readonly PUBLIC_APP_URL?: string | undefined;

  /**
   * WebAuthn relying party for passkeys, passed to the apps/api container. The RP ID must be the host the browser is
   * on (`web.gitvise.com`), and the origin list must be the https origin of that host. Plain vars in wrangler.jsonc.
   */
  readonly WEBAUTHN_RP_ID?: string | undefined;
  readonly WEBAUTHN_RP_NAME?: string | undefined;
  readonly WEBAUTHN_ORIGINS?: string | undefined;
}
