import {
  GitViseError,
  INFERENCE_TIERS,
  type AgentRealtimeEvent,
  type AgentCursorPresence,
  type InferenceEmbeddingRequest,
  type InferenceMessage,
  type InferenceRequest,
  type InferenceRole,
  type InferenceTier,
  type InferenceToolSpec,
  type JsonValue,
  type RealtimeRoomRef,
} from '@gitvise/core';

/**
 * Hand-written validation for the `/internal/*` bodies. The gateway has no schema library, so every field the
 * routes read is checked here. A value that fails becomes `INVALID_REQUEST`, which the app error handler answers 400.
 */

export type Json = Readonly<Record<string, unknown>>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const MAX_INFERENCE_MESSAGES = 100;
export const MAX_INFERENCE_CHARS = 200_000;
export const MAX_EMBEDDING_INPUTS = 100;
export const MAX_EMBEDDING_CHARS = 200_000;
export const MAX_KV_VALUE_BYTES = 256 * 1024;
export const MAX_TOOLS = 32;

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} must be a finite number`);
  return value;
}

export function invalid(message: string): GitViseError {
  return new GitViseError('INVALID_REQUEST', message);
}

export function objectBody(value: unknown, label = 'body'): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object`);
  }
  return value as Json;
}

export function stringField(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw invalid(`${label} must be a string of ${min} to ${max} characters`);
  }
  return value;
}

export function intField(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function optionalIntField(value: unknown, label: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : intField(value, label, min, max);
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw invalid(`${label} must be an identifier of letters, digits, and . _ : -`);
  }
  return value;
}

export function roomRef(value: unknown): RealtimeRoomRef {
  const room = objectBody(value, 'room');
  const worktreeId = stringField(room['worktreeId'], 'room.worktreeId', 256);
  const roomId = stringField(room['roomId'], 'room.roomId', 256);
  if (!ROOM_ID_PATTERN.test(roomId) || worktreeId.length === 0) {
    throw invalid('room.roomId must be a room identifier');
  }
  return { worktreeId, roomId };
}

export function presenceOf(value: unknown): AgentCursorPresence {
  const presence = objectBody(value, 'presence');
  return {
    agentId: identifier(presence['agentId'], 'presence.agentId'),
    path: stringField(presence['path'], 'presence.path', 1_024),
    line: intField(presence['line'], 'presence.line', 1, Number.MAX_SAFE_INTEGER),
    column: intField(presence['column'], 'presence.column', 0, Number.MAX_SAFE_INTEGER),
    updatedAtMs: finiteNumber(presence['updatedAtMs'], 'presence.updatedAtMs'),
  };
}

export function agentEventOf(value: unknown): AgentRealtimeEvent {
  const event = objectBody(value, 'event');
  const runId = identifier(event['runId'], 'event.runId');
  switch (event['type']) {
    case 'stream-chunk':
      return { type: 'stream-chunk', runId, text: stringField(event['text'], 'event.text', 65_536, 0) };
    case 'stream-close':
      return { type: 'stream-close', runId, status: stringField(event['status'], 'event.status', 64) };
    case 'state':
      if (!('event' in event)) throw invalid('event.event is required for a state event');
      return { type: 'state', runId, event: event['event'] as JsonValue };
    default:
      throw invalid('event.type must be stream-chunk, stream-close, or state');
  }
}

/** A request the gateway meters. `billing` is required, so every debit is attributed to an organisation and user. */
export type MeteredInferenceRequest = InferenceRequest & { readonly billing: Billing };
export type MeteredEmbeddingRequest = InferenceEmbeddingRequest & { readonly billing: Billing };
export interface Billing {
  readonly organizationId: string;
  readonly userId: string;
}

export function inferenceRequestOf(value: unknown): MeteredInferenceRequest {
  const body = objectBody(value, 'request');
  const billing = billingOf(body['billing']);
  const requestId = stringField(body['requestId'], 'requestId', 200);
  const tier = tierOf(body['tier']);
  const messages = messagesOf(body['messages']);
  const tools = toolsOf(body['tools']);
  return {
    requestId,
    tier,
    messages,
    billing,
    ...(body['maxOutputTokens'] === undefined
      ? {}
      : { maxOutputTokens: intField(body['maxOutputTokens'], 'maxOutputTokens', 1, 1_000_000) }),
    ...(body['temperature'] === undefined ? {} : { temperature: temperatureOf(body['temperature']) }),
    ...(tools.length === 0 ? {} : { tools }),
  };
}

export function embeddingRequestOf(value: unknown): MeteredEmbeddingRequest {
  const body = objectBody(value, 'request');
  if (!Array.isArray(body['inputs']) || body['inputs'].length === 0 || body['inputs'].length > MAX_EMBEDDING_INPUTS) {
    throw invalid(`inputs must be an array of 1 to ${MAX_EMBEDDING_INPUTS} strings`);
  }
  let total = 0;
  const inputs = body['inputs'].map((input: unknown) => {
    const text = stringField(input, 'input', MAX_EMBEDDING_CHARS, 0);
    total += text.length;
    if (total > MAX_EMBEDDING_CHARS) throw invalid('inputs exceed the size limit');
    return text;
  });
  return {
    requestId: stringField(body['requestId'], 'requestId', 200),
    inputs,
    billing: billingOf(body['billing']),
  };
}

export function billingOf(value: unknown): Billing {
  const billing = objectBody(value, 'billing');
  return {
    organizationId: stringField(billing['organizationId'], 'billing.organizationId', 128),
    userId: stringField(billing['userId'], 'billing.userId', 128),
  };
}

function tierOf(value: unknown): InferenceTier {
  if (typeof value !== 'string' || !(INFERENCE_TIERS as readonly string[]).includes(value)) {
    throw invalid(`tier must be one of ${INFERENCE_TIERS.join(', ')}`);
  }
  return value as InferenceTier;
}

function temperatureOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw invalid('temperature must be from 0 to 2');
  }
  return value;
}

const ROLES: readonly InferenceRole[] = ['system', 'user', 'assistant', 'tool'];

function messagesOf(value: unknown): InferenceMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INFERENCE_MESSAGES) {
    throw invalid(`messages must be an array of 1 to ${MAX_INFERENCE_MESSAGES} entries`);
  }
  let total = 0;
  return value.map((entry: unknown): InferenceMessage => {
    const message = objectBody(entry, 'message');
    const role = message['role'];
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      throw invalid('message role must be system, user, assistant, or tool');
    }
    const content = stringField(message['content'], 'message content', MAX_INFERENCE_CHARS, 0);
    total += content.length;
    if (total > MAX_INFERENCE_CHARS) throw invalid('messages exceed the size limit');
    const toolCalls = toolCallsOf(message['toolCalls']);
    const toolCallId = message['toolCallId'] === undefined ? undefined : stringField(message['toolCallId'], 'toolCallId', 128);
    if (role === 'tool' && toolCallId === undefined) throw invalid('a tool message needs toolCallId');
    return {
      role: role as InferenceRole,
      content,
      ...(toolCalls === undefined ? {} : { toolCalls }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    };
  });
}

function toolCallsOf(value: unknown): InferenceMessage['toolCalls'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TOOLS) throw invalid('toolCalls must be a short array');
  return value.map((entry: unknown) => {
    const call = objectBody(entry, 'toolCall');
    return {
      id: stringField(call['id'], 'toolCall.id', 128),
      name: stringField(call['name'], 'toolCall.name', 128),
      arguments: stringField(call['arguments'], 'toolCall.arguments', MAX_INFERENCE_CHARS, 0),
    };
  });
}

function toolsOf(value: unknown): InferenceToolSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOLS) throw invalid(`tools must be an array of at most ${MAX_TOOLS}`);
  return value.map((entry: unknown) => {
    const tool = objectBody(entry, 'tool');
    const parameters = objectBody(tool['parameters'], 'tool.parameters');
    return {
      name: stringField(tool['name'], 'tool.name', 128),
      description: stringField(tool['description'], 'tool.description', 4_096, 0),
      parameters: parameters as Readonly<Record<string, JsonValue>>,
    };
  });
}

/** Digest check for a 64-character lowercase hex string, used on blob paths. */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}
