/**
 * Web Crypto helpers for the gateway: digests for API keys, PBKDF2 for passwords, and HMAC-signed tokens for
 * dashboard sessions. Everything runs on `crypto.subtle` or `crypto.getRandomValues`. No dependency is pulled in.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * PBKDF2 iteration count. Workers caps PBKDF2 at 100,000 iterations, so this is the strongest setting the
 * runtime accepts.
 */
export const PBKDF2_ITERATIONS = 100_000;

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomHex(length: number): string {
  return toHex(randomBytes(length));
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Compares two byte arrays without returning early on the first difference. */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Constant-time comparison of two strings, for bearer tokens. */
export function timingSafeEqualText(presented: string, expected: string): boolean {
  return timingSafeEqual(encoder.encode(presented), encoder.encode(expected));
}

/** Hashes a password into `pbkdf2-sha256$<iterations>$<salt>$<hash>`. The salt is random per call. */
export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${base64url(salt)}$${base64url(hash)}`;
}

/** Checks a password against a stored hash. Malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const salt = fromBase64url(parts[2] ?? '');
  const expected = fromBase64url(parts[3] ?? '');
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/** Signs a JSON payload as `v1.<payload>.<signature>` with HMAC-SHA256. */
export async function signToken(payload: object, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, `v1.${body}`);
  return `v1.${body}.${base64url(signature)}`;
}

/** Returns the payload when the signature checks out. Expiry is the caller's job. */
export async function verifyToken<T>(token: string, secret: string): Promise<T | undefined> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
  let presented: Uint8Array;
  try {
    presented = fromBase64url(parts[2] ?? '');
  } catch {
    return undefined;
  }
  const expected = await hmac(secret, `v1.${parts[1] ?? ''}`);
  if (!timingSafeEqual(presented, expected)) return undefined;
  try {
    return JSON.parse(decoder.decode(fromBase64url(parts[1] ?? ''))) as T;
  } catch {
    return undefined;
  }
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
