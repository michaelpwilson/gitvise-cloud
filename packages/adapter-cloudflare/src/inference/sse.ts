/** What one parsed streaming chunk contributes: text to emit and, sometimes, provider usage counts. */
export interface ChunkContribution {
  readonly text: readonly string[];
  readonly usage?: ProviderUsage;
  readonly done: boolean;
}

export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Splits a Server-Sent Events byte stream into `data:` payloads. Handles frames split across reads,
 * `\r\n` line endings, and multi-line data fields.
 */
export class SseDataReader {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  /** Feeds bytes and returns every complete `data:` payload seen so far. */
  push(bytes: Uint8Array): string[] {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drain(false);
  }

  /** Flushes whatever remains once the source ends. */
  finish(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const normalised = this.buffer.replace(/\r\n?/g, '\n');
    const frames = normalised.split('\n\n');
    const rest = frames.pop() ?? '';
    this.buffer = final ? '' : rest;
    const payloads: string[] = [];
    for (const frame of final ? [...frames, rest] : frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data.length > 0) payloads.push(data);
    }
    return payloads;
  }
}

/**
 * Reads one parsed chunk from either provider. Workers AI returns `{ response }` for native models and
 * `{ choices }` for OpenAI-compatible ones. Both can include a trailing `usage` object.
 */
export function readChunk(payload: string): ChunkContribution {
  if (payload === '[DONE]') return { text: [], done: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { text: [], done: false };
  }
  if (typeof parsed !== 'object' || parsed === null) return { text: [], done: false };
  const record = parsed as Record<string, unknown>;

  const text: string[] = [];
  if (typeof record['response'] === 'string' && record['response'].length > 0) {
    text.push(record['response']);
  }
  if (Array.isArray(record['choices'])) {
    for (const choice of record['choices'] as Array<Record<string, unknown>>) {
      const delta = choice['delta'] as { content?: unknown } | undefined;
      const message = choice['message'] as { content?: unknown } | undefined;
      const content = typeof delta?.content === 'string' ? delta.content : message?.content;
      if (typeof content === 'string' && content.length > 0) text.push(content);
    }
  }

  const usage = toUsage(record['usage']);
  return usage === undefined ? { text, done: false } : { text, usage, done: false };
}

function toUsage(value: unknown): ProviderUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const pick = (key: string): number | undefined => (typeof usage[key] === 'number' ? (usage[key] as number) : undefined);
  const promptTokens = pick('prompt_tokens');
  const completionTokens = pick('completion_tokens');
  const totalTokens = pick('total_tokens');
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

/** Builds a one-event SSE body, so a non-streaming provider response goes through the same parser. */
export function singleEventBody(payload: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  });
}
