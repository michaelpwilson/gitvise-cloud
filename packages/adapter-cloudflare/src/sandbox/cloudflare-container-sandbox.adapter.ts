import {
  GitViseError,
  type BlobRef,
  type BlobStoragePort,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxLease,
  type SandboxLeaseRequest,
  type SandboxPort,
  type SandboxSource,
} from '@gitvise/core';
import type { GitViseSandbox, StoredLease } from './sandbox-container';
import { errorMessage, invalid, upstreamError } from '../shared/errors';
import { isGitCommitHex } from '../shared/bytes';

/** Environment keys a caller may never set. Mirrors the core denylist as a backstop. */
const DENIED_ENV_KEYS: ReadonlySet<string> = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
]);

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;
const MAX_STDIN_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const EXIT_TIMED_OUT = 124;
const EXIT_ABORTED = 130;
const EXPORT_TIMEOUT_MS = 120_000;
const LEASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Resolves a commit to the packfile holding its tree. Implemented by the gateway over D1. */
export interface CommitSnapshotLocator {
  locate(repoId: string, commitHash: string): Promise<BlobRef | undefined>;
}

export interface ContainerSandboxOptions {
  readonly containers: DurableObjectNamespace<GitViseSandbox>;
  /** The one image this deployment runs. Requests for any other image are refused. */
  readonly image: string;
  /** Size of the configured container instance type. Requests above it are refused. */
  readonly capacity: { readonly vcpus: number; readonly memoryMiB: number };
  readonly snapshots: CommitSnapshotLocator;
  readonly blobs: BlobStoragePort;
}

/** A lease that can also feed stdin to a run, and export a commit as a packfile. */
export interface ContainerSandboxLease extends SandboxLease {
  runWithInput(argv: readonly string[], input: string, timeoutMs: number): Promise<SandboxExecResult>;
  /**
   * Returns the full zstd-compressed packfile for `commitHash`, including its whole history. Fails if the commit
   * is not in the lease's repository, and if the pack is larger than `maxBytes`.
   */
  exportPack(commitHash: string, maxBytes: number): Promise<Uint8Array>;
}

/** Shape of `GET /lease` on the Durable Object. */
export interface LeaseDescriptor {
  readonly expiresAtMs: number;
  readonly source: SandboxSource | null;
  readonly hydrated: boolean;
}

/**
 * `SandboxPort` backed by one Cloudflare Container per lease. Each lease is a `GitViseSandbox` Durable
 * Object addressed by a random id, so leases never share a filesystem or a process.
 *
 * Lifecycle: `acquire` boots the container and hydrates the source commit from R2. `run` executes argv
 * inside it, re-hydrating once if the container slept. `release` destroys it. Lease expiry is enforced
 * inside the Durable Object with a scheduled alarm, so a lost caller cannot leak a container.
 */
export class CloudflareContainerSandboxAdapter implements SandboxPort {
  constructor(private readonly options: ContainerSandboxOptions) {}

  async runInSandbox(request: SandboxExecRequest): Promise<SandboxExecResult> {
    this.assertSpec(request.sandbox.image, request.sandbox.vcpus, request.sandbox.memoryMiB);
    this.assertArgv(request.command);
    this.assertEnv(request.env);
    const lease = await this.provision({
      image: request.sandbox.image,
      vcpus: request.sandbox.vcpus,
      memoryMiB: request.sandbox.memoryMiB,
      network: 'none',
      timeoutMs: request.timeoutMs,
      env: request.env,
      source: { repoId: request.repoId, commitHash: request.commitHash },
    });
    try {
      return await lease.execute(request.command, request.timeoutMs, undefined, undefined);
    } finally {
      await lease.release();
    }
  }

  async acquire(request: SandboxLeaseRequest): Promise<ContainerSandboxLease> {
    this.assertSpec(request.image, request.vcpus, request.memoryMiB);
    this.assertEnv(request.env ?? {});
    return this.provision(request);
  }

  /** Re-attaches to a lease created earlier, so a multi-call session can span requests. */
  async attach(leaseId: string): Promise<SandboxLease> {
    const stub = this.stubFor(leaseId);
    const descriptor = await this.describe(stub);
    return new ContainerLease(this, leaseId, stub, descriptor.source ?? undefined);
  }

  private async provision(request: SandboxLeaseRequest): Promise<ContainerLease> {
    const source = request.source;
    if (source !== undefined && !isGitCommitHex(source.commitHash)) {
      throw invalid('source.commitHash must be a git object id');
    }
    const leaseId = crypto.randomUUID();
    const stub = this.stubFor(leaseId);
    const expiresAtMs = Date.now() + request.timeoutMs;

    const configured = await stub.fetch('https://sandbox.internal/lease', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        env: request.env ?? {},
        expiresAtMs,
        ...(source === undefined ? {} : { source }),
      } satisfies Partial<StoredLease>),
    });
    if (!configured.ok) {
      throw upstreamError(`sandbox ${leaseId} failed to start (${configured.status})`, new Error(await configured.text()));
    }

    const lease = new ContainerLease(this, leaseId, stub, source);
    if (source !== undefined) {
      try {
        await this.hydrate(stub, source);
      } catch (error) {
        await lease.release();
        throw error;
      }
    }
    return lease;
  }

  /** Streams the commit's packfile from R2 into the container's repository. */
  async hydrate(stub: DurableObjectStub<GitViseSandbox>, source: SandboxSource): Promise<void> {
    const ref = await this.options.snapshots.locate(source.repoId, source.commitHash);
    if (ref === undefined) {
      throw new GitViseError('NOT_FOUND', `no snapshot for ${source.repoId}@${source.commitHash}`);
    }
    const blob = await this.options.blobs.getBlob(ref);
    if (blob === undefined) {
      throw new GitViseError('NOT_FOUND', `snapshot blob ${ref.sha256} is missing from storage`);
    }
    const response = await stub.fetch('https://sandbox.internal/hydrate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-gitvise-commit': source.commitHash,
        'x-gitvise-encoding': blob.info.encoding,
      },
      body: blob.body,
    });
    if (!response.ok) {
      throw upstreamError(`hydrating ${source.commitHash} failed (${response.status})`, new Error(await response.text()));
    }
  }

  async describe(stub: DurableObjectStub<GitViseSandbox>): Promise<LeaseDescriptor> {
    const response = await stub.fetch('https://sandbox.internal/lease', { method: 'GET' });
    if (response.status === 404) throw new GitViseError('NOT_FOUND', 'sandbox lease not found');
    if (!response.ok) throw upstreamError(`reading sandbox lease failed (${response.status})`);
    return (await response.json()) as LeaseDescriptor;
  }

  /** Exposed to `ContainerLease` so it can reach the Durable Object for re-hydration and runs. */
  stubFor(leaseId: string): DurableObjectStub<GitViseSandbox> {
    if (!LEASE_ID_PATTERN.test(leaseId)) throw invalid('lease id is malformed');
    return this.options.containers.getByName(leaseId);
  }

  private assertSpec(image: string, vcpus: number, memoryMiB: number): void {
    if (image !== this.options.image) {
      throw invalid(`sandbox image ${image} is not deployed here`);
    }
    if (vcpus > this.options.capacity.vcpus || memoryMiB > this.options.capacity.memoryMiB) {
      throw invalid(
        `requested ${vcpus} vCPU / ${memoryMiB} MiB exceeds the configured instance (${this.options.capacity.vcpus} vCPU / ${this.options.capacity.memoryMiB} MiB)`,
      );
    }
  }

  private assertArgv(argv: readonly string[]): void {
    if (argv.length < 1 || argv.length > MAX_ARGS) throw invalid(`argv must have 1-${MAX_ARGS} entries`);
    for (const arg of argv) {
      if (arg.length > MAX_ARG_LENGTH || arg.includes('\0')) {
        throw invalid('argv entry is too long or contains NUL');
      }
    }
  }

  private assertEnv(env: Readonly<Record<string, string>>): void {
    for (const key of Object.keys(env)) {
      if (DENIED_ENV_KEYS.has(key)) throw invalid(`env.${key} cannot be set in a sandbox`);
    }
  }
}

/** One live sandbox. Produced by `acquire`, `attach`, or `runInSandbox`. */
class ContainerLease implements ContainerSandboxLease {
  private releasing: Promise<void> | undefined;

  constructor(
    private readonly adapter: CloudflareContainerSandboxAdapter,
    readonly id: string,
    private readonly stub: DurableObjectStub<GitViseSandbox>,
    private readonly source: SandboxSource | undefined,
  ) {}

  /** A run in a multi-command lease. The lease's own expiry bounds it. */
  async run(argv: readonly string[], signal: AbortSignal): Promise<SandboxExecResult> {
    if (argv.length < 1 || argv.length > MAX_ARGS) throw invalid(`argv must have 1-${MAX_ARGS} entries`);
    return this.execute(argv, MAX_TIMEOUT_MS, signal, undefined);
  }

  /** Runs argv with `input` on stdin. The input is capped at 1 MiB by the agent. */
  async runWithInput(argv: readonly string[], input: string, timeoutMs: number): Promise<SandboxExecResult> {
    if (argv.length < 1 || argv.length > MAX_ARGS) throw invalid(`argv must have 1-${MAX_ARGS} entries`);
    if (new TextEncoder().encode(input).byteLength > MAX_STDIN_BYTES) throw invalid('stdin is larger than 1 MiB');
    return this.execute(argv, timeoutMs, undefined, input);
  }

  async release(): Promise<void> {
    this.releasing ??= this.stub.fetch('https://sandbox.internal/lease', { method: 'DELETE' }).then(
      () => undefined,
      () => undefined,
    );
    return this.releasing;
  }

  async exportPack(commitHash: string, maxBytes: number): Promise<Uint8Array> {
    if (!isGitCommitHex(commitHash)) throw invalid('commitHash must be a git object id');
    const guard = AbortSignal.timeout(EXPORT_TIMEOUT_MS);
    let response = await this.postExport(commitHash, guard);
    if (response.status === 409 && (await isNotHydrated(response))) {
      if (this.source === undefined) {
        throw new GitViseError('INVALID_STATE', 'sandbox lost its workspace and has no source to restore');
      }
      // A re-hydrated workspace holds only the source commit. Commits made earlier in this lease are gone, so the
      // export below fails for them, and the caller must redo the work.
      await this.adapter.hydrate(this.stub, this.source);
      response = await this.postExport(commitHash, guard);
    }
    if (!response.ok) {
      throw upstreamError(`exporting ${commitHash} failed (${response.status})`, new Error(await response.text()));
    }
    return readBounded(response.body, maxBytes);
  }

  private postExport(commitHash: string, signal: AbortSignal): Promise<Response> {
    return this.stub.fetch('https://sandbox.internal/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commit: commitHash }),
      signal,
    });
  }

  /** One-shot execution: the caller's timeout is the wall-clock limit for the run. */
  execute(
    argv: readonly string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    stdin: string | undefined,
  ): Promise<SandboxExecResult> {
    const guard = AbortSignal.timeout(timeoutMs + 5_000);
    const combined = signal === undefined ? guard : AbortSignal.any([guard, signal]);
    return this.runOnce(argv, timeoutMs, combined, stdin);
  }

  private async runOnce(
    argv: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
    stdin: string | undefined,
  ): Promise<SandboxExecResult> {
    const started = Date.now();
    try {
      // Wake-up path. If the container slept, its disk was wiped and the DO answers 409 `not-hydrated`.
      // Re-hydrate from R2 with the lease's own source, then run the same argv again.
      let response = await this.post(argv, timeoutMs, signal, stdin);
      if (response.status === 409 && (await isNotHydrated(response))) {
        if (this.source === undefined) {
          throw new GitViseError('INVALID_STATE', 'sandbox lost its workspace and has no source to restore');
        }
        await this.adapter.hydrate(this.stub, this.source);
        response = await this.post(argv, timeoutMs, signal, stdin);
      }
      if (!response.ok) {
        throw upstreamError(`sandbox run failed (${response.status})`, new Error(await response.text()));
      }
      return (await response.json()) as SandboxExecResult;
    } catch (error) {
      if (signal.aborted) {
        const timedOut = isTimeout(signal.reason);
        return {
          exitCode: timedOut ? EXIT_TIMED_OUT : EXIT_ABORTED,
          stdout: '',
          stderr: errorMessage(signal.reason),
          timedOut,
          durationMs: Date.now() - started,
        };
      }
      throw error instanceof GitViseError ? error : upstreamError('sandbox run failed', error);
    }
  }

  private post(argv: readonly string[], timeoutMs: number, signal: AbortSignal, stdin: string | undefined): Promise<Response> {
    return this.stub.fetch('https://sandbox.internal/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        argv,
        timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(timeoutMs, MAX_TIMEOUT_MS)),
        ...(stdin === undefined ? {} : { stdin }),
      }),
      signal,
    });
  }
}

/** Reads a response body into memory, refusing anything over `maxBytes` before it is fully buffered. */
async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('export too large');
      throw new GitViseError('INVALID_STATE', `packfile exceeds ${maxBytes} bytes`);
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isTimeout(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'TimeoutError';
}

async function isNotHydrated(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return body.error === 'not-hydrated';
  } catch {
    return false;
  }
}
