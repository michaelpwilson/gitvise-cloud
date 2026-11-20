/** Queue for jobs the apps/api container runs. Its consumer delivers each message to `GitViseApiContainer`. */
export const API_JOBS_QUEUE = 'gitvise-api-jobs';

/**
 * One job on the apps/api queue. `queue` is the BullMQ queue name the apps/api processor is registered under, so one
 * Cloudflare Queue carries every queue. `parentJobId` is set for a flow child. When this job completes, the gateway
 * counts it toward its parent, and the parent is enqueued once every child has completed.
 */
export interface ApiJobMessage {
  readonly queue: string;
  readonly jobName: string;
  readonly jobId: string;
  readonly data: unknown;
  readonly maxAttempts: number;
  readonly parentJobId?: string;
}

/** What apps/api answers to a delivery. `no-processor` means no processor is registered yet, so the job waits. */
export type DeliveryStatus = 'completed' | 'unrecoverable' | 'no-processor';
