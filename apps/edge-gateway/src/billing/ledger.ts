import type { UsageRecord } from './usage';
import type { GrantResult } from './billing-guard';
import type { PaidTier } from './plans';

/**
 * D1 writes for billing. Every insert uses a deterministic id with ON CONFLICT DO NOTHING, so replaying an
 * event or a settlement is safe. The BillingGuard Durable Object holds the live balances. These rows are the
 * audit trail and a read-side mirror.
 */

export interface RecordUsageOptions {
  /**
   * Whether to also copy the record's balances onto `organizations`. The inline write does, because it has the
   * newest balances. The outbox flush does not: a record flushed late holds older balances, and copying them
   * would move the mirror backwards. The reconciliation refreshes the mirror from the live guard instead.
   */
  readonly refreshMirror?: boolean;
}

export async function recordUsage(db: D1Database, record: UsageRecord, options: RecordUsageOptions = {}): Promise<void> {
  const statements: D1PreparedStatement[] = [
    // Usage can arrive before any billing event for an org, and the row must reference an existing org.
    db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').bind(record.orgId, record.orgId),
    db
      .prepare(
        `INSERT INTO usage_events (id, org_id, user_id, tier, model, prompt_tokens, completion_tokens, cost_pence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        record.requestId,
        record.orgId,
        record.userId,
        record.tier,
        record.model,
        record.promptTokens,
        record.completionTokens,
        record.costPence,
      ),
  ];

  // A replayed settlement only re-asserts the usage row. Its balances are older than the live ones, so it
  // must not touch the ledger or the mirror.
  if (!record.duplicate) {
    if (record.monthlyDebitPence > 0) {
      statements.push(
        ledgerInsert(db, record.requestId, record.orgId, 'monthly', 'usage_debit', -record.monthlyDebitPence, record.monthlyPenceAfter),
      );
    }
    if (record.topupDebitPence > 0) {
      statements.push(
        ledgerInsert(db, record.requestId, record.orgId, 'topup', 'usage_debit', -record.topupDebitPence, record.topupPenceAfter),
      );
    }
    if (options.refreshMirror !== false) {
      statements.push(mirrorBalances(db, record.orgId, record.monthlyPenceAfter, record.topupPenceAfter));
    }
  }
  await db.batch(statements);
}

/** Sums the ledger per bucket. For a consistent org these equal the live guard balances. */
export async function ledgerTotals(db: D1Database, orgId: string): Promise<{ readonly monthlyPence: number; readonly topupPence: number }> {
  const rows = await db
    .prepare('SELECT bucket, COALESCE(SUM(amount_pence), 0) AS total FROM credit_ledger WHERE org_id = ?1 GROUP BY bucket')
    .bind(orgId)
    .all<{ bucket: string; total: number }>();
  const totals = { monthlyPence: 0, topupPence: 0 };
  for (const row of rows.results) {
    if (row.bucket === 'monthly') totals.monthlyPence = row.total;
    if (row.bucket === 'topup') totals.topupPence = row.total;
  }
  return totals;
}

/** Copies live balances onto `organizations`. Used by the reconciliation, which has the authoritative values. */
export async function refreshMirror(db: D1Database, orgId: string, monthlyPence: number, topupPence: number): Promise<void> {
  await mirrorBalances(db, orgId, monthlyPence, topupPence).run();
}

function mirrorBalances(db: D1Database, orgId: string, monthlyPence: number, topupPence: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE organizations
          SET monthly_credits_remaining_pence = ?, topup_credits_remaining_pence = ?, updated_at = unixepoch() * 1000
        WHERE id = ?`,
    )
    .bind(monthlyPence, topupPence, orgId);
}

/**
 * Writes the ledger row for a grant or monthly reset, and refreshes the mirror on `organizations`.
 * Pass the Durable Object's result so the mirror reflects its balances.
 */
export async function recordGrant(
  db: D1Database,
  orgId: string,
  kind: 'subscription_grant' | 'topup_purchase' | 'monthly_reset' | 'adjustment',
  ref: string,
  result: GrantResult,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (result.applied && result.deltaPence !== 0) {
    const balanceAfter = result.bucket === 'monthly' ? result.monthlyPence : result.topupPence;
    statements.push(ledgerInsert(db, ref, orgId, result.bucket, kind, result.deltaPence, balanceAfter));
  }
  statements.push(mirrorBalances(db, orgId, result.monthlyPence, result.topupPence));
  await db.batch(statements);
}

export async function ensureOrganization(db: D1Database, orgId: string, name: string): Promise<void> {
  await db
    .prepare('INSERT INTO organizations (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
    .bind(orgId, name)
    .run();
}

/** Writes the org's plan, seats and enterprise flags. Called when a subscription becomes active. */
export async function applyPlan(
  db: D1Database,
  input: {
    readonly orgId: string;
    readonly tier: PaidTier;
    readonly seats: number;
    readonly stripeCustomerId: string | null;
    readonly samlSso: boolean;
    readonly b4AuditLog: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE organizations
          SET tier = ?, seats = ?,
              stripe_customer_id = COALESCE(?, stripe_customer_id),
              saml_sso_enabled = ?, b4_audit_log_enabled = ?, updated_at = unixepoch() * 1000
        WHERE id = ?`,
    )
    .bind(input.tier, input.seats, input.stripeCustomerId, input.samlSso ? 1 : 0, input.b4AuditLog ? 1 : 0, input.orgId)
    .run();
}

/** Clears the plan flags when a subscription ends. Top-up balance is untouched. */
export async function clearPlan(db: D1Database, orgId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE organizations
          SET tier = 'none', saml_sso_enabled = 0, b4_audit_log_enabled = 0, updated_at = unixepoch() * 1000
        WHERE id = ?`,
    )
    .bind(orgId)
    .run();
}

export async function upsertSubscription(
  db: D1Database,
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly tier: PaidTier;
    readonly seats: number;
    readonly status: string;
    readonly currentPeriodEnd: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions (id, org_id, tier, seats, status, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         tier = excluded.tier, seats = excluded.seats, status = excluded.status,
         current_period_end = excluded.current_period_end, updated_at = unixepoch()`,
    )
    .bind(input.id, input.orgId, input.tier, input.seats, input.status, input.currentPeriodEnd)
    .run();
}

export interface SubscriptionRow {
  readonly id: string;
  readonly org_id: string;
  readonly tier: PaidTier;
  readonly seats: number;
  readonly status: string;
}

export async function findSubscription(db: D1Database, id: string): Promise<SubscriptionRow | null> {
  return db
    .prepare('SELECT id, org_id, tier, seats, status FROM subscriptions WHERE id = ?')
    .bind(id)
    .first<SubscriptionRow>();
}

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly seats: number;
  readonly saml_sso_enabled: number;
  readonly b4_audit_log_enabled: number;
  readonly hard_cap_enabled: number;
  readonly monthly_credits_remaining_pence: number;
  readonly topup_credits_remaining_pence: number;
}

export async function findOrganization(db: D1Database, orgId: string): Promise<OrganizationRow | null> {
  return db
    .prepare(
      `SELECT id, name, tier, seats, saml_sso_enabled, b4_audit_log_enabled, hard_cap_enabled,
              monthly_credits_remaining_pence, topup_credits_remaining_pence
         FROM organizations WHERE id = ?`,
    )
    .bind(orgId)
    .first<OrganizationRow>();
}

export async function hasSeenStripeEvent(db: D1Database, eventId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM stripe_events WHERE id = ?').bind(eventId).first<{ id: string }>();
  return row !== null;
}

export async function markStripeEvent(db: D1Database, eventId: string, type: string): Promise<void> {
  await db
    .prepare('INSERT INTO stripe_events (id, type) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
    .bind(eventId, type)
    .run();
}

function ledgerInsert(
  db: D1Database,
  idSeed: string,
  orgId: string,
  bucket: 'monthly' | 'topup',
  kind: 'usage_debit' | 'subscription_grant' | 'topup_purchase' | 'monthly_reset' | 'adjustment',
  amountPence: number,
  balanceAfterPence: number,
): D1PreparedStatement {
  // The id is derived from the event or request id, so a replay hits ON CONFLICT and writes nothing.
  return db
    .prepare(
      `INSERT INTO credit_ledger (id, org_id, bucket, kind, amount_pence, balance_after_pence, ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(`${kind}:${idSeed}:${bucket}`, orgId, bucket, kind, amountPence, balanceAfterPence, idSeed);
}
