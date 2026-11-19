import { Container } from '@cloudflare/containers';

/** Port the in-container agent listens on. Must match `container/agent.mjs` and the Dockerfile. */
export const SANDBOX_AGENT_PORT = 8080;

const LEASE_KEY = 'lease';
const HYDRATED_KEY = 'hydrated';
const EXPIRY_CALLBACK = 'expireLease';
const START_TIMEOUT_MS = 60_000;
const MIN_EXEC_TIMEOUT_MS = 1_000;

/** Lease state kept in Durable Object storage. Env is per lease and never baked into the image. */
export interface StoredLease {
  readonly env: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
  /** Commit to materialise. Re-hydration after a sleep uses it. Absent for a bare lease. */
  readonly source?: { readonly repoId: string; readonly commitHash: string };
}

/**
 * One container per sandbox lease. The Durable Object is the only entry point; the Worker reaches it
 * through the `CONTAINERS` binding and never touches the container's port directly.
 *
 * Control routes (called by `CloudflareContainerSandboxAdapter`):
 *   PUT    /lease     configure env, expiry, and optional source; starts the container
 *   DELETE /lease     destroy the container and clear state
 *   POST   /hydrate   stream a packfile into the container (forwarded to the agent)
 *   POST   /exec      run one argv (forwarded to the agent, limited by lease expiry)
 *   GET    /lease     read the lease descriptor (used to re-attach to an existing lease)
 *
 * The container sleeps after two minutes of inactivity, and sleeping clears the container
 * filesystem. The `hydrated` flag is cleared in `onStop` and checked in `/exec`, so a run against a
 * slept container returns 409 `not-hydrated` instead of silently running on an empty workspace.
 */
export class GitViseSandbox extends Container {
  override defaultPort = SANDBOX_AGENT_PORT;
  override sleepAfter = '2m';
  override enableInternet = false;
  override envVars = {
    PORT: String(SANDBOX_AGENT_PORT),
    GITVISE_WORKSPACE: '/workspace',
    GITVISE_REPO: '/var/gitvise/repo.git',
    GITVISE_NATIVE_ENGINE: '/opt/gitvise/native/git-engine.linux-x64-gnu.node',
  };

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/lease' && request.method === 'PUT') return await this.configureLease(request);
      if (url.pathname === '/lease' && request.method === 'GET') return await this.describeLease();
      if (url.pathname === '/lease' && request.method === 'DELETE') return await this.teardown();
      if (url.pathname === '/hydrate' && request.method === 'POST') return await this.hydrate(request);
      if (url.pathname === '/exec' && request.method === 'POST') return await this.exec(request);
      if (url.pathname === '/export' && request.method === 'POST') return await this.export(request);
      return jsonResponse({ error: 'not found' }, 404);
    } catch (error) {
      return jsonResponse({ error: errorText(error) }, 502);
    }
  }

  /** Runs when the container exits, including after an idle sleep. The filesystem is gone, so clear the flag. */
  override async onStop(): Promise<void> {
    await this.ctx.storage.delete(HYDRATED_KEY);
  }

  /** Scheduled at lease expiry. Destroys the container and all lease state. */
  async expireLease(): Promise<void> {
    await this.destroyLease();
  }

  private async configureLease(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<StoredLease>;
    if (typeof body.expiresAtMs !== 'number' || !Number.isFinite(body.expiresAtMs)) {
      return jsonResponse({ error: 'expiresAtMs is required' }, 400);
    }
    if (body.expiresAtMs - Date.now() < MIN_EXEC_TIMEOUT_MS) {
      return jsonResponse({ error: 'lease expires too soon' }, 400);
    }
    const lease: StoredLease = {
      env: body.env ?? {},
      expiresAtMs: body.expiresAtMs,
      ...(body.source === undefined ? {} : { source: body.source }),
    };
    await this.ctx.storage.put(LEASE_KEY, lease);
    await this.ctx.storage.delete(HYDRATED_KEY);
    this.deleteSchedules(EXPIRY_CALLBACK);
    await this.schedule(new Date(lease.expiresAtMs), EXPIRY_CALLBACK, {});
    await this.ensureRunning();
    return jsonResponse({ started: true }, 201);
  }

  private async describeLease(): Promise<Response> {
    const lease = await this.ctx.storage.get<StoredLease>(LEASE_KEY);
    if (!lease) return jsonResponse({ error: 'no lease' }, 404);
    const hydrated = (await this.ctx.storage.get<boolean>(HYDRATED_KEY)) === true;
    return jsonResponse({ expiresAtMs: lease.expiresAtMs, source: lease.source ?? null, hydrated });
  }

  private async teardown(): Promise<Response> {
    await this.destroyLease();
    return jsonResponse({ released: true });
  }

  private async destroyLease(): Promise<void> {
    this.deleteSchedules(EXPIRY_CALLBACK);
    try {
      await this.destroy();
    } catch {
      // Already stopped. Nothing to destroy.
    }
    await this.ctx.storage.deleteAll();
  }

  private async hydrate(request: Request): Promise<Response> {
    const lease = await this.ctx.storage.get<StoredLease>(LEASE_KEY);
    if (!lease) return jsonResponse({ error: 'no lease' }, 409);
    await this.ensureRunning();

    const headers = new Headers();
    for (const name of ['content-type', 'x-gitvise-commit', 'x-gitvise-encoding']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    this.renewActivityTimeout();
    const forwarded = new Request(`http://container/hydrate`, {
      method: 'POST',
      headers,
      body: request.body,
    });
    const response = await this.containerFetch(forwarded, SANDBOX_AGENT_PORT);
    if (response.ok) {
      await this.ctx.storage.put(HYDRATED_KEY, true);
    }
    return response;
  }

  private async exec(request: Request): Promise<Response> {
    const lease = await this.ctx.storage.get<StoredLease>(LEASE_KEY);
    if (!lease) return jsonResponse({ error: 'no lease' }, 409);

    const remainingMs = lease.expiresAtMs - Date.now();
    if (remainingMs < MIN_EXEC_TIMEOUT_MS) {
      return jsonResponse({ error: 'lease expired' }, 410);
    }

    // A lease with a source needs a hydrated workspace. If the container slept, hand back 409 so the
    // adapter re-hydrates and retries, rather than running against an empty directory.
    const hydrated = (await this.ctx.storage.get<boolean>(HYDRATED_KEY)) === true;
    if (lease.source !== undefined && (!hydrated || this.ctx.container?.running !== true)) {
      return jsonResponse({ error: 'not-hydrated' }, 409);
    }
    await this.ensureRunning();

    const body = (await request.json()) as { argv?: unknown; timeoutMs?: unknown; stdin?: unknown };
    const timeoutMs = Math.min(
      typeof body.timeoutMs === 'number' ? body.timeoutMs : remainingMs,
      remainingMs,
    );
    this.renewActivityTimeout();
    const forwarded = new Request(`http://container/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        argv: body.argv,
        env: lease.env,
        timeoutMs: Math.floor(timeoutMs),
        ...(typeof body.stdin === 'string' ? { stdin: body.stdin } : {}),
      }),
    });
    return this.containerFetch(forwarded, SANDBOX_AGENT_PORT);
  }

  /** Streams a commit's packfile out of the container. Same lease and hydration gate as `exec`. */
  private async export(request: Request): Promise<Response> {
    const gate = await this.leaseGate();
    if (gate instanceof Response) return gate;

    this.renewActivityTimeout();
    const forwarded = new Request('http://container/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await request.text(),
    });
    return this.containerFetch(forwarded, SANDBOX_AGENT_PORT);
  }

  /** Refuses requests against an expired lease, or a workspace that must be re-hydrated first. */
  private async leaseGate(): Promise<StoredLease | Response> {
    const lease = await this.ctx.storage.get<StoredLease>(LEASE_KEY);
    if (!lease) return jsonResponse({ error: 'no lease' }, 409);
    if (lease.expiresAtMs - Date.now() < MIN_EXEC_TIMEOUT_MS) return jsonResponse({ error: 'lease expired' }, 410);
    const hydrated = (await this.ctx.storage.get<boolean>(HYDRATED_KEY)) === true;
    if (lease.source !== undefined && (!hydrated || this.ctx.container?.running !== true)) {
      return jsonResponse({ error: 'not-hydrated' }, 409);
    }
    await this.ensureRunning();
    return lease;
  }

  private async ensureRunning(): Promise<void> {
    if (this.ctx.container?.running === true) return;
    await this.startAndWaitForPorts({
      ports: SANDBOX_AGENT_PORT,
      cancellationOptions: { portReadyTimeoutMS: START_TIMEOUT_MS },
    });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
