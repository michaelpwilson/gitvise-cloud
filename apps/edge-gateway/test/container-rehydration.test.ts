import { beforeEach, describe, expect, it } from 'vitest';
import { CloudflareContainerSandboxAdapter, type CommitSnapshotLocator } from '@gitvise/adapter-cloudflare';
import { GitViseError, type BlobRef } from '@gitvise/core';
import { FakeBlobs, FakeContainerNamespace } from './support/fake-container';

const REPO = 'repo-demo';
const COMMIT = 'a'.repeat(40);
const PACK_SHA = 'b'.repeat(64);
const SANDBOX = {
  image: 'gitvise-sandbox',
  vcpus: 1,
  memoryMiB: 1024,
  network: 'none' as const,
  timeoutMs: 600_000,
};

/**
 * Re-hydration after container sleep, tested at the adapter boundary. The container is a fake that follows the
 * Durable Object contract (see support/fake-container.ts), so these tests cover the adapter's decisions. The DO
 * itself needs the real container runtime and runs in a separate integration environment.
 */
describe('container lease sleep/wake re-hydration', () => {
  let blobs: FakeBlobs;
  let containers: FakeContainerNamespace;
  let snapshots: Map<string, BlobRef>;
  let sandbox: CloudflareContainerSandboxAdapter;
  const signal = (): AbortSignal => new AbortController().signal;

  beforeEach(() => {
    blobs = new FakeBlobs();
    blobs.packs.set(PACK_SHA, 'PACK-BYTES');
    containers = new FakeContainerNamespace(blobs);
    snapshots = new Map([[`${REPO}@${COMMIT}`, { kind: 'packfile', sha256: PACK_SHA }]]);
    const locator: CommitSnapshotLocator = {
      locate: async (repoId, commitHash) => snapshots.get(`${repoId}@${commitHash}`),
    };
    sandbox = new CloudflareContainerSandboxAdapter({
      containers: containers.asNamespace(),
      image: SANDBOX.image,
      capacity: { vcpus: 1, memoryMiB: 6144 },
      snapshots: locator,
      blobs: blobs.asPort(),
    });
  });

  it('hydrates from R2 on lease start and runs the command', async () => {
    const lease = await sandbox.acquire({ ...SANDBOX, source: { repoId: REPO, commitHash: COMMIT } });
    const instance = containers.instanceFor(lease.id);

    const result = await lease.run(['git', 'status'], signal());

    expect(result.exitCode).toBe(0);
    expect(instance.log).toEqual(['lease', 'hydrate:aaaaaaa', 'exec:git status']);
  });

  it('re-hydrates from R2 after sleep wipes the workspace, then runs the next command', async () => {
    const lease = await sandbox.acquire({ ...SANDBOX, source: { repoId: REPO, commitHash: COMMIT } });
    const instance = containers.instanceFor(lease.id);
    await lease.run(['git', 'status'], signal());

    instance.sleep();
    const afterWake = await lease.run(['git', 'log', '-1'], signal());

    // The first attempt hits 409 not-hydrated, the adapter restores the workspace from the lease's source, and
    // the same command runs. The caller sees one successful result.
    expect(afterWake.exitCode).toBe(0);
    expect(afterWake.stdout).toBe('ran git log -1');
    expect(instance.hydrations).toBe(2);
    expect(instance.log).toEqual([
      'lease',
      'hydrate:aaaaaaa',
      'exec:git status',
      'sleep',
      'exec:409',
      'hydrate:aaaaaaa',
      'exec:git log -1',
    ]);
  });

  it('re-hydrates on every wake, not only the first', async () => {
    const lease = await sandbox.acquire({ ...SANDBOX, source: { repoId: REPO, commitHash: COMMIT } });
    const instance = containers.instanceFor(lease.id);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      instance.sleep();
      const result = await lease.run(['git', 'rev-parse', 'HEAD'], signal());
      expect(result.exitCode).toBe(0);
    }
    expect(instance.hydrations).toBe(4);
  });

  it('does not hydrate a lease that has no source, because it has no workspace to restore', async () => {
    const lease = await sandbox.acquire({ ...SANDBOX });
    const instance = containers.instanceFor(lease.id);

    instance.sleep();
    const result = await lease.run(['echo', 'hi'], signal());

    expect(result.exitCode).toBe(0);
    expect(instance.hydrations).toBe(0);
    expect(instance.log).toEqual(['lease', 'sleep', 'exec:echo hi']);
  });

  it('fails loudly when the workspace is gone and the snapshot blob has been removed from R2', async () => {
    const lease = await sandbox.acquire({ ...SANDBOX, source: { repoId: REPO, commitHash: COMMIT } });
    const instance = containers.instanceFor(lease.id);

    instance.sleep();
    blobs.packs.delete(PACK_SHA);

    const attempt = lease.run(['git', 'status'], signal());
    await expect(attempt).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(instance.hydrations).toBe(1);
  });

  it('refuses to acquire a lease for a commit that has no snapshot, and tears the container down', async () => {
    const lease = sandbox.acquire({ ...SANDBOX, source: { repoId: REPO, commitHash: 'c'.repeat(40) } });

    await expect(lease).rejects.toBeInstanceOf(GitViseError);
    await expect(lease).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The failed provision released its container, so nothing is left running with no workspace.
    expect(containers.instances().at(-1)?.log).toEqual(['lease', 'delete']);
  });

  it('is idempotent on release', async () => {
    const lease = await sandbox.acquire({ ...SANDBOX, source: { repoId: REPO, commitHash: COMMIT } });
    const instance = containers.instanceFor(lease.id);

    await lease.release();
    await lease.release();

    expect(instance.log.filter((entry) => entry === 'delete')).toHaveLength(1);
  });
});
