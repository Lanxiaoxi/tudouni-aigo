/**
 * Colour-token guard.
 *
 * `tokens.css` is the only file allowed to name a raw colour. Everywhere else a
 * literal is a theme that will not follow the light/dark switch, and there are
 * two of those. This script finds the leaks.
 *
 *   node scripts/check-css-tokens.mjs            warn (exit 0)
 *   node scripts/check-css-tokens.mjs --fail     fail on any literal
 *   node scripts/check-css-tokens.mjs --report   list every occurrence
 *
 * Comments are stripped first: a colour named in prose is documentation, not a
 * value. `tokens.css` is excluded by design; `font-face`/vendor assets are not
 * special-cased because there are none in the styles directory.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stylesDir = join(root, 'src', 'styles');
const ALLOWED_FILE = 'src/styles/tokens.css';

const fail = process.argv.includes('--fail');
const report = process.argv.includes('--report');

const PATTERNS = [
  { kind: 'hex', re: /#[0-9a-fA-F]{3,8}\b/g },
  { kind: 'rgb', re: /\brgba?\s*\(/g },
  { kind: 'hsl', re: /\bhsla?\s*\(/g },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const hits = [];
for (const file of walk(stylesDir)) {
  if (!file.endsWith('.css')) continue;
  const rel = relative(root, file).split(sep).join('/');
  if (rel === ALLOWED_FILE) continue;
  const raw = readFileSync(file, 'utf8');
  // Blank out comments while preserving line numbers.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        hits.push({ rel, line: i + 1, kind, value: m[0], text: lines[i].trim().slice(0, 120) });
      }
    }
  });
}

if (report) {
  for (const h of hits) console.log(`${h.rel}:${h.line}  ${h.kind}  ${h.text}`);
}

if (hits.length) {
  console.log(`\n${hits.length} colour literal(s) outside ${ALLOWED_FILE}:`);
  const byFile = new Map();
  for (const h of hits) byFile.set(h.rel, (byFile.get(h.rel) ?? 0) + 1);
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${file}`);
  }
  if (fail) {
    console.error('\nFAIL: use a token from tokens.css instead of a raw colour.');
    process.exit(1);
  }
  console.log('\nWARN: tokens.css is meant to be the only file with raw colours. Run with --fail once the leaks are gone.');
} else {
  console.log(`PASS: no colour literals outside ${ALLOWED_FILE}.`);
}
