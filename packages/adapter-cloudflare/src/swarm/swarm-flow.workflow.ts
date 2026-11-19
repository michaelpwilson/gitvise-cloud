import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { GitViseBindings } from '../bindings';
import { STEP_SETTLED_EVENT, type SwarmFlowParams, type SwarmTaskMessage } from './swarm-types';

export type SwarmFlowEnv = Pick<GitViseBindings, 'SWARM_FLOWS' | 'QUEUES'>;

/** How long the flow waits for the next settled step before the instance fails. */
const SETTLE_TIMEOUT = '24 hours';

/**
 * Drives one flow to completion. Each round dispatches every ready step, then waits for a
 * `step-settled` event. `claim` and `dispatch` are separate memoized steps, so a crash between them
 * replays the dispatch but never re-claims a step. Queue delivery is at-least-once, and the queue
 * consumer's compare-and-set keeps a duplicate delivery from re-settling a step.
 */
export class SwarmFlowWorkflow extends WorkflowEntrypoint<SwarmFlowEnv, SwarmFlowParams> {
  override async run(event: WorkflowEvent<SwarmFlowParams>, step: WorkflowStep): Promise<void> {
    const { flowId } = event.payload;
    const flow = this.env.SWARM_FLOWS.getByName(flowId);

    for (let round = 1; ; round += 1) {
      const ready = await step.do(`ready-${round}`, () => flow.readyTasks());

      for (const task of ready) {
        const claimed = await step.do(`claim-${round}-${task.taskId}`, () => flow.claim(task.taskId));
        if (!claimed) continue;
        const message: SwarmTaskMessage = {
          flowId,
          taskId: task.taskId,
          queue: task.queue,
          input: JSON.parse(task.inputJson) as SwarmTaskMessage['input'],
        };
        await step.do(`dispatch-${round}-${task.taskId}`, () =>
          this.env.QUEUES.send(message, { contentType: 'json' }),
        );
      }

      const progress = await step.do(`progress-${round}`, () => flow.progress());
      if (progress === 'done') return;
      if (progress === 'stalled') {
        throw new Error(`flow ${flowId} is stalled: queued steps can never start`);
      }

      await step.waitForEvent(`settle-${round}`, { type: STEP_SETTLED_EVENT, timeout: SETTLE_TIMEOUT });
    }
  }
}
