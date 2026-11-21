import { GitViseError } from '@gitvise/core';
import { isPaidTier, PLANS, type PaidTier } from '../billing/plans';

/** Mirrors apps/api's `usernameSchema`, so a name the wizard accepts is one the API accepts for passkeys. */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_SEATS = 10_000;
const NAME_MAX_CHARS = 100;

export interface SignupDetails {
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string;
  readonly plan: PaidTier;
  readonly seats: number;
}

export function nameValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GitViseError('INVALID_REQUEST', `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_CHARS) {
    throw new GitViseError('INVALID_REQUEST', `${label} must be 1 to ${NAME_MAX_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new GitViseError('INVALID_REQUEST', `${label} has control characters`);
  return trimmed;
}

export function usernameValue(value: unknown): string {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
    throw new GitViseError('INVALID_REQUEST', 'username may use letters, numbers, and . _ -, and must start with a letter or number');
  }
  if (value.includes('..') || value.toLowerCase().endsWith('.git')) {
    throw new GitViseError('INVALID_REQUEST', 'username is not allowed');
  }
  return value;
}

/** Pro is a single seat. Business and Enterprise take a whole number of seats. */
export function seatsFor(plan: PaidTier, value: unknown): number {
  if (!PLANS[plan].perSeat) return 1;
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SEATS) {
    throw new GitViseError('INVALID_REQUEST', `seats must be an integer from 1 to ${MAX_SEATS}`);
  }
  return value;
}

export function planValue(value: unknown): PaidTier {
  if (!isPaidTier(value)) throw new GitViseError('INVALID_REQUEST', 'plan must be pro, business, or enterprise');
  return value;
}

export function termsAccepted(value: unknown): true {
  if (value !== true) throw new GitViseError('INVALID_REQUEST', 'you must accept the terms and privacy policy');
  return true;
}
