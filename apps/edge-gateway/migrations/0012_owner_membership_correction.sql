-- apps/api provisioned some gateway accounts as `member` of their own organisation. The gateway creates the owner, but
-- its organisation already existed, so apps/api joined the owner as a member. Raise each membership to the role the
-- gateway gave that user, so the owner of a personal repository is the owner apps/api bills.
UPDATE organization_members
   SET role = 'owner', updated_at = (cast((julianday('now') - 2440587.5) * 86400000 as integer))
 WHERE role <> 'owner'
   AND EXISTS (
     SELECT 1 FROM users u
      WHERE u.id = organization_members.user_id
        AND u.org_id = organization_members.organization_id
        AND u.role = 'owner'
   );
