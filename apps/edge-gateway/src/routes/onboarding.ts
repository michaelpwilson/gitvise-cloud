import { Hono } from 'hono';
import { GitViseError } from '@gitvise/core';
import type { AppEnv } from '../app-env';
import { readJson } from '../http';
import { requireOwner, requirePrincipal, requireSession } from '../auth/principal';
import { onboardingStep, type OnboardingState } from '../onboarding/state';
import { planValue, seatsFor } from '../signup/validate';

/**
 * The steps a signed-in account still has to finish after sign-in. The web app reads `GET /` to decide what to show,
 * and `POST /plan` records the plan the owner picks again after an abandoned Checkout.
 */
export const onboardingRoutes = new Hono<AppEnv>();

interface StatusRow {
  readonly email: string;
  readonly tier: string;
  readonly plan_choice: string | null;
  readonly seat_choice: number | null;
  readonly checkout_started_at: number | null;
  readonly passkey_required: number;
  readonly passkeys: number;
}

onboardingRoutes.get('/', requirePrincipal, async (c) => {
  const { orgId, userId } = c.get('principal');
  const row = await loadStatus(c.env.D1, userId, orgId);
  if (row === null) throw new GitViseError('NOT_FOUND', 'no account for this session');
  c.header('cache-control', 'no-store');
  return c.json(toResponse(row));
});

onboardingRoutes.post('/plan', requireSession, requireOwner, async (c) => {
  const { orgId, userId } = c.get('principal');
  const body = await readJson<{ plan?: unknown; seats?: unknown }>(c.req.raw);
  const plan = planValue(body.plan);
  const seats = seatsFor(plan, body.seats);

  const current = await loadStatus(c.env.D1, userId, orgId);
  if (current === null) throw new GitViseError('NOT_FOUND', 'no account for this session');
  if (current.tier !== 'none') throw new GitViseError('CONFLICT', 'this organisation already has a plan');

  // Choosing again clears the abandoned-Checkout marker, so the next step is Checkout for the new choice.
  await c.env.D1.prepare(
    'UPDATE users SET plan_choice = ?1, seat_choice = ?2, checkout_started_at = NULL, updated_at = ?3 WHERE id = ?4 AND org_id = ?5',
  )
    .bind(plan, seats, Date.now(), userId, orgId)
    .run();

  const next = await loadStatus(c.env.D1, userId, orgId);
  if (next === null) throw new GitViseError('NOT_FOUND', 'no account for this session');
  c.header('cache-control', 'no-store');
  return c.json(toResponse(next));
});

async function loadStatus(db: D1Database, userId: string, orgId: string): Promise<StatusRow | null> {
  return db
    .prepare(
      `SELECT u.email, o.tier, u.plan_choice, u.seat_choice, u.checkout_started_at, u.passkey_required,
              json_array_length(u.webauthn_credentials) AS passkeys
         FROM users u
         JOIN organizations o ON o.id = u.org_id
        WHERE u.id = ?1 AND u.org_id = ?2`,
    )
    .bind(userId, orgId)
    .first<StatusRow>();
}

function toResponse(row: StatusRow) {
  const state: OnboardingState = {
    tier: row.tier,
    planChoice: row.plan_choice,
    checkoutStartedAt: row.checkout_started_at,
    passkeyRequired: row.passkey_required === 1,
    passkeys: row.passkeys,
  };
  return {
    step: onboardingStep(state),
    email: row.email,
    tier: row.tier,
    plan: row.plan_choice,
    seats: row.seat_choice ?? 1,
    passkeys: row.passkeys,
  };
}
