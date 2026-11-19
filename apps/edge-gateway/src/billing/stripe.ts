import { GitViseError } from '@gitvise/core';

function upstreamError(message: string, cause?: unknown): GitViseError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : '';
  return new GitViseError('UPSTREAM_FAILURE', `${message}${suffix}`);
}

/** Stripe's REST API over `fetch`. No SDK, so the Worker bundle stays small and the calls are explicit. */

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
/** Stripe's documented default. Events older than this are rejected to stop replay. */
export const STRIPE_TOLERANCE_SECONDS = 300;

export type StripeObject = Record<string, unknown>;

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: StripeObject };
}

/** Verifies a `Stripe-Signature` header (`t=...,v1=...`) against the raw request body. */
export async function verifyStripeSignature(input: {
  readonly payload: string;
  readonly header: string | null | undefined;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}): Promise<boolean> {
  if (input.header === null || input.header === undefined || input.secret === '') return false;

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value !== undefined && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value !== undefined) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS)) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signedPayload = encoder.encode(`${timestamp}.${input.payload}`);

  // `crypto.subtle.verify` compares in constant time. Any valid v1 signature in the header is accepted.
  for (const hex of signatures) {
    const bytes = hexToBytes(hex);
    if (bytes === undefined) continue;
    if (await crypto.subtle.verify('HMAC', key, bytes, signedPayload)) return true;
  }
  return false;
}

/** Computes a `v1` signature for a payload. Used by tests and by local webhook replay tooling. */
export async function computeStripeSignature(secret: string, timestamp: number, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
}

/**
 * Creates a Checkout session. `params` is form-encoded as-is, so nested keys use Stripe's bracket syntax
 * (for example `line_items[0][price]`). Callers build it, so no user input reaches a key name unchecked.
 */
export async function createCheckoutSession(
  secretKey: string,
  params: readonly (readonly [string, string])[],
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSession> {
  const body = new URLSearchParams(params as [string, string][]).toString();
  const response = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  }).catch((error: unknown) => {
    throw upstreamError('Stripe request failed', error);
  });
  if (!response.ok) {
    throw upstreamError(`Stripe returned ${response.status}: ${await response.text().catch(() => '')}`);
  }
  const session = (await response.json()) as { id?: unknown; url?: unknown };
  if (typeof session.id !== 'string' || typeof session.url !== 'string') {
    throw upstreamError('Stripe returned a checkout session without an id or url');
  }
  return { id: session.id, url: session.url };
}

/** Reads a string field from a Stripe object, or `undefined` when it is absent or not a string. */
export function stringField(object: StripeObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
