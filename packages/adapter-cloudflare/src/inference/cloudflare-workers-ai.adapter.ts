import {
  GitViseError,
  type InferenceEvent,
  type InferenceMessage,
  type InferencePort,
  type InferenceRequest,
  type InferenceTier,
  INFERENCE_TIERS,
} from '@gitvise/core';
import { upstreamError } from '../shared/errors';
import { readChunk, SseDataReader, singleEventBody, type ProviderUsage } from './sse';

/**
 * Prompts estimated above this many tokens go to the external fallback, when one is configured.
 * Set below the 32,768-token context of the architect model, so the Workers AI path never overflows.
 */
export const DEFAULT_FALLBACK_ABOVE_TOKENS = 28_000;

export interface ExternalFallback {
  /** Base URL of an OpenAI-compatible API, such as `https://api.example.com/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Sent as a bearer token. Keep it in a Wrangler secret, never in config. */
  readonly apiKey?: string | undefined;
}

export interface CloudflareInferenceOptions {
  readonly ai: Ai;
  /** Workers AI model per tier. An empty or missing entry leaves that tier unavailable. */
  readonly models: { readonly [tier in InferenceTier]?: string | undefined };
  readonly fallback?: ExternalFallback | undefined;
  readonly fallbackAboveTokens?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/** The subset of the Workers AI binding used here. `Ai.run` is typed per model, so model ids are passed as strings. */
interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

type Route =
  | { readonly kind: 'workers-ai'; readonly model: string }
  | { readonly kind: 'external'; readonly baseUrl: string; readonly model: string; readonly apiKey: string | undefined };

/**
 * `InferencePort` over Workers AI. The model for each tier comes from configuration, so retiring a model
 * is a config change. `architect-30b` can fall back to an external OpenAI-compatible endpoint when the
 * prompt is estimated above `fallbackAboveTokens`.
 *
 * Every stream ends with exactly one `usage` event. Token counts come from the provider when it
 * reports them, and otherwise from a conservative character-based estimate.
 */
export class CloudflareWorkersAiInferenceAdapter implements InferencePort {
  private readonly fetchImpl: typeof fetch;
  private readonly fallbackAbove: number;

  constructor(private readonly options: CloudflareInferenceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.fallbackAbove = options.fallbackAboveTokens ?? DEFAULT_FALLBACK_ABOVE_TOKENS;
  }

  availableTiers(): readonly InferenceTier[] {
    return INFERENCE_TIERS.filter((tier) => (this.options.models[tier] ?? '') !== '');
  }

  stream(request: InferenceRequest): ReadableStream<InferenceEvent> {
    if (!this.availableTiers().includes(request.tier)) {
      throw new GitViseError('TIER_UNAVAILABLE', `tier ${request.tier} is not configured in this deployment`);
    }
    const promptTokens = estimateTokens(request.messages.map((message) => message.content).join('\n'));
    const route = this.route(request, promptTokens);
    return this.generate(request, route, promptTokens);
  }

  private route(request: InferenceRequest, promptTokens: number): Route {
    if (request.tier === 'architect-30b' && promptTokens > this.fallbackAbove) {
      const fallback = this.options.fallback;
      if (fallback === undefined) {
        throw new GitViseError(
          'INVALID_REQUEST',
          `prompt is about ${promptTokens} tokens, above the ${this.fallbackAbove} limit, and no external fallback is configured`,
        );
      }
      return { kind: 'external', baseUrl: fallback.baseUrl, model: fallback.model, apiKey: fallback.apiKey };
    }
    return { kind: 'workers-ai', model: this.options.models[request.tier] ?? '' };
  }

  private generate(request: InferenceRequest, route: Route, promptTokens: number): ReadableStream<InferenceEvent> {
    const abort = new AbortController();
    const parser = new SseDataReader();
    const pending: InferenceEvent[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let produced = '';
    let usage: ProviderUsage | undefined;
    let finished = false;

    const consume = (payload: string): void => {
      const chunk = readChunk(payload);
      for (const text of chunk.text) {
        produced += text;
        pending.push({ type: 'token', text });
      }
      if (chunk.usage !== undefined) usage = { ...usage, ...chunk.usage };
      if (chunk.done) finished = true;
    };

    return new ReadableStream<InferenceEvent>({
      pull: async (out) => {
        try {
          reader ??= await this.open(request, route, abort.signal);
          while (pending.length === 0) {
            if (finished) {
              pending.push({ type: 'usage', usage: meter(request.tier, usage, promptTokens, produced) });
              break;
            }
            const chunk = await reader.read();
            if (chunk.done) {
              for (const payload of parser.finish()) consume(payload);
              finished = true;
              continue;
            }
            for (const payload of parser.push(chunk.value)) consume(payload);
          }
        } catch (error) {
          throw error instanceof GitViseError ? error : upstreamError('inference stream failed', error);
        }

        const next = pending.shift();
        if (next === undefined) return;
        out.enqueue(next);
        if (next.type === 'usage') out.close();
      },
      cancel: async (reason) => {
        abort.abort(reason);
        await reader?.cancel(reason).catch(() => undefined);
      },
    });
  }

  private async open(
    request: InferenceRequest,
    route: Route,
    signal: AbortSignal,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const messages: InferenceMessage[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    if (route.kind === 'workers-ai') {
      const runner = this.options.ai as unknown as AiRunner;
      try {
        const result = await runner.run(route.model, {
          messages,
          stream: true,
          ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        });
        const body = result instanceof ReadableStream ? (result as ReadableStream<Uint8Array>) : singleEventBody(result);
        return body.getReader();
      } catch (error) {
        throw upstreamError(`Workers AI model ${route.model} failed`, error);
      }
    }

    const response = await this.fetchImpl(`${route.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(route.apiKey === undefined || route.apiKey === '' ? {} : { authorization: `Bearer ${route.apiKey}` }),
      },
      body: JSON.stringify({
        model: route.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }),
    }).catch((error: unknown) => {
      throw upstreamError('external fallback request failed', error);
    });
    if (!response.ok || response.body === null) {
      throw upstreamError(`external fallback returned ${response.status}: ${await response.text().catch(() => '')}`);
    }
    return response.body.getReader();
  }
}

/** Conservative estimate: about three characters per token. Overestimates, so long prompts reroute early. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function meter(
  tier: InferenceTier,
  usage: ProviderUsage | undefined,
  promptEstimate: number,
  produced: string,
): { tier: InferenceTier; promptTokens: number; completionTokens: number; totalTokens: number } {
  const promptTokens = usage?.promptTokens ?? promptEstimate;
  const completionTokens = usage?.completionTokens ?? estimateTokens(produced);
  return {
    tier,
    promptTokens,
    completionTokens,
    totalTokens: usage?.totalTokens ?? promptTokens + completionTokens,
  };
}