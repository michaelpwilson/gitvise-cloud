-- Server-side dashboard sessions. The session cookie is a signed pointer to a row here, and a session is valid only
-- while its row is unrevoked and unexpired. That is what lets logout end a session at once, even if the token was
-- copied.
--
-- No foreign key to users: the session check in principal.ts already refuses a session whose user is gone, and a
-- foreign key would block deleting a user while sessions remain.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  org_id      TEXT NOT NULL REFERENCES organizations (id),
  role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

-- Lets the scheduled job delete expired rows without scanning the table.
CREATE INDEX sessions_by_expiry ON sessions (expires_at);
