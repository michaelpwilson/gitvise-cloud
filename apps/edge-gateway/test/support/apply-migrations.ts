import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-plugin';

// Runs every migration in migrations/ against the local D1 database before each test file. A broken SQL file
// fails here, so schema errors surface in `npm test` and not at deploy time.
const bindings = env as unknown as { D1: D1Database; TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(bindings.D1, bindings.TEST_MIGRATIONS);
