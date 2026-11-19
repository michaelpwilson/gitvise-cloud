import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// Tests run inside workerd through the Cloudflare Vitest plugin. Bindings come from the test config, not
// from wrangler.jsonc, so tests never touch containers, R2, Workers AI, or any remote resource. D1 is a local
// Miniflare database that gets the real migrations applied in test/support/apply-migrations.ts.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './test/wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(here, 'migrations')),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/support/apply-migrations.ts'],
  },
});
