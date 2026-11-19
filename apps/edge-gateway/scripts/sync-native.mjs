// Copies the Rust source of @gitvise/core-native's git-engine addon into ./native/git-engine, so the
// sandbox Dockerfile can compile it. The Dockerfile cannot reach the sibling repo directly, because the
// build context is this app.
//
// Source resolution: GITVISE_CORE_NATIVE_SOURCE, or ../../../gitvise/packages/core-native/git-engine.

import { cp, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const source = resolve(
  process.env.GITVISE_CORE_NATIVE_SOURCE ?? join(appRoot, '../../../gitvise/packages/core-native/git-engine'),
);
const destination = join(appRoot, 'native', 'git-engine');

try {
  await access(join(source, 'Cargo.toml'), constants.R_OK);
} catch {
  console.error(`git-engine crate not found at ${source}. Set GITVISE_CORE_NATIVE_SOURCE to override.`);
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await cp(source, destination, {
  recursive: true,
  // Build output and machine-local artefacts are rebuilt inside the image, so skip them.
  filter: (path) => !/[\\/](target|node_modules)([\\/]|$)/.test(path) && !path.endsWith('.node'),
});

console.log(`synced git-engine: ${source} -> ${destination}`);
