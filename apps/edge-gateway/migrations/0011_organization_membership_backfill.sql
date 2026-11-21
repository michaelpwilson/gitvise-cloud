-- Gateway accounts were created without an organization_members row, so apps/api could not find the owner of their
-- personal repositories and refused every cloud chat with "require an organization workspace". This gives each
-- existing gateway user the membership apps/api reads, with the role the user already has. INSERT OR IGNORE keeps it
-- idempotent: users that already have a membership are left as they are.
INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at, updated_at)
SELECT org_id, id, role, created_at, updated_at
FROM users
WHERE org_id IS NOT NULL;
