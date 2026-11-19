import { app } from '../../src/app';
import type { GatewayEnv } from '../../src/env';
import { INTERNAL_HEADERS } from '../../src/internal/signature';
import { httpEnv, TEST_SECRETS } from './bindings';

/** Builds the `gitvise-internal-v1` headers the apps/api container sends, with WebCrypto. */
export async function signedHeaders(
  method: string,
  path: string,
  body: string,
  options: { timestamp?: number; secret?: string } = {},
): Promise<Record<string, string>> {
  const sha = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const timestamp = String(options.timestamp ?? Date.now());
  const nonce = `nonce-${crypto.randomUUID()}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret ?? TEST_SECRETS.INTERNAL_GATEWAY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const canonical = ['gitvise-internal-v1', method, path, sha, timestamp, nonce].join('\n');
  const signature = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  return {
    'content-type': 'application/json',
    [INTERNAL_HEADERS.timestamp]: timestamp,
    [INTERNAL_HEADERS.nonce]: nonce,
    [INTERNAL_HEADERS.contentSha256]: sha,
    [INTERNAL_HEADERS.signature]: signature,
  };
}

/** Sends a signed JSON POST through the real app. */
export async function callInternal(path: string, payload: unknown, env: GatewayEnv = httpEnv()): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request(path, { method: 'POST', headers: await signedHeaders('POST', path, body), body }, env);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
