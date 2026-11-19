-- Tenant authentication, API keys, sandbox lease ownership, and parent links for commit snapshots.

-- Dashboard login. PBKDF2-SHA256 in the form `pbkdf2-sha256$<iterations>$<salt>$<hash>`. Users created before
-- this migration have no password and cannot sign in.
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- API keys for CLI and IDE clients. Only the SHA-256 digest of the key is stored, never the key itself.
-- The role is copied from the user at mint time, so a key can never carry more than its owner had.
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  key_hash    TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  org_id      TEXT NOT NULL REFERENCES organizations (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  name        TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 64),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at  INTEGER
);
CREATE INDEX api_keys_by_user ON api_keys (user_id);

-- Which organisation owns each sandbox lease. Lease ids are random, but ownership is still checked on every use.
CREATE TABLE sandbox_leases (
  lease_id    TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations (id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- A snapshot records the commit it holds and the commit it was built on. The root commit has no parent.
ALTER TABLE commit_snapshots ADD COLUMN parent_hash TEXT CHECK (parent_hash IS NULL OR length(parent_hash) IN (40, 64));
