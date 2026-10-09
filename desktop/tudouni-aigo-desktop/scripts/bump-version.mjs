/**
 * Bump the desktop client version in every place it is declared.
 *
 * The desktop version is independent of the Go runtime's VERSION file
 * (see AGENT.md), but it is declared in five files that must stay in
 * sync. This script updates them all in one shot, preserving each file's
 * line endings and formatting:
 *
 *   package.json              "version"                    (CRLF, 2-space JSON)
 *   package-lock.json         root "version" + packages."" (CRLF, 2-space JSON)
 *   src-tauri/tauri.conf.json "version"                    (CRLF, line-based)
 *   src-tauri/Cargo.toml      [package] version            (CRLF)
 *   src-tauri/Cargo.lock      tudouni-aigo-desktop only    (LF)
 *
 * Usage (from desktop/tudouni-aigo-desktop/, or anywhere with a relative path):
 *   node scripts/bump-version.mjs <new-version>   # apply, then re-verify
 *   node scripts/bump-version.mjs --check         # report drift, change nothing
 *
 * The lockfiles are edited as text, not re-serialized: they pin third-party
 * packages that legitimately share our version string, and a whole-file
 * replace would corrupt them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toRoot = (file) => resolve(root, file);

const fail = (message) => {
  console.error(`bump-version: ${message}`);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) {
  console.log('Usage: node scripts/bump-version.mjs <new-version> | --check');
  process.exit(0);
}

const check = arg === '--check';
const newVersion = check ? null : arg;

const readRaw = (file) => readFileSync(toRoot(file), 'utf8');
const read = (file) => readRaw(file).replace(/\r\n/g, '\n');
const write = (file, text, crlf) =>
  writeFileSync(toRoot(file), crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');

// --- helpers -----------------------------------------------------------------

// Whole-file JSON rewrite. Safe only because these files are stored as
// canonical `JSON.stringify(obj, null, 2) + '\n'`; the round-trip check
// refuses to touch a file that no longer is.
function bumpJsonFile(file, patch) {
  const text = read(file);
  const parsed = JSON.parse(text);
  if (JSON.stringify(parsed, null, 2) + '\n' !== text) {
    fail(`${file}: not canonical 2-space JSON; refusing to rewrite it wholesale.`);
  }
  return JSON.stringify(patch(parsed), null, 2) + '\n';
}

function replaceFirst(text, pattern, replacement, file) {
  if (!pattern.test(text)) fail(`${file}: ${pattern} not found; layout changed?`);
  return text.replace(pattern, () => replacement);
}

// Cargo.lock: only the [[package]] block named tudouni-aigo-desktop — the
// same version string appears on unrelated third-party crates.
const bumpCargoLock = (version) =>
  replaceFirst(
    read('src-tauri/Cargo.lock'),
    /name = "tudouni-aigo-desktop"\nversion = "[^"]+"/,
    `name = "tudouni-aigo-desktop"\nversion = "${version}"`,
    'src-tauri/Cargo.lock',
  );

// Cargo.toml: the [package] header is the first `version =` line.
const bumpCargoToml = (version) =>
  replaceFirst(
    read('src-tauri/Cargo.toml'),
    /^version = "[^"]+"/m,
    `version = "${version}"`,
    'src-tauri/Cargo.toml',
  );

// tauri.conf.json: line-based — re-serializing would reformat the file.
const bumpTauriConf = (version) =>
  replaceFirst(
    read('src-tauri/tauri.conf.json'),
    /^  "version": "[^"]+",/m,
    `  "version": "${version}",`,
    'src-tauri/tauri.conf.json',
  );

// --- verify ------------------------------------------------------------------

// Returns [file, good, note]; note is empty when good.
function verify(version) {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ['package.json', pkg.version === version, `found ${pkg.version}`],
    [
      'package-lock.json',
      lock.version === version && lock.packages[''].version === version,
      `found ${lock.version} / packages."".${lock.packages[''].version}`,
    ],
    [
      'src-tauri/tauri.conf.json',
      read('src-tauri/tauri.conf.json').includes(`  "version": "${version}",`),
      'no matching line',
    ],
    [`src-tauri/Cargo.toml`, new RegExp(`^version = "${v}"$`, 'm').test(read('src-tauri/Cargo.toml')), 'no matching line'],
    [
      'src-tauri/Cargo.lock',
      read('src-tauri/Cargo.lock').includes(`name = "tudouni-aigo-desktop"\nversion = "${version}"`),
      'no matching block',
    ],
  ];
}

function report(version) {
  let drift = false;
  for (const [file, good, note] of verify(version)) {
    if (!good) drift = true;
    console.log(`${good ? 'ok   ' : 'DRIFT'} ${file}${good ? '' : ` — ${note}, expected ${version}`}`);
  }
  return drift;
}

// --- run ---------------------------------------------------------------------

const currentVersion = JSON.parse(read('package.json')).version;

if (check) {
  const drift = report(currentVersion);
  // Cross-check: are any of the five out of sync with each other?
  const versions = new Set(
    [
      JSON.parse(read('package.json')).version,
      JSON.parse(read('package-lock.json')).version,
      JSON.parse(read('package-lock.json')).packages[''].version,
      read('src-tauri/tauri.conf.json').match(/^  "version": "([^"]+)",/m)?.[1],
      read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1],
      read('src-tauri/Cargo.lock').match(/name = "tudouni-aigo-desktop"\nversion = "([^"]+)"/)?.[1],
    ],
  );
  if (versions.size > 1) {
    console.log(`files disagree with each other: ${[...versions].join(' vs ')}`);
    process.exit(1);
  }
  process.exit(drift ? 1 : 0);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(newVersion)) {
  fail(`"${newVersion}" is not a plausible version (expected MAJOR.MINOR.PATCH) for current ${currentVersion}`);
}
if (newVersion === currentVersion) {
  console.log(`bump-version: already at ${newVersion}; nothing to do.`);
  process.exit(0);
}

const updated = {
  'package.json': bumpJsonFile('package.json', (obj) => {
    obj.version = newVersion;
    return obj;
  }),
  'package-lock.json': bumpJsonFile('package-lock.json', (obj) => {
    obj.version = newVersion;
    obj.packages[''].version = newVersion;
    return obj;
  }),
  'src-tauri/tauri.conf.json': bumpTauriConf(newVersion),
  'src-tauri/Cargo.toml': bumpCargoToml(newVersion),
  'src-tauri/Cargo.lock': bumpCargoLock(newVersion),
};

const crlf = (file) => file.endsWith('.json') || file === 'src-tauri/Cargo.toml';
for (const [file, text] of Object.entries(updated)) {
  write(file, text, crlf(file));
  console.log(`updated ${file} -> ${newVersion}`);
}

console.log('\nverification:');
const drift = report(newVersion);
if (drift) fail('verification failed after write; run `git diff` to inspect.');
console.log(`bump-version: ${currentVersion} -> ${newVersion} done.`);
