import {
  createSwarmTaskConsumer,
  type SwarmTaskHandler,
  type SwarmTaskMessage,
} from '@gitvise/adapter-cloudflare';
import { app } from './app';
import { createEdgeServices } from './composition';
import type { GatewayEnv } from './env';
import { createBaselineHandlers } from './swarm/handlers';
import { reconcileBilling } from './billing/reconcile';
import { pruneExpiredSessions } from './auth/sessions';
import { deliverApiJobs, API_JOBS_QUEUE } from './queues/api-jobs';
import type { ApiJobMessage } from './queues/api-job-message';

// Classes wrangler binds by name. They must be exported from the entry module.
export {
  GitViseSandbox,
  RealtimeRoom,
  SwarmFlowState,
  SwarmFlowWorkflow,
  WorktreeMutex,
} from '@gitvise/adapter-cloudflare';
export { BillingGuardDurableObject } from './billing/billing-guard';
export { GatewayKvEntry } from './kv/gateway-kv-entry';
export { GitViseApiContainer } from './api-container';

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<unknown>, env: GatewayEnv): Promise<void> {
    if (batch.queue === API_JOBS_QUEUE) {
      await deliverApiJobs(batch as MessageBatch<ApiJobMessage>, env);
      return;
    }
    // Every other queue on this Worker is the swarm queue, which carries only SwarmFlowWorkflow messages.
    const services = createEdgeServices(env);
    const handlers: Readonly<Record<string, SwarmTaskHandler>> = createBaselineHandlers(services);
    await createSwarmTaskConsumer({
      handlers,
      swarm: services.swarmQueue,
      recordResult: (task: SwarmTaskMessage, result) =>
        services.swarmQueue.recordStepResult(task.flowId, task.taskId, result),
    })(batch as MessageBatch<SwarmTaskMessage>);
  },

  /**
   * Cron: reconciles every org's live balance with its D1 ledger, and writes usage records that the inline path
   * failed to write. The run is idempotent, so an overlapping or retried invocation is harmless.
   */
  scheduled(_controller: ScheduledController, env: GatewayEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(
      pruneExpiredSessions(env.D1).catch((error: unknown) => {
        console.error(`session pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      }),
    );
    ctx.waitUntil(
      reconcileBilling(env).then(
        (report) => {
          const drifted = report.orgs.filter((org) => org.outcome === 'mismatch');
          console.log(
            JSON.stringify({
              event: 'billing.reconcile',
              orgs: report.orgs.length,
              flushed: report.flushed,
              flushFailed: report.flushFailed,
              inFlight: report.inFlight,
              mismatches: drifted.map((org) => org.orgId),
            }),
          );
        },
        (error: unknown) => {
          console.error(`billing reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      ),
    );
  },
} satisfies ExportedHandler<GatewayEnv>;
