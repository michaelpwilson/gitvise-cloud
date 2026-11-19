import { describe, expect, it } from 'vitest';
import {
  CloudflareContainerSandboxAdapter,
  CloudflareR2BlobStorageAdapter,
  NonRetryableTaskError,
  type SwarmTaskMessage,
} from '@gitvise/adapter-cloudflare';
import { createBaselineHandlers, type HandlerServices } from '../src/swarm/handlers';
import { D1CommitSnapshots, SANDBOX_CAPACITY, SANDBOX_IMAGE } from '../src/composition';
import { sha256Hex } from '../src/crypto';
import { FakeBlobs, FakeContainerNamespace, type FakeScript } from './support/fake-container';
import { testEnv, uniqueId } from './support/bindings';

/**
 * Drives the real `commit-patch` handler against real R2 and D1. Only the container boundary is faked: the fake
 * answers each git command from a script, and returns the packfile bytes it is told to.
 */

const BASE = 'ab'.repeat(20);
const NEW = 'cd'.repeat(20);
const OTHER = 'ef'.repeat(20);
const PATCH = 'diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new\n';

function harness(script: FakeScript) {
  const fake = new FakeContainerNamespace(new FakeBlobs(), script);
  const blobs = new CloudflareR2BlobStorageAdapter(testEnv.R2);
  const snapshots = new D1CommitSnapshots(testEnv.D1);
  const sandbox = new CloudflareContainerSandboxAdapter({
    containers: fake.asNamespace(),
    image: SANDBOX_IMAGE,
    capacity: SANDBOX_CAPACITY,
    snapshots,
    blobs,
  });
  // The commit-patch path uses only sandbox, blobs, and snapshots. The rest are unused here, so they are left out.
  const services = { sandbox, blobs, snapshots } as unknown as HandlerServices;
  return { fake, blobs, snapshots, handler: createBaselineHandlers(services)['commit-patch']! };
}

/** Git answers for a commit that applies cleanly and sits on BASE. */
function cleanCommit(overrides: { readonly applyCheck?: number; readonly parent?: string } = {}): FakeScript {
  return {
    exec(argv) {
      if (argv.includes('--check')) return { exitCode: overrides.applyCheck ?? 0, stdout: '', stderr: 'patch failed' };
      if (argv.includes('rev-list')) return { exitCode: 0, stdout: `${NEW} ${overrides.parent ?? BASE}\n`, stderr: '' };
      return undefined;
    },
    exportPack: (commit) => new TextEncoder().encode(`zstd-pack:${commit}`),
  };
}

/** Writes a base snapshot the way an upload plus snapshot record would: pack into R2, index row into D1. */
async function seedSnapshot(blobs: CloudflareR2BlobStorageAdapter, scopedRepo: string, commit: string): Promise<void> {
  const pack = new TextEncoder().encode(`base-pack:${uniqueId('base')}`);
  const sha = await sha256Hex(pack);
  await blobs.putBlob({ kind: 'packfile', sha256: sha }, streamOf(pack), { byteLength: pack.byteLength, encoding: 'identity' });
  await new D1CommitSnapshots(testEnv.D1).record(scopedRepo, commit, sha);
}

function task(scopedRepo: string, commitHash = BASE): SwarmTaskMessage {
  return {
    flowId: `${scopedRepo.split(':')[0]}:flow-${crypto.randomUUID().slice(0, 8)}`,
    taskId: 'apply',
    queue: 'commit-patch',
    input: { orgId: scopedRepo.split(':')[0] ?? '', repoId: scopedRepo, commitHash, patch: PATCH },
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('commit-patch persistence', () => {
  it('applies the patch, commits it, stores the packfile in R2, and records the snapshot with its parent in D1', async () => {
    const orgId = uniqueId('org');
    const repo = `${orgId}:app`;
    const { fake, blobs, handler } = harness(cleanCommit());
    await seedSnapshot(blobs, repo, BASE);

    const result = (await handler(task(repo))) as {
      applies: boolean;
      persisted: boolean;
      commitHash: string;
      parentHash: string;
      packSha256: string;
      snapshot: string;
    };
    expect(result).toMatchObject({ applies: true, persisted: true, commitHash: NEW, parentHash: BASE, snapshot: 'created' });

    // The pack in R2 is the zstd export of the new commit, stored under its own digest.
    const expectedPack = new TextEncoder().encode(`zstd-pack:${NEW}`);
    expect(result.packSha256).toBe(await sha256Hex(expectedPack));
    const stored = await testEnv.R2.head(`packfile/${result.packSha256}`);
    expect(stored).not.toBeNull();
    expect(stored?.customMetadata).toMatchObject({ kind: 'packfile', encoding: 'zstd', byteLength: String(expectedPack.byteLength) });

    // The snapshot row links the new commit to the base it was built on, so later sandboxes can hydrate from it.
    const row = await testEnv.D1.prepare('SELECT blob_sha256, parent_hash FROM commit_snapshots WHERE repo_id = ?1 AND commit_hash = ?2')
      .bind(repo, NEW)
      .first<{ blob_sha256: string; parent_hash: string }>();
    expect(row).toEqual({ blob_sha256: result.packSha256, parent_hash: BASE });

    // The git steps ran in order, and the lease was released.
    const [instance] = fake.instances();
    const log = instance?.log ?? [];
    expect(log).toContain(`hydrate:${BASE.slice(0, 7)}`);
    const check = log.findIndex((entry) => entry.includes('apply --check'));
    const apply = log.findIndex((entry) => entry.includes('git --git-dir /var/gitvise/repo.git --work-tree /workspace apply'));
    const commit = log.findIndex((entry) => entry.includes(' commit --quiet --no-verify'));
    const exported = log.findIndex((entry) => entry.startsWith('export:'));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(apply);
    expect(apply).toBeLessThan(commit);
    expect(commit).toBeLessThan(exported);
    expect(log.at(-1)).toBe('delete');
  });

  it('stores the commit identity on the commit itself, not from the container environment', async () => {
    const orgId = uniqueId('org');
    const repo = `${orgId}:app`;
    const { fake, blobs, handler } = harness(cleanCommit());
    await seedSnapshot(blobs, repo, BASE);
    await handler(task(repo));

    const commands = fake.instances().flatMap((instance) => instance.log);
    const commit = commands.find((entry) => entry.includes(' commit --quiet'));
    expect(commit).toContain('user.name=GitVise Agent');
    expect(commit).toContain('user.email=agent@gitvise.invalid');
  });

  it('refuses a patch that does not apply, and persists nothing', async () => {
    const orgId = uniqueId('org');
    const repo = `${orgId}:app`;
    const { fake, blobs, handler } = harness(cleanCommit({ applyCheck: 1 }));
    await seedSnapshot(blobs, repo, BASE);

    await expect(handler(task(repo))).rejects.toBeInstanceOf(NonRetryableTaskError);
    // The check failed, so the commit was never made and no pack was exported. R2 is shared across tests, so the
    // export log is the reliable signal here, and the D1 row is scoped to this test's repo.
    const log = fake.instances().flatMap((instance) => instance.log);
    expect(log.some((entry) => entry.startsWith('export:'))).toBe(false);
    expect(log.some((entry) => entry.includes(' commit --quiet'))).toBe(false);
    expect(await testEnv.D1.prepare('SELECT 1 AS found FROM commit_snapshots WHERE repo_id = ?1 AND commit_hash = ?2').bind(repo, NEW).first()).toBeNull();
  });

  it('refuses a commit that does not sit directly on the snapshot, and persists nothing', async () => {
    const orgId = uniqueId('org');
    const repo = `${orgId}:app`;
    const { blobs, handler } = harness(cleanCommit({ parent: OTHER }));
    await seedSnapshot(blobs, repo, BASE);

    await expect(handler(task(repo))).rejects.toThrow(/does not descend/);
    expect(await testEnv.D1.prepare('SELECT 1 AS found FROM commit_snapshots WHERE repo_id = ?1 AND commit_hash = ?2').bind(repo, NEW).first()).toBeNull();
  });

  it('cannot hydrate another org’s snapshot, even when the repo name matches', async () => {
    const owner = uniqueId('org');
    const intruder = uniqueId('org');
    const { blobs, handler } = harness(cleanCommit());
    await seedSnapshot(blobs, `${owner}:app`, BASE);

    await expect(handler(task(`${intruder}:app`))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
