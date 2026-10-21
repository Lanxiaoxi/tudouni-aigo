/**
 * File-size guard.
 *
 * The tech-debt plan (docs/tech-debt/baseline.md) freezes the size of the files
 * it is shrinking: `store.ts` and the stylesheets. The budgets below are
 * ratchets — a stage may only lower them, never raise them. A failure here is
 * not "the build is broken"; it is "the debt grew back".
 *
 *   node scripts/check-size.mjs            fail when a file exceeds its budget
 *   node scripts/check-size.mjs --report   print every measured file, always 0
 *
 * Budgets are line counts. `src/styles/**` also has a default ceiling so a new
 * hand-written stylesheet cannot start life at 2,000 lines.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exact budgets for files that predate the guard. Lower only. */
const FILES = {
  // Was 8,064 before the split. The plan's target is ≤600; 300 leaves room for
  // the composition and the hooks without letting the old shape grow back.
  'src/state/store.ts': 300,
  'src/state/entries.ts': 1306,
  // One interface, no behaviour: it cannot be split without scattering the
  // store's contract. Pinned at its size rather than left to the default.
  'src/state/storeShape.ts': 1246,
  'src/styles/app.css': 1833,
  'src/styles/global.css': 603,
};

/** Defaults for anything added later. */
const DEFAULTS = {
  'src/state/': 1000,
  'src/styles/': 800,
};

const report = process.argv.includes('--report');
const failures = [];
const rows = [];

function lineCount(path) {
  const text = readFileSync(path, 'utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function budgetFor(rel) {
  if (FILES[rel] !== undefined) return { max: FILES[rel], source: 'pinned' };
  for (const [prefix, max] of Object.entries(DEFAULTS)) {
    if (rel.split(sep).join('/').startsWith(prefix)) return { max, source: `default ${prefix}` };
  }
  return null;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

for (const area of ['src/state', 'src/styles']) {
  if (!existsSync(join(root, area))) continue;
  for (const file of walk(join(root, area))) {
    if (!/\.(ts|tsx|css)$/.test(file)) continue;
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    const rel = relative(root, file).split(sep).join('/');
    const budget = budgetFor(rel);
    if (!budget) continue;
    const lines = lineCount(file);
    rows.push({ rel, lines, max: budget.max, over: lines > budget.max });
    if (lines > budget.max) failures.push(`${rel}: ${lines} > ${budget.max} (${lines - budget.max} over)`);
  }
}

rows.sort((a, b) => b.lines - a.lines);
if (report || failures.length) {
  console.log('file sizes (state/ and styles/):');
  for (const row of rows) {
    console.log(`  ${row.over ? 'OVER ' : '     '}${String(row.lines).padStart(5)}  ${row.rel}  (budget ${row.max})`);
  }
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} file(s) over budget:`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nLowering a budget is part of the stage that shrinks the file. Raising one needs a reason in the PR.');
  process.exit(1);
}

console.log(`\nPASS: every state/ and styles/ file is within budget.`);
