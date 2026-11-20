import {
  GitViseError,
  type InferenceEmbeddingRequest,
  type InferenceEvent,
  type InferencePort,
  type InferenceRequest,
  type InferenceTier,
} from '@gitvise/core';
import { DEFAULT_FALLBACK_ABOVE_TOKENS, estimateTokens } from '@gitvise/adapter-cloudflare';
import type { BillingGuardDurableObject } from './billing-guard';
import { CreditExhaustedError } from './errors';
import { costPence, EXTERNAL_FALLBACK_RATE_PENCE_PER_MILLION_TOKENS, MODEL_RATE_PENCE_PER_MILLION_TOKENS } from './plans';
import type { UsageRecord } from './usage';

export type { UsageRecord } from './usage';

/** Output allowance assumed when a request does not set `maxOutputTokens`. Matches the largest tier. */
const DEFAULT_OUTPUT_ALLOWANCE_TOKENS = 8_192;
/** Embeddings are billed at the cheapest tier's rate. Changing this is a pricing decision, not a code fix. */
const EMBEDDING_BILLING_TIER: InferenceTier = 'fast-3b';
const EMBEDDING_RATE_PENCE_PER_MILLION_TOKENS = MODEL_RATE_PENCE_PER_MILLION_TOKENS[EMBEDDING_BILLING_TIER];

export interface InferencePrincipal {
  readonly orgId: string;
  readonly userId: string;
}

export interface MeteredInferenceOptions {
  /** The raw Workers AI (or other) adapter. Only the decorator may call its `stream`. */
  readonly inner: InferencePort;
  readonly guards: DurableObjectNamespace<BillingGuardDurableObject>;
  /** Whether an external fallback is configured. Without one, architect-30b over the threshold is refused upstream. */
  readonly externalFallbackConfigured: boolean;
  readonly fallbackAboveTokens?: number | undefined;
  /** Which model served a call. Stored on the usage row for audit. */
  readonly describeModel: (tier: InferenceTier, external: boolean) => string;
  /** Embedding model id, stored on the usage row for audit. Empty when embedding is not configured. */
  readonly embeddingModel?: string | undefined;
  /**
   * Writes the usage row to D1. Called once per settlement, after the debit. If it throws, the record stays in the
   * guard's outbox and the scheduled reconciliation writes it later.
   */
  readonly onSettled?: ((record: UsageRecord) => Promise<void> | void) | undefined;
}

/**
 * Wraps the inference adapter so every call is metered.
 *
 * Per call: `reserve` a hold (throws `CreditExhaustedError` if none is available), stream from the inner
 * adapter, and on the final `usage` event settle the actual cost once. Settlement is idempotent on the
 * request id, so a retried request never debits twice. Use `open`, never the inner adapter directly.
 */
export class MeteredInferenceDecorator {
  private readonly fallbackAbove: number;

  constructor(private readonly options: MeteredInferenceOptions) {
    this.fallbackAbove = options.fallbackAboveTokens ?? DEFAULT_FALLBACK_ABOVE_TOKENS;
  }

  /**
   * Starts a metered stream. Throws before any tokens are produced if the call is refused.
   * `request.requestId` must be unique per logical call. Retries should reuse it so they settle once.
   */
  async open(request: InferenceRequest, principal: InferencePrincipal): Promise<ReadableStream<InferenceEvent>> {
    // The caller's `requestId` is the idempotency key for the hold and the settlement.
    const requestId = request.requestId;
    if (!this.options.inner.availableTiers().includes(request.tier)) {
      throw new GitViseError('TIER_UNAVAILABLE', `tier ${request.tier} is not configured in this deployment`);
    }

    const promptTokens = estimateTokens(request.messages.map((message) => message.content).join('\n'));
    const external =
      request.tier === 'architect-30b' && this.options.externalFallbackConfigured && promptTokens > this.fallbackAbove;
    const ratePence = external
      ? EXTERNAL_FALLBACK_RATE_PENCE_PER_MILLION_TOKENS
      : MODEL_RATE_PENCE_PER_MILLION_TOKENS[request.tier];
    const outputAllowance = request.maxOutputTokens ?? DEFAULT_OUTPUT_ALLOWANCE_TOKENS;
    const estimatePence = costPence(promptTokens + outputAllowance, ratePence);

    const guard = this.options.guards.getByName(principal.orgId);
    const hold = await guard.reserve({ requestId, estimatePence });
    if (!hold.ok) throw new CreditExhaustedError(hold.availablePence);

    let upstream: ReadableStream<InferenceEvent>;
    try {
      upstream = this.options.inner.stream(request);
    } catch (error) {
      await guard.release(requestId).catch(() => undefined);
      throw error;
    }

    return this.meter(upstream, {
      requestId,
      principal,
      tier: request.tier,
      model: this.options.describeModel(request.tier, external),
      promptEstimate: promptTokens,
      ratePence,
    });
  }

  /**
   * Metered embedding. Reserves an estimate, embeds, and settles the estimated token count once. Embedding has
   * no tier of its own, so it is billed at the cheapest tier's rate and the usage row records the embedding
   * model id. A failed call releases its hold.
   */
  async embed(
    request: InferenceEmbeddingRequest,
    principal: InferencePrincipal,
  ): Promise<readonly (readonly number[])[]> {
    const requestId = request.requestId;
    if (request.inputs.length === 0) return [];
    const promptTokens = request.inputs.reduce((sum, input) => sum + estimateTokens(input), 0);
    const ratePence = EMBEDDING_RATE_PENCE_PER_MILLION_TOKENS;
    const guard = this.options.guards.getByName(principal.orgId);
    const hold = await guard.reserve({ requestId, estimatePence: costPence(promptTokens, ratePence) });
    if (!hold.ok) throw new CreditExhaustedError(hold.availablePence);

    let vectors: readonly (readonly number[])[];
    try {
      vectors = await this.options.inner.embed(request);
    } catch (error) {
      await guard.release(requestId).catch(() => undefined);
      throw error;
    }

    await this.settleCall(
      guard,
      {
        requestId,
        principal,
        tier: EMBEDDING_BILLING_TIER,
        model: this.options.embeddingModel ?? 'unconfigured-embedding-model',
        promptEstimate: promptTokens,
        ratePence,
      },
      { promptTokens, completionTokens: 0, totalTokens: promptTokens },
      0,
    );
    return vectors;
  }

  private meter(
    upstream: ReadableStream<InferenceEvent>,
    call: {
      readonly requestId: string;
      readonly principal: InferencePrincipal;
      readonly tier: InferenceTier;
      readonly model: string;
      readonly promptEstimate: number;
      readonly ratePence: number;
    },
  ): ReadableStream<InferenceEvent> {
    const reader = upstream.getReader();
    const guard = this.options.guards.getByName(call.principal.orgId);
    let producedChars = 0;
    let providerUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    let settlement: Promise<void> | undefined;

    // Settles once, whichever of usage, end, error, or cancel happens first.
    const settle = (): Promise<void> => {
      settlement ??= this.settleCall(guard, call, providerUsage, producedChars);
      return settlement;
    };

    return new ReadableStream<InferenceEvent>({
      pull: async (controller) => {
        let next: ReadableStreamReadResult<InferenceEvent>;
        try {
          next = await reader.read();
        } catch (error) {
          await settle();
          controller.error(error);
          return;
        }
        if (next.done) {
          await settle();
          controller.close();
          return;
        }

        const event = next.value;
        if (event.type === 'token') {
          producedChars += event.text.length;
        } else if (event.type === 'usage') {
          providerUsage = event.usage;
          // Settle before the client sees the usage event, so a client that trusts it can rely on the
          // debit having happened.
          await settle();
        }
        controller.enqueue(event);
      },
      cancel: async (reason) => {
        await reader.cancel(reason).catch(() => undefined);
        await settle();
      },
    });
  }

  private async settleCall(
    guard: DurableObjectStub<BillingGuardDurableObject>,
    call: {
      readonly requestId: string;
      readonly principal: InferencePrincipal;
      readonly tier: InferenceTier;
      readonly model: string;
      readonly promptEstimate: number;
      readonly ratePence: number;
    },
    providerUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined,
    producedChars: number,
  ): Promise<void> {
    // Without provider usage (cancel, or a stream that ended early), fall back to the same estimate the adapter uses.
    const promptTokens = providerUsage?.promptTokens ?? call.promptEstimate;
    const completionTokens = providerUsage?.completionTokens ?? Math.ceil(producedChars / 3);
    const totalTokens = providerUsage?.totalTokens ?? promptTokens + completionTokens;
    const actualPence = costPence(totalTokens, call.ratePence);

    try {
      const record = await guard.settle({
        requestId: call.requestId,
        actualPence,
        usage: {
          orgId: call.principal.orgId,
          userId: call.principal.userId,
          tier: call.tier,
          model: call.model,
          promptTokens,
          completionTokens,
        },
      });
      await this.options.onSettled?.(record);
      // Acknowledge only a fresh record. A replay has no pending write of its own, and acknowledging on it could
      // remove an outbox row that the original settlement still needs.
      if (!record.duplicate) await guard.ackUsage(record.requestId);
    } catch (error) {
      // The debit is the source of truth and the outbox keeps the usage row until D1 accepts it. Log the failure,
      // and the scheduled reconciliation retries.
      console.error(`billing settlement write failed for ${call.requestId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Stands in for the raw inference port on `GitViseEngine`, so unmetered `stream` calls fail loudly instead of
 * silently bypassing billing.
 */
export class DirectInferenceDisabled implements InferencePort {
  constructor(private readonly inner: InferencePort) {}

  availableTiers(): readonly InferenceTier[] {
    return this.inner.availableTiers();
  }

  stream(): ReadableStream<InferenceEvent> {
    throw new GitViseError('INVALID_STATE', 'direct inference is disabled; route calls through MeteredInferenceDecorator.open');
  }

  embed(): Promise<readonly (readonly number[])[]> {
    return Promise.reject(
      new GitViseError('INVALID_STATE', 'direct embedding is disabled; route calls through MeteredInferenceDecorator.embed'),
    );
  }
}
