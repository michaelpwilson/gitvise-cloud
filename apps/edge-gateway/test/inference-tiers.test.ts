import { describe, expect, it } from 'vitest';
import { INFERENCE_TIERS } from '@gitvise/core';
import { MODEL_RATE_PENCE_PER_MILLION_TOKENS } from '../src/billing/plans';
import { httpEnv, testEnv, uniqueId } from './support/bindings';
import { callInternalWith } from './support/internal';

/**
 * The linear agent's two model tiers. `worker-7b` routes and `architect-30b` patches, so each must reach its own
 * Workers AI model, be billed under its own tier, and refuse cleanly when it is not configured.
 */

const WORKER_7B_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const ARCHITECT_30B_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

/** A Workers AI binding double that records the model each call used. */
function recordingAi(calls: string[]): Ai {
  return {
    run: async (model: string) => {
      calls.push(model);
      return { response: 'ok' };
    },
  } as unknown as Ai;
}

function tierEnv(calls: string[], overrides: Partial<Record<'AI_MODEL_WORKER_7B' | 'AI_MODEL_ARCHITECT_30B', string>> = {}) {
  return httpEnv({
    AI: recordingAi(calls),
    AI_MODEL_WORKER_7B: WORKER_7B_MODEL,
    AI_MODEL_ARCHITECT_30B: ARCHITECT_30B_MODEL,
    ...overrides,
  });
}

async function grantCredit(orgId: string): Promise<void> {
  await testEnv.BILLING_GUARD.getByName(orgId).grant({ ref: `seed-${orgId}`, bucket: 'monthly', amountPence: 10_000 });
}

async function readAll(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** Settlement writes the usage row after the stream ends, so poll for it briefly. */
async function usageRow(requestId: string): Promise<{ tier: string; model: string; cost_pence: number } | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await testEnv.D1.prepare('SELECT tier, model, cost_pence FROM usage_events WHERE id = ?')
      .bind(requestId)
      .first<{ tier: string; model: string; cost_pence: number }>();
    if (row !== null) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function streamPayload(orgId: string, tier: string, requestId: string, content = 'route this'): Record<string, unknown> {
  return {
    requestId,
    tier,
    messages: [{ role: 'user', content }],
    billing: { organizationId: orgId, userId: 'user-1' },
  };
}

describe('inference tier mapping for the linear agent graph', () => {
  it('prices every inference tier, so no tier reaches billing without a rate', () => {
    for (const tier of INFERENCE_TIERS) {
      expect(MODEL_RATE_PENCE_PER_MILLION_TOKENS[tier], tier).toBeGreaterThan(0);
    }
  });

  it('sends worker-7b to its configured Workers AI model and bills it under worker-7b', async () => {
    const orgId = uniqueId('org-w7b');
    await grantCredit(orgId);
    const calls: string[] = [];
    const requestId = uniqueId('req-w7b');

    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env: tierEnv(calls),
      payload: streamPayload(orgId, 'worker-7b', requestId),
    });

    expect(response.status).toBe(200);
    const events = await readAll(response);
    expect(events[0]).toEqual({ type: 'token', text: 'ok' });
    expect(events.at(-1)).toMatchObject({ type: 'usage', usage: { tier: 'worker-7b' } });
    expect(calls).toEqual([WORKER_7B_MODEL]);
    expect(await usageRow(requestId)).toMatchObject({ tier: 'worker-7b', model: WORKER_7B_MODEL });
  });

  it('sends architect-30b to its configured Workers AI model and bills it under architect-30b', async () => {
    const orgId = uniqueId('org-a30b');
    await grantCredit(orgId);
    const calls: string[] = [];
    const requestId = uniqueId('req-a30b');

    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env: tierEnv(calls),
      payload: streamPayload(orgId, 'architect-30b', requestId, 'write the patch'),
    });

    expect(response.status).toBe(200);
    const events = await readAll(response);
    expect(events.at(-1)).toMatchObject({ type: 'usage', usage: { tier: 'architect-30b' } });
    expect(calls).toEqual([ARCHITECT_30B_MODEL]);
    expect(await usageRow(requestId)).toMatchObject({ tier: 'architect-30b', model: ARCHITECT_30B_MODEL });
  });

  it('refuses worker-7b with 503 and calls no model when the deployment has no worker-7b model', async () => {
    const orgId = uniqueId('org-w7b-off');
    await grantCredit(orgId);
    const calls: string[] = [];

    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env: tierEnv(calls, { AI_MODEL_WORKER_7B: '' }),
      payload: streamPayload(orgId, 'worker-7b', uniqueId('req')),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('TIER_UNAVAILABLE');
    expect(calls).toEqual([]);
  });

  it('refuses an architect-30b prompt above the Workers AI context limit, with 400, when no fallback is configured', async () => {
    const orgId = uniqueId('org-a30b-long');
    await grantCredit(orgId);
    const calls: string[] = [];
    // About 100,000 characters estimate to roughly 33,000 tokens, above the 28,000-token ceiling.
    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env: tierEnv(calls),
      payload: streamPayload(orgId, 'architect-30b', uniqueId('req'), 'x'.repeat(100_000)),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('INVALID_REQUEST');
    expect(calls).toEqual([]);
  });

  it('rejects a tier name the gateway does not know, with 400', async () => {
    const orgId = uniqueId('org-unknown');
    await grantCredit(orgId);
    const response = await callInternalWith('POST', '/internal/ports/inference/stream', {
      env: tierEnv([]),
      payload: streamPayload(orgId, 'architect-70b', uniqueId('req')),
    });
    expect(response.status).toBe(400);
  });
});
