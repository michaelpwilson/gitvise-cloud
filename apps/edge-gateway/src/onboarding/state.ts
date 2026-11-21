/**
 * The steps a signed-in account still has to finish, in order. The gateway decides them, and the web app renders
 * whichever one comes first. Email confirmation is not a step here: an account row only exists once its email is
 * confirmed, so the confirm screen belongs to the signup wizard, before sign-in.
 */
export type OnboardingStep = 'plan' | 'checkout' | 'passkey' | 'done';

export interface OnboardingState {
  /** Organisation tier. `none` until a Checkout completes. */
  readonly tier: string;
  /** The plan the user picked, or `null` before they pick one. */
  readonly planChoice: string | null;
  /** When the owner last started Checkout. Still set while the tier is `none` means the Checkout was abandoned. */
  readonly checkoutStartedAt: number | null;
  /** True for wizard accounts. Existing accounts are never asked for a passkey. */
  readonly passkeyRequired: boolean;
  /** Count of registered passkeys, read from `users.webauthn_credentials`. */
  readonly passkeys: number;
}

export function onboardingStep(state: OnboardingState): OnboardingStep {
  // Existing accounts were never asked for a plan or a passkey, so they are not gated by any of these steps.
  if (!state.passkeyRequired) return 'done';
  if (state.tier === 'none') {
    // Abandoned Checkout goes back to the plan picker, so the user chooses again.
    if (state.planChoice === null || state.checkoutStartedAt !== null) return 'plan';
    return 'checkout';
  }
  if (state.passkeys === 0) return 'passkey';
  return 'done';
}
