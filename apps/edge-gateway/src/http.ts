import { GitViseError } from '@gitvise/core';

/** Reads a JSON body. A malformed body is a client error, not a server error. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new GitViseError('INVALID_REQUEST', 'body must be valid JSON');
  }
}

/** Shape of an emailed login. Lower-cased so one address cannot register twice under different cases. */
export function emailValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new GitViseError('INVALID_REQUEST', 'email must be a valid address');
  }
  return value.trim().toLowerCase();
}

export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_BYTES = 256;

export function passwordValue(value: unknown): string {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN_CHARS || new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) {
    throw new GitViseError(
      'INVALID_REQUEST',
      `password must be between ${PASSWORD_MIN_CHARS} characters and ${PASSWORD_MAX_BYTES} bytes`,
    );
  }
  return value;
}

/** True for a D1 or SQLite uniqueness violation, which is how a concurrent duplicate registration shows up. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
