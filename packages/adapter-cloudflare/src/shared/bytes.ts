const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Copies a view into an exact-length ArrayBuffer, safe for SQLite BLOB binds and R2 metadata. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function isGitCommitHex(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    groups.push(items.slice(offset, offset + size));
  }
  return groups;
}

/** SHA-256 of a UTF-8 string as lowercase hex. Used to derive stable Workflow instance ids. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
