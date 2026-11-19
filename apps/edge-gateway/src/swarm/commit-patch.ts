import type { BlobStoragePort, SandboxLeaseRequest } from '@gitvise/core';
import { NonRetryableTaskError, type ContainerSandboxLease } from '@gitvise/adapter-cloudflare';
import { sha256Hex } from '../crypto';

/**
 * Applies a patch to a commit inside a sandbox, commits the result, and persists the new commit. Persisting means
 * a packfile in R2 and a snapshot row in D1 with the new commit and its parent. Later sandboxes hydrate from that
 * snapshot, so the change survives the container.
 *
 * Git runs with explicit `--git-dir` and `--work-tree` flags, because the agent's workspace is a checkout of the
 * bare repository and has no `.git` of its own. The paths below are the ones the agent is started with.
 */

export const CONTAINER_REPO = '/var/gitvise/repo.git';
export const CONTAINER_WORKTREE = '/workspace';
/** Largest packfile accepted from a sandbox. Matches the export cap in the agent. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

const COMMAND_TIMEOUT_MS = 60_000;
const LEASE_TIMEOUT_MS = 180_000;
const COMMIT_AUTHOR = ['-c', 'user.name=GitVise Agent', '-c', 'user.email=agent@gitvise.invalid'];

export interface PatchCommitDeps {
  readonly sandbox: { acquire(request: SandboxLeaseRequest): Promise<ContainerSandboxLease> };
  readonly blobs: BlobStoragePort;
  readonly snapshots: {
    record(repoId: string, commitHash: string, sha256: string, parentHash: string | null): Promise<'created' | 'unchanged'>;
  };
  /** Sandbox image and size, passed in so this module stays independent of the composition root. */
  readonly sandboxImage: string;
  readonly sandboxVcpus: number;
  readonly sandboxMemoryMiB: number;
}

export interface PatchCommitInput {
  readonly repoId: string;
  readonly commitHash: string;
  readonly patch: string;
  /** Short label for the commit message. */
  readonly label: string;
}

export interface PatchCommitOutcome {
  readonly commitHash: string;
  readonly parentHash: string;
  readonly packSha256: string;
  readonly packBytes: number;
  readonly snapshot: 'created' | 'unchanged';
}

export async function commitPatch(deps: PatchCommitDeps, input: PatchCommitInput): Promise<PatchCommitOutcome> {
  const lease = await deps.sandbox.acquire({
    image: deps.sandboxImage,
    vcpus: deps.sandboxVcpus,
    memoryMiB: deps.sandboxMemoryMiB,
    network: 'none',
    timeoutMs: LEASE_TIMEOUT_MS,
    env: {},
    source: { repoId: input.repoId, commitHash: input.commitHash },
  });
  try {
    // Check first. A patch that does not apply is a permanent failure, so the consumer must not retry it.
    const check = await lease.runWithInput(['git', 'apply', '--check', '--whitespace=nowarn'], input.patch, COMMAND_TIMEOUT_MS);
    if (check.exitCode !== 0) {
      throw new NonRetryableTaskError(`patch does not apply to ${input.commitHash}: ${check.stderr.slice(0, 500)}`);
    }

    await mustSucceed(
      lease.runWithInput(gitArgs('apply', '--whitespace=nowarn'), input.patch, COMMAND_TIMEOUT_MS),
      'git apply',
    );
    await mustSucceed(lease.runWithInput(gitArgs('add', '-A'), '', COMMAND_TIMEOUT_MS), 'git add');
    await mustSucceed(
      lease.runWithInput(
        ['git', '--git-dir', CONTAINER_REPO, '--work-tree', CONTAINER_WORKTREE, ...COMMIT_AUTHOR, 'commit', '--quiet', '--no-verify', '-m', `GitVise: ${input.label}`],
        '',
        COMMAND_TIMEOUT_MS,
      ),
      'git commit',
    );

    // One call gives both the new commit and its parent. The parent must be the commit we started from, which
    // proves the commit sits directly on the snapshot and not on something else.
    const revList = await mustSucceed(
      lease.runWithInput(['git', '--git-dir', CONTAINER_REPO, 'rev-list', '--parents', '-n', '1', 'HEAD'], '', COMMAND_TIMEOUT_MS),
      'git rev-list',
    );
    const [commitHash, parentHash] = revList.stdout.trim().split(' ');
    if (commitHash === undefined || parentHash !== input.commitHash) {
      throw new NonRetryableTaskError(`committed HEAD does not descend from ${input.commitHash}`);
    }

    // The export contains the full history of the new commit. A snapshot is self-contained, so a later sandbox can
    // hydrate from it alone.
    const pack = await lease.exportPack(commitHash, MAX_PACK_BYTES);
    const packSha256 = await sha256Hex(pack);

    await deps.blobs.putBlob({ kind: 'packfile', sha256: packSha256 }, singleChunk(pack), {
      byteLength: pack.byteLength,
      encoding: 'zstd',
    });
    const snapshot = await deps.snapshots.record(input.repoId, commitHash, packSha256, parentHash);

    return { commitHash, parentHash, packSha256, packBytes: pack.byteLength, snapshot };
  } finally {
    await lease.release().catch(() => undefined);
  }
}

function gitArgs(...args: string[]): string[] {
  return ['git', '--git-dir', CONTAINER_REPO, '--work-tree', CONTAINER_WORKTREE, ...args];
}

async function mustSucceed(pending: Promise<{ exitCode: number; stdout: string; stderr: string }>, step: string) {
  const result = await pending;
  if (result.exitCode !== 0) {
    throw new NonRetryableTaskError(`${step} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
  }
  return result;
}

function singleChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
