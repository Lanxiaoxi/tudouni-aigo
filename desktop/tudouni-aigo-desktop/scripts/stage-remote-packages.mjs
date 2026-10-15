/**
 * Stage both platforms' release archives for the Remote Bootstrapper.
 *
 * Unlike `stage-runtime.mjs`, which copies the **unpacked** host-platform
 * build into `runtime/` for local execution, this script copies the
 * **packed** `.zip` archives for *every* shipped platform into
 * `remote-packages/` — see that directory's own README for why the two must
 * stay separate.
 *
 * Both platforms are staged regardless of which machine this script runs
 * on: the whole point of carrying the archives in the desktop package is
 * that the remote host's platform decides which one is used at install
 * time (§8.2), not the platform doing the staging.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..');
const distDir = join(repoRoot, 'dist');
const destDir = join(appDir, 'src-tauri', 'remote-packages');

/** The two triples internal/release.Targets ships — kept in sync with that
 *  Go file and with stage-runtime.mjs's own hostTriple(), by hand, since a
 *  Node script cannot import a Go constant. TestTargetsAreTheTwoWeShip (Go
 *  side) is what notices if release.Targets ever grows a third entry that
 *  this list has not been updated to match. */
const TRIPLES = ['x86_64-unknown-linux-musl', 'x86_64-pc-windows-msvc'];

const versionFile = join(repoRoot, 'VERSION');
const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '';

if (!existsSync(distDir)) {
  console.error(`no dist/ at ${distDir}`);
  console.error('build the archives first:  make release');
  process.exit(1);
}

// The destination is not in the repository (the archives are build output, like
// `runtime/`), so on a clean checkout it does not exist yet — and `copyFileSync`
// does not create it. Without this the very first `npm run runtime:stage-remote`
// on a fresh clone failed with ENOENT naming a path it was about to write, which
// reads as "the build produced nothing" rather than "the destination was
// missing". `recursive` so a partially-created tree is fine too.
mkdirSync(destDir, { recursive: true });

function sha256File(path) {
  const hash = createHash('sha256');
  // Synchronous streaming: these are small-ish files (tens of MB) run once
  // during a build step, not something that needs to be async-friendly.
  const data = createReadStream(path);
  return new Promise((resolve, reject) => {
    data.on('data', (chunk) => hash.update(chunk));
    data.on('end', () => resolve(hash.digest('hex')));
    data.on('error', reject);
  });
}

async function main() {
  const archives = readdirSync(distDir).filter((name) => name.endsWith('.zip'));

  let staged = 0;
  const missing = [];

  for (const triple of TRIPLES) {
    const exact = version ? archives.find((name) => name === `tudouni-aigo-${version}-${triple}.zip`) : null;
    const anyMatch = archives.find((name) => name.endsWith(`-${triple}.zip`));
    const chosen = exact ?? anyMatch;

    if (!chosen) {
      missing.push(triple);
      continue;
    }
    if (!exact) {
      console.warn(`warning: no archive matching VERSION=${version || '(unreadable)'} for ${triple}; using ${chosen}`);
    }

    const source = join(distDir, chosen);
    const destName = `tudouni-aigo-${version || 'unknown'}-${triple}.zip`;
    const dest = join(destDir, destName);
    copyFileSync(source, dest);

    const digest = await sha256File(dest);
    writeFileSync(`${dest}.sha256`, `${digest}  ${destName}\n`);

    staged += 1;
    console.log(`staged ${triple}: ${destName}  (sha256 ${digest.slice(0, 12)}…)`);
  }

  // **Remove archives for other versions.** Without this the directory
  // accumulates one pair per release, and `resolve_remote_package` picks the
  // archive for a triple by suffix match over `readdir` order — so with a 6.5.0
  // and a 6.6.1 both present, which one an install uploads is whatever the
  // filesystem returns first. A remote machine would then get a runtime that
  // disagrees with the one the app was built against, and nothing would say so.
  //
  // Only the exact version staged above survives, so the directory always holds
  // exactly one archive per triple. The `.sha256` sidecars go with them, and
  // `README.md` is left alone (it explains how to populate this directory).
  if (version) {
    const keep = new Set(TRIPLES.map((triple) => `tudouni-aigo-${version}-${triple}.zip`));
    const stale = readdirSync(destDir).filter((name) => name.endsWith('.zip') && !keep.has(name));
    for (const name of stale) {
      rmSync(join(destDir, name), { force: true });
      rmSync(join(destDir, `${name}.sha256`), { force: true });
      console.log(`removed stale ${name}`);
    }
  }

  if (missing.length > 0) {
    console.error('');
    console.error(`no built archive found for: ${missing.join(', ')}`);
    console.error(`looked in ${distDir}`);
    console.error('build every target first:  make release');
    process.exit(1);
  }

  console.log('');
  console.log(`staged ${staged} remote install package(s) into remote-packages/`);
}

await main();
