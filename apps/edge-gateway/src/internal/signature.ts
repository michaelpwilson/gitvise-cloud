/**
 * Verifies `gitvise-internal-v1` requests from the apps/api container. The scheme is shared with
 * `apps/api/src/gateway/internal-signature.ts` in the gitvise repo, and the canonical string must match it byte for
 * byte:
 *
 *   gitvise-internal-v1 / METHOD / path-and-query / content-sha256 / timestamp-ms / nonce   (one per line)
 *
 * This verifier uses WebCrypto, because a Worker has no `node:crypto` HMAC. Checks: the header set is complete, the
 * timestamp is within the skew window, the claimed body digest matches the bytes received, and the HMAC matches.
 * Replay is bounded by the skew window only, which is the same limit the sending side's verifier enforces.
 */
export const INTERNAL_SIGNATURE_VERSION = 'gitvise-internal-v1';
/** Sent as the content digest of a streamed body. The receiver checks the digest where the content is addressed. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** Passed as `body` when the request body was not buffered, so the digest is not checked here. */
export const STREAMED_BODY = 'streamed';
export const INTERNAL_HEADERS = {
  timestamp: 'x-gitvise-internal-timestamp',
  nonce: 'x-gitvise-internal-nonce',
  contentSha256: 'x-gitvise-internal-content-sha256',
  signature: 'x-gitvise-internal-signature',
} as const;

/** Requests older or newer than this are refused. Matches `INTERNAL_MAX_SKEW_MS` on the sending side. */
export const INTERNAL_MAX_SKEW_MS = 5 * 60_000;

export interface InternalSignatureInput {
  readonly secret: string;
  readonly method: string;
  /** Path plus query, exactly as the sender signed it. */
  readonly pathAndQuery: string;
  readonly headers: Headers;
  /**
   * The raw request body, buffered, so the claimed digest is checked against it. `STREAMED_BODY` when the body was
   * not buffered; then the sender must have signed `UNSIGNED-PAYLOAD`, and the route checks the content itself.
   */
  readonly body: Uint8Array | typeof STREAMED_BODY;
  readonly nowMs?: number;
}

export async function verifyInternalSignature(input: InternalSignatureInput): Promise<boolean> {
  const timestamp = input.headers.get(INTERNAL_HEADERS.timestamp);
  const nonce = input.headers.get(INTERNAL_HEADERS.nonce);
  const contentSha = input.headers.get(INTERNAL_HEADERS.contentSha256);
  const signature = input.headers.get(INTERNAL_HEADERS.signature);
  if (timestamp === null || nonce === null || contentSha === null || signature === null) return false;
  if (!/^\d{1,16}$/.test(timestamp) || !/^[A-Za-z0-9-]{8,128}$/.test(nonce)) return false;
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;

  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - Number(timestamp)) > INTERNAL_MAX_SKEW_MS) return false;

  if (input.body === STREAMED_BODY) {
    if (contentSha !== UNSIGNED_PAYLOAD) return false;
  } else {
    // The digest the sender claims must be the digest of the bytes we actually received.
    if (contentSha === UNSIGNED_PAYLOAD) return false;
    const actualSha = toHex(await crypto.subtle.digest('SHA-256', input.body));
    if (!constantTimeEqual(actualSha, contentSha)) return false;
  }

  const canonical = [
    INTERNAL_SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.pathAndQuery,
    contentSha,
    timestamp,
    nonce,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  return constantTimeEqual(expected, signature);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings without stopping at the first difference. Length is compared first, which is not secret. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
