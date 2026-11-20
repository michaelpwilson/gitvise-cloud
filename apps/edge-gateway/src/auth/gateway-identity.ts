/**
 * Gateway -> container identity, version 2. The container (apps/api) verifies these headers with the same
 * canonical string and the shared `INTERNAL_GATEWAY_SECRET`. Keep this format in step with
 * `apps/api/src/gateway/gateway-identity.ts`. A change to one needs the same change to the other.
 */
export const GATEWAY_USER_ID_HEADER = 'x-gitvise-user-id';
export const GATEWAY_ORG_ID_HEADER = 'x-gitvise-org-id';
export const GATEWAY_USER_EMAIL_HEADER = 'x-gitvise-user-email';
export const GATEWAY_TIMESTAMP_HEADER = 'x-gitvise-timestamp';
export const GATEWAY_SIGNATURE_HEADER = 'x-gitvise-signature';

/** Every identity header. Callers may send these, so the gateway removes them before it forwards anything. */
export const GATEWAY_IDENTITY_HEADERS: readonly string[] = [
  GATEWAY_USER_ID_HEADER,
  GATEWAY_ORG_ID_HEADER,
  GATEWAY_USER_EMAIL_HEADER,
  GATEWAY_TIMESTAMP_HEADER,
  GATEWAY_SIGNATURE_HEADER,
];

const CANONICAL_VERSION = 'gitvise-gateway-v2';

export interface GatewayIdentityClaims {
  /** HTTP method, as the gateway received it. */
  readonly method: string;
  /** Path only, without the query string. */
  readonly path: string;
  readonly userId: string;
  readonly orgId: string;
  /** Optional. Signed as an empty line when absent. */
  readonly email?: string;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: number;
}

/** The canonical string the signature covers. Each field is on its own line, so no field can shift into another. */
export function canonicalGatewayClaims(claims: GatewayIdentityClaims): string {
  return [
    CANONICAL_VERSION,
    claims.method.toUpperCase(),
    claims.path,
    claims.userId,
    claims.orgId,
    claims.email ?? '',
    String(claims.timestamp),
  ].join('\n');
}

/** Hex HMAC-SHA256 of the canonical claims, the same value the container computes. */
export async function signGatewayClaims(secret: string, claims: GatewayIdentityClaims): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalGatewayClaims(claims)));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Replaces the identity headers on an outgoing request with signed values for `claims`. Any identity header the
 * caller sent is removed first, so a forged header can never reach the container.
 */
export async function setGatewayIdentity(headers: Headers, secret: string, claims: GatewayIdentityClaims): Promise<void> {
  for (const name of GATEWAY_IDENTITY_HEADERS) headers.delete(name);
  headers.set(GATEWAY_USER_ID_HEADER, claims.userId);
  headers.set(GATEWAY_ORG_ID_HEADER, claims.orgId);
  if (claims.email !== undefined) headers.set(GATEWAY_USER_EMAIL_HEADER, claims.email);
  headers.set(GATEWAY_TIMESTAMP_HEADER, String(claims.timestamp));
  headers.set(GATEWAY_SIGNATURE_HEADER, await signGatewayClaims(secret, claims));
}
