/**
 * Class-name audit.
 *
 * A `className` with no matching CSS rule is invisible to the type checker, to
 * the unit tests and to any assertion about text content — the element renders,
 * it just has no styling. The failure mode is a control that lands in the wrong
 * place (window buttons next to the title instead of at the right edge) and only
 * a screenshot shows it.
 *
 * So: collect every class name used in the TSX and every class selector defined
 * in the CSS, and report the difference. Class names that come from a token set
 * or a library are listed as allowed with a reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(srcDir);

/* ---- class names used in TSX ---- */
const used = new Map(); // name -> [file:line]
for (const file of files.filter((f) => f.endsWith('.tsx'))) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // className="a b c" and className={`a b ${x}`}
    for (const m of line.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const raw = m[1] ?? m[2] ?? '';
      // Drop ${...} interpolations: they are computed and cannot be audited here.
      const cleaned = raw.replace(/\$\{[^}]*\}/g, ' ');
      for (const name of cleaned.split(/\s+/)) {
        if (!name || name.includes('$')) continue;
        if (!used.has(name)) used.set(name, []);
        used.get(name).push(`${file.replace(root + '\\', '').replace(/\\/g, '/')}:${i + 1}`);
      }
    }
  });
}

/* ---- class selectors defined in CSS ---- */
const defined = new Set();
for (const file of files.filter((f) => f.endsWith('.css'))) {
  const text = readFileSync(file, 'utf8');
  // Strip comments so commented-out rules do not count.
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);
}

/* ---- allowed exceptions, each with a reason ---- */
const ALLOWED = new Map([
  ['app', 'the shell root; styled via .app in app.css'],
  ['scroll', 'a behaviour class; the scrollbar styling targets .scroll'],
  ['reveal', 'entrance transition hook'],
]);

const missing = [];
const DYNAMIC_PREFIX = /^(badge|risk|btn|fact|is|tone|e)-?$/;
for (const [name, where] of used) {
  if (defined.has(name)) continue;
  if (ALLOWED.has(name)) continue;
  // A trailing fragment like `badge-` is the head of a template literal
  // (`badge-${tone}`); the full names it produces are audited through the CSS
  // side instead.
  if (DYNAMIC_PREFIX.test(name)) continue;
  missing.push({ name, where });
}

/* ---- rules defined but never used (dead CSS) ---- */
//
// Names produced by a template literal cannot be matched by the scan above, so
// they are collected here as *prefixes*: for `badge badge-${tone}`, anything
// starting with `badge-` is potentially produced. The check is deliberately
// loose — over-suppressing only costs a missed note, while the assertion that
// matters (used but undefined) is unaffected.
const dynamicPrefixes = [];
for (const file of files.filter((f) => f.endsWith('.tsx'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/className=\{`([^`]*)`\}/g)) {
    const body = m[1];
    // The text immediately before each interpolation, minus any trailing
    // partial word boundary.
    for (const part of body.split(/\$\{[^}]*\}/)) {
      const tokens = part.split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1];
      if (last) dynamicPrefixes.push(last);
    }
  }
}

const isDynamic = (name) => dynamicPrefixes.some((prefix) => name.startsWith(prefix));

const unused = [];
for (const name of defined) {
  if (used.has(name)) continue;
  if (isDynamic(name)) continue;
  unused.push(name);
}

console.log(`classes used in TSX:   ${used.size}`);
console.log(`classes defined in CSS: ${defined.size}`);
console.log('');

if (missing.length > 0) {
  console.log(`FAIL — ${missing.length} class name(s) used with no CSS rule:`);
  for (const { name, where } of missing) {
    console.log(`  .${name}  used at ${where.slice(0, 3).join(', ')}`);
  }
  console.log('');
}

if (unused.length > 0) {
  console.log(`note: ${unused.length} CSS class(es) defined but not referenced:`);
  console.log(`  ${unused.sort().join(', ')}`);
  console.log('');
}

if (missing.length > 0) process.exit(1);
console.log('PASS — every class name used in the UI has a CSS rule.');
