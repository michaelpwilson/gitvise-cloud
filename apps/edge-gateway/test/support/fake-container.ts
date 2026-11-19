import type { GitViseSandbox } from '@gitvise/adapter-cloudflare';
import type { BlobRef, BlobStoragePort } from '@gitvise/core';

/**
 * Stands in for the container boundary: the `GitViseSandbox` Durable Object and the container behind it.
 * It reproduces the contract the adapter depends on, not the real container:
 *
 *  - `PUT /lease` configures a lease and starts the container.
 *  - `POST /hydrate` materialises the workspace and marks it hydrated.
 *  - `POST /exec` returns 409 `{error:'not-hydrated'}` when the lease has a source but the workspace is
 *    missing or the container is down. Without a source it starts the container and runs.
 *  - `POST /export` returns the packfile bytes the script provides, under the same hydration gate.
 *  - `sleep()` simulates `sleepAfter`: the container stops and its ephemeral disk is wiped.
 *
 * `script` decides what commands return. Without one, every command succeeds with its argv echoed back.
 * `log` records every request, so tests can assert on the order of calls.
 */

export interface FakeLeaseState {
  readonly env: Record<string, string>;
  readonly expiresAtMs: number;
  readonly source?: { readonly repoId: string; readonly commitHash: string } | undefined;
}

export interface FakeExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Scripted behaviour for one test. Returning undefined from `exec` falls back to the default success. */
export interface FakeScript {
  exec?(argv: readonly string[], stdin: string | undefined): FakeExecResult | undefined;
  exportPack?(commitHash: string): Uint8Array | { readonly status: number; readonly error: string };
}

export class FakeContainerInstance {
  lease: FakeLeaseState | undefined;
  running = false;
  hydrated = false;
  hydrations = 0;
  readonly log: string[] = [];

  constructor(
    private readonly blobs: FakeBlobs,
    private readonly script: FakeScript | undefined,
  ) {}

  /** The sleep/wake cycle: the container stops and the workspace disk is gone. */
  sleep(): void {
    this.running = false;
    this.hydrated = false;
    this.log.push('sleep');
  }

  readonly stub = {
    fetch: (input: string, init?: RequestInit): Promise<Response> => this.handle(input, init ?? {}),
  };

  private async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();

    if (url.pathname === '/lease' && method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { env: Record<string, string>; expiresAtMs: number; source?: FakeLeaseState['source'] };
      this.lease = { env: body.env, expiresAtMs: body.expiresAtMs, source: body.source };
      this.running = true;
      this.hydrated = false;
      this.log.push('lease');
      return json({ ok: true });
    }

    if (url.pathname === '/lease' && method === 'GET') {
      if (this.lease === undefined) return json({ error: 'not found' }, 404);
      return json({ expiresAtMs: this.lease.expiresAtMs, source: this.lease.source ?? null, hydrated: this.hydrated });
    }

    if (url.pathname === '/lease' && method === 'DELETE') {
      this.lease = undefined;
      this.running = false;
      this.hydrated = false;
      this.log.push('delete');
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/hydrate' && method === 'POST') {
      const commit = new Headers(init.headers).get('x-gitvise-commit') ?? '';
      const bytes = await new Response(init.body as ReadableStream).text();
      if (bytes.length === 0) return json({ error: 'empty pack' }, 422);
      this.hydrations += 1;
      this.hydrated = true;
      this.running = true;
      this.log.push(`hydrate:${commit.slice(0, 7)}`);
      return json({ ok: true });
    }

    if (url.pathname === '/exec' && method === 'POST') {
      if (this.lease === undefined) return json({ error: 'lease expired' }, 410);
      const body = JSON.parse(String(init.body)) as { argv: string[]; stdin?: string };
      if (this.lease.source !== undefined && (!this.hydrated || !this.running)) {
        this.log.push('exec:409');
        return json({ error: 'not-hydrated' }, 409);
      }
      this.running = true;
      this.log.push(`exec:${body.argv.join(' ')}`);
      const scripted = this.script?.exec?.(body.argv, body.stdin);
      const result = scripted ?? { exitCode: 0, stdout: `ran ${body.argv.join(' ')}`, stderr: '' };
      return json({ ...result, timedOut: false, durationMs: 1 });
    }

    if (url.pathname === '/export' && method === 'POST') {
      if (this.lease === undefined) return json({ error: 'lease expired' }, 410);
      if (this.lease.source !== undefined && (!this.hydrated || !this.running)) {
        this.log.push('export:409');
        return json({ error: 'not-hydrated' }, 409);
      }
      const body = JSON.parse(String(init.body)) as { commit: string };
      this.log.push(`export:${body.commit.slice(0, 7)}`);
      const produced = this.script?.exportPack?.(body.commit) ?? new TextEncoder().encode(`pack:${body.commit}`);
      if (!(produced instanceof Uint8Array)) return json({ error: produced.error }, produced.status);
      return new Response(produced, { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-gitvise-encoding': 'zstd' } });
    }

    return json({ error: `unhandled ${method} ${url.pathname}` }, 500);
  }
}

/** Namespace double. Each name maps to its own instance, like `getByName`. */
export class FakeContainerNamespace {
  private readonly instances_ = new Map<string, FakeContainerInstance>();

  constructor(
    private readonly blobs: FakeBlobs,
    private readonly script?: FakeScript,
  ) {}

  getByName(name: string): unknown {
    return this.instanceFor(name).stub;
  }

  /** Every instance created so far, in creation order. Tests use this to inspect the calls a lease made. */
  instances(): FakeContainerInstance[] {
    return [...this.instances_.values()];
  }

  instanceFor(name: string): FakeContainerInstance {
    let instance = this.instances_.get(name);
    if (instance === undefined) {
      instance = new FakeContainerInstance(this.blobs, this.script);
      this.instances_.set(name, instance);
    }
    return instance;
  }

  /** The adapter types its namespace as the real DO namespace; the double satisfies it at runtime. */
  asNamespace(): DurableObjectNamespace<GitViseSandbox> {
    return this as unknown as DurableObjectNamespace<GitViseSandbox>;
  }
}

/** Minimal R2 double: packs live in a map keyed by sha256. Set `available` to simulate a missing object. */
export class FakeBlobs {
  readonly packs = new Map<string, string>();

  asPort(): BlobStoragePort {
    const port = {
      getBlob: async (ref: BlobRef) => {
        const bytes = this.packs.get(ref.sha256);
        if (bytes === undefined) return undefined;
        return { info: { kind: ref.kind, sha256: ref.sha256, encoding: 'identity', byteLength: bytes.length }, body: new Response(bytes).body };
      },
    };
    return port as unknown as BlobStoragePort;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
