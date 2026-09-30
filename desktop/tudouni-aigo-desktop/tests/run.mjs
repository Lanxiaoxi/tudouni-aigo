/**
 * Test runner.
 *
 * The sources use the `@/` alias, which plain `node --test` cannot resolve, so
 * the tests are bundled with esbuild first (the alias is remapped to a relative
 * path) and then run. No extra dependency beyond esbuild, which Vite already
 * brings in.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, '.test-build');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [
    resolve(here, 'projection.test.ts'),
    resolve(here, 'contract.test.ts'),
    resolve(here, 'paste.test.ts'),
    resolve(here, 'workspace.test.ts'),
  ],
  outdir: outDir,
  // `.mjs`, because package.json declares `"type": "module"` and the sources are
  // ESM — esbuild would otherwise emit `.js` and the runner's paths would miss.
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  // Everything else is bundled: the test drives the real modules, not stubs.
  external: ['node:*'],
  alias: {
    '@': resolve(root, 'src'),
  },
  define: {
    // Injected by Vite in the real build; the store reads it once at module load.
    __DESKTOP_VERSION__: JSON.stringify('0.1.0'),
  },
  logLevel: 'warning',
});

const result = spawnSync(
  process.execPath,
  [
    '--test',
    resolve(outDir, 'projection.test.mjs'),
    resolve(outDir, 'contract.test.mjs'),
    resolve(outDir, 'paste.test.mjs'),
  ],
  {
    stdio: 'inherit',
    cwd: root,
  },
);

process.exit(result.status ?? 1);
