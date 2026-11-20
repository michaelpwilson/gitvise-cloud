import {
  GitViseError,
  type InferenceEmbeddingRequest,
  type InferenceEvent,
  type InferenceMessage,
  type InferencePort,
  type InferenceRequest,
  type InferenceTier,
  type InferenceToolSpec,
  INFERENCE_TIERS,
} from '@gitvise/core';
import { upstreamError } from '../shared/errors';
import { readChunk, SseDataReader, singleEventBody, type ProviderUsage } from './sse';

/**
 * Prompts estimated above this many tokens go to the external fallback, when one is configured.
 * Set below the 32,768-token context of the architect model, so the Workers AI path never overflows.
 */
export const DEFAULT_FALLBACK_ABOVE_TOKENS = 28_000;

/** Most inputs one embedding call may carry. Keeps a single request inside the model's batch limit. */
export const MAX_EMBEDDING_INPUTS = 100;

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
  /** Workers AI text-embedding model. Empty or missing refuses embedding calls. */
  readonly embeddingModel?: string | undefined;
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
 * Text streams token by token. A request that carries tools runs once, without streaming, and returns its
 * tool calls as `tool-call` events, because Workers AI reports calls only in a complete reply. Tools are
 * served on the Workers AI route only. A request that would take the external fallback is refused rather
 * than answered without its tools.
 *
 * Every stream ends with exactly one `usage` event. Token counts come from the provider when it reports them,
 * and otherwise from a conservative character-based estimate.
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
    const tools = request.tools ?? [];
    if (tools.length > 0) {
      if (route.kind !== 'workers-ai') {
        throw new GitViseError('INVALID_REQUEST', 'tool calling is served on the Workers AI route only');
      }
      return this.generateWithTools(request, route, tools, promptTokens);
    }
    return this.generate(request, route, promptTokens);
  }

  /** Turns text into vectors with the configured embedding model. Refused when none is configured. */
  async embed(request: InferenceEmbeddingRequest): Promise<readonly (readonly number[])[]> {
    const model = (this.options.embeddingModel ?? '').trim();
    if (model === '') {
      throw new GitViseError('TIER_UNAVAILABLE', 'no embedding model is configured in this deployment');
    }
    if (request.inputs.length === 0) return [];
    if (request.inputs.length > MAX_EMBEDDING_INPUTS) {
      throw new GitViseError('INVALID_REQUEST', `at most ${MAX_EMBEDDING_INPUTS} inputs per embedding call`);
    }
    const runner = this.options.ai as unknown as AiRunner;
    let result: unknown;
    try {
      result = await runner.run(model, { text: [...request.inputs] });
    } catch (error) {
      throw upstreamError(`Workers AI embedding model ${model} failed`, error);
    }
    const vectors = parseEmbeddings(result);
    if (vectors.length !== request.inputs.length) {
      throw upstreamError(`embedding model returned ${vectors.length} vectors for ${request.inputs.length} inputs`);
    }
    return vectors;
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

  private generateWithTools(
    request: InferenceRequest,
    route: Extract<Route, { kind: 'workers-ai' }>,
    tools: readonly InferenceToolSpec[],
    promptTokens: number,
  ): ReadableStream<InferenceEvent> {
    const pending: InferenceEvent[] = [];
    let started = false;
    return new ReadableStream<InferenceEvent>({
      pull: async (out) => {
        if (!started) {
          started = true;
          let reply: WorkersAiToolReply;
          try {
            reply = await this.runWithTools(request, route, tools);
          } catch (error) {
            throw error instanceof GitViseError ? error : upstreamError('tool-calling inference failed', error);
          }
          if (reply.text !== '') pending.push({ type: 'token', text: reply.text });
          for (const call of reply.calls) pending.push({ type: 'tool-call', call });
          const produced = reply.text + reply.calls.map((call) => call.arguments).join('');
          pending.push({
            type: 'usage',
            usage: meter(request.tier, undefined, promptTokens, produced),
          });
        }
        const next = pending.shift();
        if (next === undefined) {
          out.close();
          return;
        }
        out.enqueue(next);
        if (next.type === 'usage') out.close();
      },
    });
  }

  private async runWithTools(
    request: InferenceRequest,
    route: Extract<Route, { kind: 'workers-ai' }>,
    tools: readonly InferenceToolSpec[],
  ): Promise<WorkersAiToolReply> {
    const runner = this.options.ai as unknown as AiRunner;
    let result: unknown;
    try {
      result = await runner.run(route.model, {
        messages: request.messages.map(toWireMessage),
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });
    } catch (error) {
      throw upstreamError(`Workers AI model ${route.model} failed`, error);
    }
    return parseToolReply(result);
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
          messages: request.messages.map(toWireMessage),
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

interface WorkersAiToolReply {
  readonly text: string;
  readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
}

/**
 * Reads a complete Workers AI reply. Calls may come as objects or as JSON strings; both become the JSON text the
 * port carries. A call without a name is dropped, because the caller cannot act on it.
 */
function parseToolReply(result: unknown): WorkersAiToolReply {
  const body = (typeof result === 'object' && result !== null ? result : {}) as {
    response?: unknown;
    tool_calls?: unknown;
  };
  const text = typeof body.response === 'string' ? body.response : '';
  const rawCalls = Array.isArray(body.tool_calls) ? body.tool_calls : [];
  const calls: { id: string; name: string; arguments: string }[] = [];
  rawCalls.forEach((raw: unknown, index: number) => {
    if (typeof raw !== 'object' || raw === null) return;
    const call = raw as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== 'string' || call.name === '') return;
    const args =
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
    calls.push({ id: `call-${index}-${calls.length}`, name: call.name, arguments: args });
  });
  return { text, calls };
}

/** Maps a port message to the chat shape Workers AI reads, keeping tool calls and tool results intact. */
function toWireMessage(message: InferenceMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseEmbeddings(result: unknown): number[][] {
  const data = (typeof result === 'object' && result !== null ? (result as { data?: unknown }).data : undefined);
  if (!Array.isArray(data)) {
    throw upstreamError('embedding model returned no vectors');
  }
  return data.map((vector: unknown) => {
    if (!Array.isArray(vector) || vector.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw upstreamError('embedding model returned a malformed vector');
    }
    return vector as number[];
  });
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
