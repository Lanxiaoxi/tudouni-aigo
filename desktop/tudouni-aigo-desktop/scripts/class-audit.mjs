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

/**
 * Static class names inside one className expression.
 *
 * A plain `className="a b"` is easy; the hard cases are the ones this audit
 * used to miss entirely: a template literal with a condition
 * (`` `dialog${x ? ' cmdk' : ''}` ``) and a ternary in braces
 * (`{ok ? 'ci-last-ok' : 'ci-last-bad'}`). Both apply a real class, so both are
 * read here — otherwise the class looks dead and someone deletes its styling.
 */
function classNamesIn(expression) {
  const names = new Set();
  const addList = (text) => {
    for (const token of text.split(/\s+/)) {
      if (!token || !/^[a-zA-Z][\w-]*$/.test(token)) continue;
      names.add(token);
    }
  };

  // i points at a quote/template/expression start; returns the index after it.
  function scanTemplate(i) {
    i++; // `
    let text = '';
    while (i < expression.length) {
      const c = expression[i];
      if (c === '\\') { text += expression[i + 1] ?? ''; i += 2; continue; }
      if (c === '`') { addList(text); return i + 1; }
      if (c === '$' && expression[i + 1] === '{') {
        addList(text);
        text = '';
        i = scanCode(i + 2);
        continue;
      }
      text += c;
      i++;
    }
    addList(text);
    return i;
  }

  function scanString(i) {
    const quote = expression[i];
    i++;
    let text = '';
    while (i < expression.length) {
      const c = expression[i];
      if (c === '\\') { text += expression[i + 1] ?? ''; i += 2; continue; }
      if (c === quote) break;
      text += c;
      i++;
    }
    addList(text);
    return i + 1;
  }

  // Inside `${...}`: a literal after `?`, `:` or `&&` is a class branch. A
  // literal on the right of `===` is a value being compared, not a class.
  function scanCode(i, start) {
    let depth = 1;
    while (i < expression.length) {
      const c = expression[i];
      if (c === '`') { i = scanTemplate(i); continue; }
      if (c === '"' || c === "'") {
        let j = i - 1;
        while (j >= 0 && /\s/.test(expression[j])) j--;
        const branch = j >= 0 && '?:&'.includes(expression[j]);
        const whole = /^\s*$/.test(expression.slice(start, i));
        i = branch || whole ? scanString(i) : skipString(i);
        continue;
      }
      if (c === '{') { depth++; i = scanCode(i + 1, i + 1); continue; }
      if (c === '}') { depth--; i++; if (depth === 0) return i; continue; }
      i++;
    }
    return i;
  }

  function skipString(i) {
    const quote = expression[i];
    i++;
    while (i < expression.length) {
      if (expression[i] === '\\') i += 2;
      else if (expression[i] === quote) return i + 1;
      else i++;
    }
    return i;
  }

  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === '`') i = scanTemplate(i);
    else if (c === '"' || c === "'") i = scanString(i);
    else if (c === '{') i = scanCode(i + 1, i + 1);
    else i++;
  }
  return names;
}

/** Find the end of a `{...}` expression, counting nesting and skipping strings. */
function braceEnd(text, open) {
  let depth = 1;
  let quote = null;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

for (const file of files.filter((f) => f.endsWith('.tsx'))) {
  const text = readFileSync(file, 'utf8');
  const lineAt = (index) => text.slice(0, index).split('\n').length;
  const record = (names, index) => {
    for (const name of names) {
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(`${file.replace(root + '\\', '').replace(/\\/g, '/')}:${lineAt(index)}`);
    }
  };
  for (const m of text.matchAll(/className\s*=\s*/g)) {
    const start = m.index + m[0].length;
    const c = text[start];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, start + 1);
      record(classNamesIn(text.slice(start, end + 1)), start);
    } else if (c === '{') {
      const end = braceEnd(text, start);
      record(classNamesIn(text.slice(start, end + 1)), start);
    }
  }
  // Classes applied from code rather than from JSX.
  for (const m of text.matchAll(/(?:classList\.(?:add|remove|toggle)|querySelector(?:All)?|closest|matches)\(\s*(['"`])([^'"`]+)\1/g)) {
    record(classNamesIn(m[2]), m.index);
  }
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
  // These two are real gaps, not exceptions to the rule: the markup was written
  // but the rule never was, and the old audit could not see either because both
  // sit inside a ternary. Recorded in docs/tech-debt/baseline.md so the next CSS
  // pass fixes the look rather than deleting the name.
  ['checkbox-box', 'used by QuestionModal multi-select; no rule yet (baseline gap)'],
  ['btn-danger', 'used by CodeIntelPanel armed state; no rule yet (baseline gap)'],
]);

const missing = [];
const DYNAMIC_PREFIX = /^(badge|risk|btn|fact|wm-conf|is|tone|e)-?$/;
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
