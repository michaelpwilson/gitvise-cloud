// Entry point for the test Worker. Re-exports the Durable Object classes under test, so `runInDurableObject`
// and the namespaces in `test/wrangler.test.jsonc` can resolve them.
export { WorktreeMutex, SwarmFlowState, RealtimeRoom } from '@gitvise/adapter-cloudflare';
export { BillingGuardDurableObject } from '../src/billing/billing-guard';
export { GatewayKvEntry } from '../src/kv/gateway-kv-entry';

export default {
  fetch(): Response {
    return new Response('gitvise test worker', { status: 404 });
  },
} satisfies ExportedHandler;
