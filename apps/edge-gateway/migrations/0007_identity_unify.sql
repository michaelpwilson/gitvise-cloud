-- `organizations` and `users` are shared by the gateway and apps/api, which use one D1 database. Migrations 0001 to 0006
-- created the gateway's shape: a billing tenant per organisation, and a user with one organisation and a password.
-- apps/api (see 0008_api_schema.sql) needs both tables with its own columns: an organisation with a slug, and a user with
-- a username and passkeys, who joins organisations through organization_members.
--
-- Both tables now carry every column. The gateway's columns keep their meaning. The columns only one side sets are
-- nullable:
--   users.org_id          null for an apps/api user, whose membership lives in organization_members
--   users.password_hash   null for a passkey-only user, who cannot sign in with a password
--   users.username        null for a gateway user
--   organizations.slug    null for a gateway organisation
--
-- Timestamps are milliseconds from here on, the unit apps/api reads. Existing rows are converted, and the gateway writes
-- milliseconds to `organizations` too.
--
-- SQLite cannot drop NOT NULL or change a default in place, so each table is rebuilt. The rows go through a backup table,
-- and the rebuilt table is filled only after the old one is dropped. Its child rows (api_keys, sessions, ...) still
-- reference it. Dropping a parent counts each child as a pending violation, and inserting the parent again clears it.
-- So the rows must be inserted after the drop, not before it. defer_foreign_keys holds the check until commit.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE organizations_backup AS
  SELECT id, name, tier, seats, stripe_customer_id, saml_sso_enabled, b4_audit_log_enabled, hard_cap_enabled,
         monthly_credits_remaining_pence, topup_credits_remaining_pence, created_at, updated_at
  FROM organizations;

DROP TABLE organizations;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
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
  created_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer))
);

INSERT INTO organizations (
  id, name, slug, tier, seats, stripe_customer_id, saml_sso_enabled, b4_audit_log_enabled, hard_cap_enabled,
  monthly_credits_remaining_pence, topup_credits_remaining_pence, created_at, updated_at
)
SELECT
  id, name, NULL, tier, seats, stripe_customer_id, saml_sso_enabled, b4_audit_log_enabled, hard_cap_enabled,
  monthly_credits_remaining_pence, topup_credits_remaining_pence, created_at * 1000, updated_at * 1000
FROM organizations_backup;

DROP TABLE organizations_backup;

-- Lower-cased, like apps/api's. Nulls are distinct in a unique index, so gateway organisations without a slug do not collide.
CREATE UNIQUE INDEX organizations_slug_lower_unique ON organizations (lower(slug));

CREATE TABLE users_backup AS
  SELECT id, org_id, email, role, password_hash, created_at FROM users;

DROP TABLE users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations (id),
  email TEXT NOT NULL,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  password_hash TEXT,
  public_key TEXT,
  webauthn_credentials TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(webauthn_credentials)),
  created_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer))
);

INSERT INTO users (id, org_id, email, username, role, password_hash, created_at, updated_at)
SELECT id, org_id, email, NULL, role, password_hash, created_at * 1000, created_at * 1000
FROM users_backup;

DROP TABLE users_backup;

CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));
CREATE UNIQUE INDEX users_username_lower_unique ON users (lower(username));
CREATE INDEX users_by_org ON users (org_id);
