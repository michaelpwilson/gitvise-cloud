import { INTERNAL_HEADERS, INTERNAL_SIGNATURE_VERSION } from './signature';

/**
 * Signs a request the gateway sends to the apps/api container, with the same `gitvise-internal-v1` scheme the
 * container verifies. The verifier in apps/api rebuilds the canonical string from the method, the path, and the
 * timestamp, so the path here must be the one the container sees.
 */
export async function signedInternalHeaders(
  secret: string,
  method: string,
  pathAndQuery: string,
  body: Uint8Array,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  const contentSha = toHex(await crypto.subtle.digest('SHA-256', body));
  const timestamp = String(nowMs);
  const nonce = `gw-${crypto.randomUUID()}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const canonical = [INTERNAL_SIGNATURE_VERSION, method.toUpperCase(), pathAndQuery, contentSha, timestamp, nonce].join(
    '\n',
  );
  const signature = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  return {
    [INTERNAL_HEADERS.timestamp]: timestamp,
    [INTERNAL_HEADERS.nonce]: nonce,
    [INTERNAL_HEADERS.contentSha256]: contentSha,
    [INTERNAL_HEADERS.signature]: signature,
  };
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
