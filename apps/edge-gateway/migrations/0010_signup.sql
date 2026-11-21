-- Signup wizard: names, email verification, terms, the plan chosen before confirmation, and the pending signups
-- that hold a registration until its email is confirmed.
--
-- Existing accounts predate the wizard. They are treated as verified and as having accepted the terms, so they keep
-- their current sign-in and do not see the onboarding steps.

ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
-- The plan the user picked in the wizard. Set once the email is confirmed, and cleared when they choose again.
ALTER TABLE users ADD COLUMN plan_choice TEXT CHECK (plan_choice IN ('pro', 'business', 'enterprise'));
ALTER TABLE users ADD COLUMN seat_choice INTEGER CHECK (seat_choice IS NULL OR seat_choice >= 1);
-- Set when the owner starts Stripe Checkout. Still set on return with no paid tier means Checkout was abandoned.
ALTER TABLE users ADD COLUMN checkout_started_at INTEGER;
-- 1 for accounts created by the wizard, which must add a passkey before the workspace opens. Existing accounts stay 0,
-- so they keep their sign-in with no new step.
ALTER TABLE users ADD COLUMN passkey_required INTEGER NOT NULL DEFAULT 0 CHECK (passkey_required IN (0, 1));

UPDATE users
   SET email_verified_at = created_at,
       terms_accepted_at = created_at
 WHERE email_verified_at IS NULL;

-- One row per registration that has not been confirmed yet. `token_hash` is the SHA-256 of the emailed token, so
-- the database never holds a usable link. `password_hash` is PBKDF2, as for users.
CREATE TABLE pending_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('pro', 'business', 'enterprise')),
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer))
);

CREATE UNIQUE INDEX pending_signups_email_lower_unique ON pending_signups (lower(email));
CREATE UNIQUE INDEX pending_signups_username_lower_unique ON pending_signups (lower(username));
CREATE UNIQUE INDEX pending_signups_token_unique ON pending_signups (token_hash);
CREATE INDEX pending_signups_expires_at_idx ON pending_signups (expires_at);
