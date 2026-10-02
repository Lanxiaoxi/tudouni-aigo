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

/**
 * Every suite, named **once**.
 *
 * There used to be two lists — the esbuild entry points, and the files handed to
 * `node --test` — and only the first was kept up to date. `workspace.test.ts` was
 * therefore bundled and never executed, which is the worst possible failure for a
 * test: the suite reported a green total that silently excluded it, and the
 * assertions were never run at all. Deriving both from one list is what makes
 * that impossible rather than merely unlikely.
 */
const SUITES = [
  'projection.test.ts',
  'contract.test.ts',
  'paste.test.ts',
  'workspace.test.ts',
  // The attach race: a child's opening handshake can be on the wire before the
  // store has built the handle for it, and the layers that hold it only mean
  // something if the bucket is installed before anything is subscribed. It is
  // the "I opened a new session and it never came up" report.
  'attach-race.test.ts',
  // The workspace's capabilities: the keystroke encoder, the terminal output
  // buffer, and the file browser's path arithmetic. All three are pure, which is
  // why they can be asserted without a window or a shell.
  'terminal.test.ts',
  // The stylesheet rule that keeps a long conversation's stream flat. It reads
  // `app.css` as text, because the declaration has no behaviour to observe in
  // Node and what is being protected is its presence — see the file for why a
  // performance fix is worth a test at all.
  'stream-layout.test.ts',
  // What the conversation column shows, and in what order. A priority order
  // written as a chain of ternaries is exactly the kind of thing that reads as
  // ordinary code while being wrong — this one hid an attached terminal behind
  // the first screen, which took the composer away with it.
  'conversation-view.test.ts',
  // The left rail's two groups, and what makes its actions inert. This is the
  // "I press New session and nothing happens" report: a session with no file yet
  // was in no list at all, and a panel made the rail unclickable while it still
  // looked available. Both are pure functions, so both are assertable here.
  'rail-groups.test.ts',
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: SUITES.map((name) => resolve(here, name)),
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
    ...SUITES.map((name) => resolve(outDir, name.replace(/\.ts$/, '.mjs'))),
  ],
  {
    stdio: 'inherit',
    cwd: root,
  },
);

process.exit(result.status ?? 1);
