import { describe, expect, it } from 'vitest';
import { CloudflareR2BlobStorageAdapter } from '@gitvise/adapter-cloudflare';
import { D1CommitSnapshots, SANDBOX_CAPACITY, SANDBOX_IMAGE } from '../src/composition';
import { sha256Hex } from '../src/crypto';
import type { GatewayEnv } from '../src/env';
import { FakeBlobs, FakeContainerNamespace } from './support/fake-container';
import { httpEnv, testEnv, uniqueId } from './support/bindings';
import { callInternalWith } from './support/internal';

/**
 * `/internal/ports/sandbox` and `/internal/ports/snapshots` as the API calls them: `{ orgId, repoId, commitHash, … }`.
 * A snapshot is stored and found under `orgId:repoId`, the key the swarm commit-patch path uses. The container is a
 * fake (see support/fake-container.ts). The snapshot row and the packfile are real D1 and R2.
 */

const COMMIT = 'c0ffee'.repeat(6) + 'abcd';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Uploads a packfile into R2 under its digest, as the API's blob port does, and returns the digest. */
async function uploadPack(): Promise<string> {
  const pack = new TextEncoder().encode(`pack:${uniqueId('base')}`);
  const sha = await sha256Hex(pack);
  const blobs = new CloudflareR2BlobStorageAdapter(testEnv.R2);
  await blobs.putBlob({ kind: 'packfile', sha256: sha }, streamOf(pack), { byteLength: pack.byteLength, encoding: 'identity' });
  return sha;
}

/** Registers a commit under `orgId:repoId`, the way the swarm commit-patch path does: packfile into R2, row into D1. */
async function seedSnapshot(orgId: string, repoId: string, commitHash: string): Promise<void> {
  const sha = await uploadPack();
  await new D1CommitSnapshots(testEnv.D1).record(`${orgId}:${repoId}`, commitHash, sha);
}

function sandboxSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { image: SANDBOX_IMAGE, vcpus: 1, memoryMiB: 1024, network: 'none', ...overrides };
}

function execPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sandbox: sandboxSpec(),
    orgId: uniqueId('org'),
    repoId: uniqueId('repo'),
    commitHash: COMMIT,
    command: ['tsc', '--noEmit'],
    timeoutMs: 60_000,
    env: {},
    ...overrides,
  };
}

function containersEnv(): { env: GatewayEnv; containers: FakeContainerNamespace } {
  const containers = new FakeContainerNamespace(new FakeBlobs());
  const env = httpEnv({ CONTAINERS: containers.asNamespace() as unknown as GatewayEnv['CONTAINERS'] });
  return { env, containers };
}

describe('/internal/ports/sandbox exec with orgId + repoId + commitHash', () => {
  it('hydrates the snapshot registered under orgId:repoId from R2 before the first command runs', async () => {
    const orgId = uniqueId('org');
    const repoId = uniqueId('repo');
    await seedSnapshot(orgId, repoId, COMMIT);
    const { env, containers } = containersEnv();

    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ orgId, repoId, commitHash: COMMIT }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ exitCode: 0, timedOut: false });
    const [instance] = containers.instances();
    // Hydrate must come before exec, and the lease is released last.
    expect(instance?.log).toEqual(['lease', `hydrate:${COMMIT.slice(0, 7)}`, 'exec:tsc --noEmit', 'delete']);
  });

  it('refuses a commit with no snapshot under this org, and runs no command against it', async () => {
    const { env, containers } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ commitHash: 'd'.repeat(40) }),
    });
    expect(response.status).toBe(404);
    // The lease is released on failure, and nothing is hydrated or executed.
    const log = containers.instances().flatMap((instance) => instance.log);
    expect(log.some((entry) => entry.startsWith('hydrate') || entry.startsWith('exec'))).toBe(false);
    expect(log.at(-1)).toBe('delete');
  });

  it('does not hydrate another org’s snapshot, even when the repoId and commit match', async () => {
    const owner = uniqueId('org-owner');
    const stranger = uniqueId('org-stranger');
    const repoId = uniqueId('repo');
    await seedSnapshot(owner, repoId, COMMIT);
    const { env, containers } = containersEnv();

    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ orgId: stranger, repoId, commitHash: COMMIT }),
    });

    expect(response.status).toBe(404);
    expect(containers.instances().flatMap((instance) => instance.log).some((entry) => entry.startsWith('hydrate'))).toBe(false);
  });

  it('refuses a request with no orgId, with 400, because the snapshot cannot be found without it', async () => {
    const { env } = containersEnv();
    const payload = execPayload();
    delete payload['orgId'];
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', { env, payload });
    expect(response.status).toBe(400);
  });

  it('refuses an orgId or repoId containing a colon, with 400, so the key cannot be ambiguous', async () => {
    const { env } = containersEnv();
    const colonOrg = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ orgId: 'org:evil' }),
    });
    const colonRepo = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ repoId: 'repo:evil' }),
    });
    expect(colonOrg.status).toBe(400);
    expect(colonRepo.status).toBe(400);
  });

  it('refuses a commitHash that is a ref name rather than a git object id, with 400', async () => {
    const { env } = containersEnv();
    for (const commitHash of ['main', 'G'.repeat(40), 'a'.repeat(41)]) {
      const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', { env, payload: execPayload({ commitHash }) });
      expect(response.status, commitHash).toBe(400);
    }
  });

  it('refuses a request with no repoId, with 400', async () => {
    const { env } = containersEnv();
    const payload = execPayload();
    delete payload['repoId'];
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', { env, payload });
    expect(response.status).toBe(400);
  });

  it('refuses a request with no sandbox spec, with 400 rather than a server error', async () => {
    const { env } = containersEnv();
    const payload = execPayload();
    delete payload['sandbox'];
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', { env, payload });
    expect(response.status).toBe(400);
  });

  it('refuses an image name this deployment does not build', async () => {
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ sandbox: sandboxSpec({ image: 'gitvise-sandbox' }) }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a spec above the configured instance size, with 400', async () => {
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ sandbox: sandboxSpec({ vcpus: SANDBOX_CAPACITY.vcpus + 1 }) }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a non-string env value, with 400', async () => {
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ env: { CI: 1 } }),
    });
    expect(response.status).toBe(400);
  });
});

describe('/internal/ports/sandbox leases with a source', () => {
  it('hydrates a leased sandbox from its orgId:repoId snapshot on acquire, before the first run', async () => {
    const orgId = uniqueId('org');
    const repoId = uniqueId('repo');
    await seedSnapshot(orgId, repoId, COMMIT);
    const { env, containers } = containersEnv();

    const leased = await callInternalWith('POST', '/internal/ports/sandbox/leases', {
      env,
      payload: { ...sandboxSpec(), timeoutMs: 60_000, env: {}, source: { orgId, repoId, commitHash: COMMIT } },
    });
    expect(leased.status).toBe(201);
    const { leaseId } = (await leased.json()) as { leaseId: string };

    const ran = await callInternalWith('POST', `/internal/ports/sandbox/leases/${leaseId}/run`, {
      env,
      payload: { argv: ['tsc', '--noEmit'] },
    });
    expect(ran.status).toBe(200);
    expect(containers.instanceFor(leaseId).log).toEqual(['lease', `hydrate:${COMMIT.slice(0, 7)}`, 'exec:tsc --noEmit']);
  });

  it('refuses a lease source with no orgId, with 400', async () => {
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/sandbox/leases', {
      env,
      payload: { ...sandboxSpec(), timeoutMs: 60_000, env: {}, source: { repoId: 'repo', commitHash: COMMIT } },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a lease source whose commitHash is not a git object id, with 400', async () => {
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/sandbox/leases', {
      env,
      payload: { ...sandboxSpec(), timeoutMs: 60_000, env: {}, source: { orgId: uniqueId('org'), repoId: 'repo', commitHash: 'main' } },
    });
    expect(response.status).toBe(400);
  });
});

describe('/internal/ports/snapshots', () => {
  it('records a commit under orgId:repoId, the key the swarm commit-patch path uses, so a sandbox can hydrate it', async () => {
    const orgId = uniqueId('org');
    const repoId = uniqueId('repo');
    const sha = await uploadPack();
    const { env, containers } = containersEnv();

    const recorded = await callInternalWith('POST', '/internal/ports/snapshots', {
      env,
      payload: { orgId, repoId, commitHash: COMMIT, sha256: sha },
    });
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toEqual({ outcome: 'created' });

    const snapshots = new D1CommitSnapshots(testEnv.D1);
    expect(await snapshots.locate(`${orgId}:${repoId}`, COMMIT)).toEqual({ kind: 'packfile', sha256: sha });
    expect(await snapshots.locate(repoId, COMMIT)).toBeUndefined();

    // The API's agent flow: it registers the commit, then the verifier runs on that commit.
    const response = await callInternalWith('POST', '/internal/ports/sandbox/exec', {
      env,
      payload: execPayload({ orgId, repoId, commitHash: COMMIT }),
    });
    expect(response.status).toBe(200);
    expect(containers.instances().flatMap((instance) => instance.log)).toContain(`hydrate:${COMMIT.slice(0, 7)}`);
  });

  it('answers 200 when the same commit is recorded again against the same packfile', async () => {
    const orgId = uniqueId('org');
    const repoId = uniqueId('repo');
    const sha = await uploadPack();
    const { env } = containersEnv();
    const payload = { orgId, repoId, commitHash: COMMIT, sha256: sha };
    expect((await callInternalWith('POST', '/internal/ports/snapshots', { env, payload })).status).toBe(201);
    const again = await callInternalWith('POST', '/internal/ports/snapshots', { env, payload });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ outcome: 'unchanged' });
  });

  it('refuses a snapshot whose packfile has not been uploaded, with 404 and no index row', async () => {
    const orgId = uniqueId('org');
    const repoId = uniqueId('repo');
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/snapshots', {
      env,
      payload: { orgId, repoId, commitHash: COMMIT, sha256: 'e'.repeat(64) },
    });
    expect(response.status).toBe(404);
    expect(await new D1CommitSnapshots(testEnv.D1).locate(`${orgId}:${repoId}`, COMMIT)).toBeUndefined();
  });

  it('refuses a snapshot with no orgId, with 400, so it cannot land in an unscoped key', async () => {
    const sha = await uploadPack();
    const { env } = containersEnv();
    const response = await callInternalWith('POST', '/internal/ports/snapshots', {
      env,
      payload: { repoId: uniqueId('repo'), commitHash: COMMIT, sha256: sha },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a malformed commitHash or digest, with 400', async () => {
    const { env } = containersEnv();
    const badCommit = await callInternalWith('POST', '/internal/ports/snapshots', {
      env,
      payload: { orgId: uniqueId('org'), repoId: 'repo', commitHash: 'HEAD', sha256: 'e'.repeat(64) },
    });
    const badDigest = await callInternalWith('POST', '/internal/ports/snapshots', {
      env,
      payload: { orgId: uniqueId('org'), repoId: 'repo', commitHash: COMMIT, sha256: 'not-a-digest' },
    });
    expect(badCommit.status).toBe(400);
    expect(badDigest.status).toBe(400);
  });
});
