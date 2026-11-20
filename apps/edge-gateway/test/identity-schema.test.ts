import { describe, expect, it } from 'vitest';
import { testEnv, uniqueId } from './support/bindings';

// The migrations in migrations/ are applied before this file runs (see test/support/apply-migrations.ts). These tests
// check that the shared `organizations` and `users` tables serve both the gateway and apps/api, and that the apps/api
// tables the CI migration points at now exist.

const db = testEnv.D1;

/** Milliseconds since the epoch for any date after 2001. Unix seconds are far smaller. */
const MS_FLOOR = 1_000_000_000_000;

describe('shared identity tables (0007_identity_unify, 0008_api_schema)', () => {
  it('lets apps/api provision a user, organisation, repository, and pull request, then a CI repair attempt', async () => {
    const userId = uniqueId('api-user');
    const orgId = uniqueId('api-org');
    const repoId = uniqueId('repo');
    const prId = uniqueId('pr');

    // apps/api users join organisations through organization_members, so a user has no org_id here.
    await db.batch([
      db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?1, ?2, ?3)').bind(orgId, 'Acme', orgId),
      db.prepare('INSERT INTO users (id, username, email) VALUES (?1, ?2, ?3)').bind(userId, `alice-${userId}`, `${userId}@api.test`),
      db.prepare('INSERT INTO repositories (id, owner_id, organization_id, name) VALUES (?1, ?2, ?3, ?4)').bind(repoId, userId, orgId, 'widgets'),
      db
        .prepare('INSERT INTO pull_requests (id, repo_id, author_id, head_branch, base_branch) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(prId, repoId, userId, 'feature', 'main'),
    ]);

    // The foreign key that failed on a fresh database before the API schema was applied.
    await db.prepare('INSERT INTO ci_repair_attempts (pull_request_id, attempts, expires_at) VALUES (?1, 1, 9999999999)').bind(prId).run();
    const row = await db.prepare('SELECT attempts FROM ci_repair_attempts WHERE pull_request_id = ?1').bind(prId).first<{ attempts: number }>();
    expect(row?.attempts).toBe(1);
  });

  it('refuses a second username that differs only by case, as apps/api does', async () => {
    const stem = uniqueId('dup');
    await db.prepare('INSERT INTO users (id, username, email) VALUES (?1, ?2, ?3)').bind(`${stem}-a`, `Carol-${stem}`, `${stem}-a@api.test`).run();
    await expect(
      db.prepare('INSERT INTO users (id, username, email) VALUES (?1, ?2, ?3)').bind(`${stem}-b`, `carol-${stem}`, `${stem}-b@api.test`).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('keeps gateway sign-up working beside apps/api rows, with millisecond timestamps', async () => {
    const orgId = uniqueId('gw-org');
    const userId = uniqueId('gw-user');
    // The gateway's sign-up writes only id, name, org_id, email, role, and password_hash.
    await db.batch([
      db.prepare('INSERT INTO organizations (id, name) VALUES (?1, ?2)').bind(orgId, `${orgId}@gw.test`),
      db
        .prepare("INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?1, ?2, ?3, 'owner', ?4)")
        .bind(userId, orgId, `${userId}@gw.test`, 'pbkdf2-sha256$1$salt$hash'),
    ]);

    // Gateway rows have no username or slug, and NULLs do not collide in the unique indexes.
    const second = uniqueId('gw-user');
    await db
      .prepare("INSERT INTO users (id, org_id, email, role, password_hash) VALUES (?1, ?2, ?3, 'member', ?4)")
      .bind(second, orgId, `${second}@gw.test`, 'h')
      .run();

    const org = await db.prepare('SELECT slug, created_at, updated_at FROM organizations WHERE id = ?1').bind(orgId).first<{
      slug: string | null;
      created_at: number;
      updated_at: number;
    }>();
    expect(org?.slug).toBeNull();
    expect(org?.created_at).toBeGreaterThan(MS_FLOOR);
    expect(org?.updated_at).toBeGreaterThan(MS_FLOOR);

    const user = await db.prepare('SELECT username, org_id, created_at FROM users WHERE id = ?1').bind(userId).first<{
      username: string | null;
      org_id: string | null;
      created_at: number;
    }>();
    expect(user?.username).toBeNull();
    expect(user?.org_id).toBe(orgId);
    expect(user?.created_at).toBeGreaterThan(MS_FLOOR);
  });
});
