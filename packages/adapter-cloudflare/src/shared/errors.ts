import { GitViseError } from '@gitvise/core';

/** Wraps unknown failures from a Cloudflare binding without leaking non-GitVise error types. */
export function upstreamError(message: string, cause?: unknown): GitViseError {
  const suffix = cause instanceof Error ? `: ${cause.message}` : '';
  return new GitViseError('UPSTREAM_FAILURE', `${message}${suffix}`);
}

export function invalid(message: string): GitViseError {
  return new GitViseError('INVALID_REQUEST', message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
