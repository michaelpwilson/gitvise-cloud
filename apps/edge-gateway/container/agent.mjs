// GitVise sandbox agent. Runs inside the sandbox container as the only long-lived process.
//
// Routes (called only by GitViseSandbox, the Durable Object in front of this container):
//   GET  /health    liveness plus whether the git-engine addon loaded
//   POST /hydrate   stream a packfile (optionally zstd-compressed) into the bare repo, then check out the commit
//   POST /exec      run one argv in /workspace with a stripped environment and a hard timeout
//   POST /export    stream a zstd packfile of one commit's history out of the bare repo (size-capped)
//
// The agent never runs through a shell. Child processes get an explicit environment built from BASE_ENV
// plus the lease env, with the loader and runtime override variables removed.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants } from 'node:os';

const PORT = Number(process.env.PORT ?? 8080);
const WORKSPACE = process.env.GITVISE_WORKSPACE ?? '/workspace';
const REPO = process.env.GITVISE_REPO ?? '/var/gitvise/repo.git';
const NATIVE_ENGINE = process.env.GITVISE_NATIVE_ENGINE ?? '';

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_VALUE_LENGTH = 4_096;
const MAX_BODY_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 600_000;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const DENIED_ENV = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
]);

const BASE_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
});

/** Loads the git-engine addon once at boot. A failure is reported by /health, not a crash. */
let nativeEngineLoaded = false;
let nativeEngineError = null;
if (NATIVE_ENGINE !== '') {
  try {
    createRequire(import.meta.url)(NATIVE_ENGINE);
    nativeEngineLoaded = true;
  } catch (error) {
    nativeEngineError = error instanceof Error ? error.message : String(error);
  }
}

await ensureRepo();

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, nativeEngine: nativeEngineLoaded, nativeEngineError });
    }
    if (req.method === 'POST' && req.url === '/hydrate') {
      return await hydrate(req, res);
    }
    if (req.method === 'POST' && req.url === '/exec') {
      return await exec(req, res);
    }
    if (req.method === 'POST' && req.url === '/export') {
      return await exportPack(req, res);
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`gitvise sandbox agent listening on ${PORT}`);
});

async function ensureRepo() {
  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(REPO.replace(/\/[^/]+$/, ''), { recursive: true });
  try {
    await access(`${REPO}/HEAD`, constants.F_OK);
  } catch {
    await runGit(['init', '--bare', '--quiet', REPO]);
  }
}

/**
 * Receives a packfile in the request body. For `zstd` it decompresses first. The pack goes through
 * `index-pack --stdin`, and then the commit is checked out into the workspace.
 */
async function hydrate(req, res) {
  const commit = req.headers['x-gitvise-commit'];
  const encoding = req.headers['x-gitvise-encoding'] ?? 'identity';
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    return json(res, 400, { error: 'x-gitvise-commit must be a git object id' });
  }
  if (encoding !== 'identity' && encoding !== 'zstd') {
    return json(res, 400, { error: 'x-gitvise-encoding must be identity or zstd' });
  }

  const indexer = spawn('git', ['--git-dir', REPO, 'index-pack', '--stdin', '--fix-thin'], {
    env: childEnv({}),
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  // index-pack can exit before it reads its whole input. The resulting EPIPE is expected, and the
  // exit code below is the authoritative result, so the stream error is swallowed here.
  indexer.stdin.on('error', () => {});
  const stderr = collectStderr(indexer);
  const indexed = exitCode(indexer);

  let decoder = null;
  if (encoding === 'zstd') {
    decoder = spawn('zstd', ['-dc', '-q'], { stdio: ['pipe', 'pipe', 'ignore'] });
    decoder.stdin.on('error', () => {});
    decoder.stdout.on('error', () => {});
    decoder.stdout.pipe(indexer.stdin);
    req.pipe(decoder.stdin);
  } else {
    req.pipe(indexer.stdin);
  }

  const status = await indexed;
  if (status !== 0) {
    // Stop the decoder too. Otherwise it blocks on a pipe with no reader.
    decoder?.kill('SIGKILL');
    req.resume();
    return json(res, 422, { error: 'index-pack rejected the packfile', detail: stderr() });
  }

  const checkout = await runGit(
    ['--git-dir', REPO, '--work-tree', WORKSPACE, 'checkout', '--force', '--quiet', commit],
    { timeoutMs: TIMEOUT_MAX_MS },
  );
  if (checkout.exitCode !== 0) {
    return json(res, 422, { error: 'checkout failed', detail: checkout.stderr });
  }
  return json(res, 200, { commit });
}

/** Runs one argv. Validation mirrors the core sandbox limits, so a bad request fails before any process starts. */
async function exec(req, res) {
  const body = JSON.parse(await readBody(req));
  const { argv, env = {}, timeoutMs, stdin } = body;

  if (stdin !== undefined && (typeof stdin !== 'string' || Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES)) {
    return json(res, 400, { error: 'stdin must be a string of at most 1 MiB' });
  }
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGS) {
    return json(res, 400, { error: `argv must have 1-${MAX_ARGS} entries` });
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\0')) {
      return json(res, 400, { error: 'argv entries must be strings without NUL, up to 4096 characters' });
    }
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    return json(res, 400, { error: 'timeoutMs is out of range' });
  }
  const envError = validateEnv(env);
  if (envError !== null) return json(res, 400, { error: envError });

  const result = await runProcess(argv[0], argv.slice(1), childEnv(env), timeoutMs, stdin);
  return json(res, 200, result);
}

/**
 * Packs a commit and everything reachable from it, then zstd-compresses the result. The body is buffered rather
 * than streamed, so a failed `pack-objects` can still return a clean error status.
 */
async function exportPack(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'body must be JSON' });
  }
  const commit = body?.commit;
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    return json(res, 400, { error: 'commit must be a git object id' });
  }

  const pack = spawn('git', ['--git-dir', REPO, 'pack-objects', '--stdout', '--revs'], {
    env: childEnv({}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const compressor = spawn('zstd', ['-c', '-q', '-3'], { stdio: ['pipe', 'pipe', 'ignore'] });
  pack.stdin.on('error', () => {});
  compressor.stdin.on('error', () => {});
  pack.stdout.pipe(compressor.stdin);
  const packStderr = collectStderr(pack);
  const packExit = exitCode(pack);
  const compressorExit = exitCode(compressor);
  pack.stdin.end(`${commit}\n`);

  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of compressor.stdout) {
    size += chunk.length;
    if (size > MAX_EXPORT_BYTES) {
      overflow = true;
      pack.kill('SIGKILL');
      compressor.kill('SIGKILL');
      break;
    }
    chunks.push(chunk);
  }
  const [packCode, compressorCode] = await Promise.all([packExit.catch(() => 1), compressorExit.catch(() => 1)]);

  if (overflow) return json(res, 413, { error: `packfile exceeds ${MAX_EXPORT_BYTES} bytes` });
  if (packCode !== 0) return json(res, 422, { error: 'pack-objects failed', detail: packStderr() });
  if (compressorCode !== 0) return json(res, 500, { error: 'zstd failed' });

  const payload = Buffer.concat(chunks);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(payload.length),
    'x-gitvise-encoding': 'zstd',
  });
  res.end(payload);
}

function validateEnv(env) {
  const entries = Object.entries(env);
  if (entries.length > MAX_ENV_ENTRIES) return `env must have at most ${MAX_ENV_ENTRIES} entries`;
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key)) return `env.${key} is not a valid variable name`;
    if (DENIED_ENV.has(key)) return `env.${key} cannot be set in a sandbox`;
    if (typeof value !== 'string' || value.length > MAX_ENV_VALUE_LENGTH || value.includes('\0')) {
      return `env.${key} must be a string without NUL, up to 4096 characters`;
    }
  }
  return null;
}

/** Builds a child environment: the fixed base, then the lease env, with denied keys removed. */
function childEnv(leaseEnv) {
  const merged = { ...BASE_ENV };
  for (const [key, value] of Object.entries(leaseEnv)) {
    if (!DENIED_ENV.has(key)) merged[key] = value;
  }
  return merged;
}

/**
 * Runs a process with a hard wall-clock limit. The child gets its own process group, so the timeout
 * kills everything it started. Output is capped at 4 MiB per stream.
 */
function runProcess(file, args, env, timeoutMs, stdin) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(file, args, {
      cwd: WORKSPACE,
      env,
      detached: true,
      shell: false,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (stdin !== undefined) {
      // A child that exits early closes its stdin; the write error is expected and must not crash the agent.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin, 'utf8');
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message, timedOut: false, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
      resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

function runGit(args, { timeoutMs = 60_000 } = {}) {
  return runProcess('git', args, childEnv({}), timeoutMs);
}

function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group has already exited.
  }
}

function collectStderr(child) {
  let text = '';
  child.stderr.on('data', (chunk) => {
    if (text.length < 4096) text += chunk.toString('utf8');
  });
  return () => text;
}

function exitCode(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
