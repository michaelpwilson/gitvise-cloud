import { DurableObject } from 'cloudflare:workers';
import type { SwarmFlowSpec, SwarmStepStatus } from '@gitvise/core';
import type { FlowEnqueueOutcome, ReadyStep } from './swarm-types';

interface StepRow {
  readonly task_id: string;
  readonly queue: string;
  readonly input: string;
  readonly depends_on: string;
  readonly status: SwarmStepStatus;
  readonly [key: string]: SqlStorageValue;
}

interface FlowRow {
  readonly flow_id: string;
  readonly spec_hash: string | null;
  readonly [key: string]: SqlStorageValue;
}

/**
 * Durable state for one swarm flow, addressed by `flowId`. Each step is a row. Every status change
 * goes through `cas`, so two writers can never both move a step.
 *
 * All methods are synchronous SQL against this object's storage. Input gates keep them atomic.
 */
export class SwarmFlowState extends DurableObject<unknown> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS flow (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          flow_id TEXT NOT NULL,
          repo_id TEXT NOT NULL,
          spec_hash TEXT
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS step (
          task_id TEXT PRIMARY KEY,
          queue TEXT NOT NULL,
          input TEXT NOT NULL,
          depends_on TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
          result TEXT
        )
      `);
    });
  }

  /** Records the flow on first submit. A later submit with a different `specHash` is a conflict. */
  enqueue(flow: SwarmFlowSpec): FlowEnqueueOutcome {
    const existing = this.sql.exec<FlowRow>('SELECT flow_id, spec_hash FROM flow').toArray()[0];
    if (existing !== undefined) {
      if (flow.specHash !== undefined && existing.spec_hash !== flow.specHash) {
        return {
          ok: false,
          code: 'CONFLICT',
          message: `flow ${flow.flowId} already exists with a different spec hash`,
        };
      }
      return { ok: true, created: false };
    }

    this.sql.exec(
      'INSERT INTO flow (singleton, flow_id, repo_id, spec_hash) VALUES (1, ?, ?, ?)',
      flow.flowId,
      flow.repoId,
      flow.specHash ?? null,
    );
    for (const task of flow.tasks) {
      this.sql.exec(
        'INSERT INTO step (task_id, queue, input, depends_on, status) VALUES (?, ?, ?, ?, ?)',
        task.taskId,
        task.queue,
        JSON.stringify(task.input),
        JSON.stringify(task.dependsOn),
        'queued',
      );
    }
    return { ok: true, created: true };
  }

  status(taskId: string): SwarmStepStatus | undefined {
    return this.sql.exec<StepRow>('SELECT status FROM step WHERE task_id = ?', taskId).toArray()[0]?.status;
  }

  /** Stores a handler's JSON result on its step. Returns false if the step is unknown. */
  setResult(taskId: string, resultJson: string): boolean {
    if (this.status(taskId) === undefined) return false;
    this.sql.exec('UPDATE step SET result = ? WHERE task_id = ?', resultJson, taskId);
    return true;
  }

  /** The stored JSON result, or `null` if the step has none yet. */
  readResult(taskId: string): string | null | undefined {
    const row = this.sql.exec<{ result: string | null }>('SELECT result FROM step WHERE task_id = ?', taskId).toArray()[0];
    return row === undefined ? undefined : row.result;
  }

  /** Moves a queued step to running. The dispatcher calls this before it enqueues the message. */
  claim(taskId: string): boolean {
    return this.cas(taskId, 'queued', 'running');
  }

  /**
   * Compare-and-set on one step. Moving a step to `failed` also fails every queued step that depends on
   * it, transitively, so a flow never waits on work that can no longer run.
   */
  cas(taskId: string, expected: SwarmStepStatus, next: SwarmStepStatus): boolean {
    const current = this.status(taskId);
    if (current === undefined || current !== expected) return false;
    this.sql.exec('UPDATE step SET status = ? WHERE task_id = ?', next, taskId);
    if (next === 'failed') this.failDependents();
    return true;
  }

  /** Steps that are queued with every dependency succeeded. */
  readyTasks(): ReadyStep[] {
    const steps = this.loadSteps();
    const statusOf = new Map(steps.map((step) => [step.task_id, step.status]));
    return steps
      .filter(
        (step) =>
          step.status === 'queued' &&
          parseDeps(step.depends_on).every((dep) => statusOf.get(dep) === 'succeeded'),
      )
      .map((step) => ({
        taskId: step.task_id,
        queue: step.queue,
        inputJson: step.input,
      }));
  }

  /**
   * What the Workflow should do next, as a plain string so it crosses the step boundary cleanly:
   * - `done`: every step is terminal.
   * - `waiting`: something is running, or ready, so a settle event is expected.
   * - `stalled`: work remains, nothing runs, and nothing is ready. It can never finish.
   */
  progress(): 'done' | 'waiting' | 'stalled' {
    const steps = this.loadSteps();
    const pending = steps.filter((step) => step.status === 'queued' || step.status === 'running');
    if (pending.length === 0) return 'done';
    if (pending.some((step) => step.status === 'running')) return 'waiting';
    return this.readyTasks().length > 0 ? 'waiting' : 'stalled';
  }

  /** Fails every queued step reachable from a failed step. Iterates to a fixed point. */
  private failDependents(): void {
    const steps = this.loadSteps();
    const statusOf = new Map(steps.map((step) => [step.task_id, step.status]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) {
        if (statusOf.get(step.task_id) !== 'queued') continue;
        const blocked = parseDeps(step.depends_on).some((dep) => statusOf.get(dep) === 'failed');
        if (!blocked) continue;
        this.sql.exec("UPDATE step SET status = 'failed' WHERE task_id = ?", step.task_id);
        statusOf.set(step.task_id, 'failed');
        changed = true;
      }
    }
  }

  private loadSteps(): StepRow[] {
    return this.sql
      .exec<StepRow>('SELECT task_id, queue, input, depends_on, status FROM step ORDER BY task_id')
      .toArray();
  }
}

function parseDeps(encoded: string): string[] {
  return JSON.parse(encoded) as string[];
}
