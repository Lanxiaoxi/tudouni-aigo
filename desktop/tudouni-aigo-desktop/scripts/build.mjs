/**
 * Production build.
 *
 * Exists to pin esbuild's scratch directory inside the project.
 *
 * On some Windows machines esbuild's own cleanup of its temp file fails with
 * "Access is denied" (a scanner or indexer holding the handle), and the build
 * dies after transforming everything — `vite:esbuild-transpile remove ... Access
 * is denied`. It is not caused by anything in this project: the untouched
 * reference prototype under `desktop/tudouni-aigo-desktop-design/webui/` fails
 * identically on the same machine. Pointing `TEMP`/`TMP` at a directory we own
 * avoids it, and costs nothing when the machine does not have the problem.
 *
 * The steps are the same ones `npm run build` documents: `tsc -b`, then
 * `vite build`. Type checking runs first and its failure stops the build, so a
 * type error can never be papered over by a successful bundle.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(root, '.tmp');
mkdirSync(scratch, { recursive: true });

const env = { ...process.env, TEMP: scratch, TMP: scratch };

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: root,
    env,
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

const typecheck = run('npx', ['tsc', '-b']);
if (typecheck !== 0) {
  console.error('\ntsc failed; not bundling.');
  process.exit(typecheck);
}

process.exit(run('npx', ['vite', 'build']));
