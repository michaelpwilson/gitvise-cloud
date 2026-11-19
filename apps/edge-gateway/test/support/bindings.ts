import { env } from 'cloudflare:workers';
import type { BillingGuardDurableObject } from '../../src/billing/billing-guard';
import type { GatewayEnv } from '../../src/env';
import type { RealtimeRoom, SwarmFlowState, WorktreeMutex } from '@gitvise/adapter-cloudflare';

/** The subset of bindings the test Worker provides. Typed locally so tests do not depend on generated wrangler types. */
export interface TestBindings {
  readonly D1: D1Database;
  readonly R2: R2Bucket;
  readonly KV: KVNamespace;
  readonly WORKTREE_MUTEX: DurableObjectNamespace<WorktreeMutex>;
  readonly SWARM_FLOWS: DurableObjectNamespace<SwarmFlowState>;
  readonly REALTIME_ROOMS: DurableObjectNamespace<RealtimeRoom>;
  readonly BILLING_GUARD: DurableObjectNamespace<BillingGuardDurableObject>;
}

export const testEnv = env as unknown as TestBindings;

/** Secrets used by tests. They are fixed values that exist only in this file. */
export const TEST_SECRETS = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
  GATEWAY_API_TOKEN: 'gateway-token-test',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
} as const;

/**
 * The Worker environment for `app.request` calls. Bindings come from the test config, and secrets are the fixed
 * test values above. Pass `overrides` to change one setting for a single test.
 */
export function httpEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    ...testEnv,
    ...TEST_SECRETS,
    AI_MODEL_FAST_3B: '@cf/meta/llama-3.2-3b-instruct',
    ...overrides,
  } as unknown as GatewayEnv;
}

/** Unique id per test, so tests in one file never share Durable Object state. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
