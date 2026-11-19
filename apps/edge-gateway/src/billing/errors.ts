/**
 * Raised when an organisation has no credit left and its hard cap is on. Maps to HTTP 402 so the client
 * can offer a one-click top-up.
 */
export class CreditExhaustedError extends Error {
  override readonly name = 'CreditExhaustedError';
  readonly status = 402;

  constructor(readonly availablePence: number) {
    super('organisation has no remaining credit');
  }
}

/** Raised when a Stripe event references state we do not have yet. Stripe retries on a non-2xx response. */
export class RetryableWebhookError extends Error {
  override readonly name = 'RetryableWebhookError';
}
