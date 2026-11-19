-- Billing schema: organisations, seats, Stripe subscriptions, and the credit ledger.
--
-- The BillingGuard Durable Object is the source of truth for live balances. The balance columns on
-- `organizations` are a read-side mirror, refreshed after each settlement, and never used for a debit decision.
--
-- Money is stored in pence (GBP) as INTEGER. Never use floats for money.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'none' CHECK (tier IN ('none', 'pro', 'business', 'enterprise')),
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  stripe_customer_id TEXT UNIQUE,
  saml_sso_enabled INTEGER NOT NULL DEFAULT 0 CHECK (saml_sso_enabled IN (0, 1)),
  b4_audit_log_enabled INTEGER NOT NULL DEFAULT 0 CHECK (b4_audit_log_enabled IN (0, 1)),
  -- 1 = refuse inference once balance is exhausted (HTTP 402). 0 = allow overage, billed later.
  hard_cap_enabled INTEGER NOT NULL DEFAULT 1 CHECK (hard_cap_enabled IN (0, 1)),
  -- Refreshed on `invoice.paid`. Expires at period end.
  monthly_credits_remaining_pence INTEGER NOT NULL DEFAULT 0,
  -- Top-up packs. Never reset by the billing cycle.
  topup_credits_remaining_pence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS users_by_org ON users (org_id);

-- One row per Stripe subscription. `id` is the Stripe subscription id (`sub_...`).
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  tier TEXT NOT NULL CHECK (tier IN ('pro', 'business', 'enterprise')),
  seats INTEGER NOT NULL CHECK (seats >= 1),
  status TEXT NOT NULL,
  current_period_end INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS subscriptions_by_org ON subscriptions (org_id);

-- Append-only ledger of every balance movement. `id` is an idempotency key, so a replayed event cannot post twice.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  bucket TEXT NOT NULL CHECK (bucket IN ('monthly', 'topup')),
  kind TEXT NOT NULL CHECK (kind IN ('usage_debit', 'monthly_reset', 'subscription_grant', 'topup_purchase', 'adjustment')),
  -- Signed: positive credits the balance, negative debits it.
  amount_pence INTEGER NOT NULL,
  balance_after_pence INTEGER NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS credit_ledger_by_org ON credit_ledger (org_id, created_at);

-- Immutable record of each metered inference call. Written once, on the final usage event.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  user_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
  cost_pence INTEGER NOT NULL CHECK (cost_pence >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS usage_events_by_org ON usage_events (org_id, created_at);

-- Stripe webhook idempotency. Recorded only after the event has been applied successfully.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Enforce immutability in the database, not only in application code.
CREATE TRIGGER IF NOT EXISTS credit_ledger_no_update
BEFORE UPDATE ON credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'credit_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS credit_ledger_no_delete
BEFORE DELETE ON credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'credit_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS usage_events_no_update
BEFORE UPDATE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS usage_events_no_delete
BEFORE DELETE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only');
END;
