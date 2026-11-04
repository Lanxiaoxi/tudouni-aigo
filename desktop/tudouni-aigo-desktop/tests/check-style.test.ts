/**
 * Checkbox and radio: one look, and a guard that a new one gets it.
 *
 * The drawn box lives in `components/check.css` and is keyed to the rows the
 * inputs sit in (`.cfg-check`, the remember rows, `.tk-choice-row`, the
 * Markdown task list). A new checkbox in a row that is not on that list would
 * silently come back as the browser's own control, which is exactly the drift
 * this file replaced, and nothing but a screenshot would show it. So the rule is
 * asserted from the source: every checkbox/radio `<input>` in a component is
 * inside a covered row, or is the one deliberately hidden radio.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const checkCss = readFileSync(resolve(src, 'styles/components/check.css'), 'utf8');

/** Rows whose input `check.css` draws. */
const COVERED = ['cfg-check', 'close-remember', 'cfgsync-remember', 'tk-choice-row'];

/** The settings segment hides its radio and paints the segment instead. */
const HIDDEN_ON_PURPOSE = ['set-choice-item'];

test('check.css names every row class the forms use', () => {
  for (const row of COVERED) {
    assert.ok(checkCss.includes(`.${row}`), `check.css has no rule for .${row}`);
  }
  assert.ok(checkCss.includes(".md input[type='checkbox']"), 'the Markdown task list is not covered');
});

test('the stylesheet is imported', () => {
  const index = readFileSync(resolve(src, 'styles/index.css'), 'utf8');
  assert.match(index, /@import '\.\/components\/check\.css';/);
});

test('every checkbox / radio input sits in a row check.css draws', () => {
  const stray: string[] = [];
  let seen = 0;
  for (const file of walk(src).filter((f) => f.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/type=["'](checkbox|radio)["']/g)) {
      seen++;
      // The row is the nearest `<label className=...>` before the input.
      const before = text.slice(0, m.index);
      const label = [...before.matchAll(/<label\b[^>]*className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].pop();
      const classes = (label?.[1] ?? label?.[2] ?? '').split(/\s+/);
      const ok = [...COVERED, ...HIDDEN_ON_PURPOSE].some((row) => classes.includes(row));
      if (!ok) {
        const line = before.split('\n').length;
        stray.push(`${file.replace(root + '\\', '')}:${line} (row: "${classes.join(' ')}")`);
      }
    }
  }
  assert.ok(seen > 0, 'found no checkbox/radio inputs at all; the scan is broken');
  assert.deepEqual(stray, [], `inputs outside a covered row would render natively:\n${stray.join('\n')}`);
});

test('no colour is left to accent-color', () => {
  // `accent-color` tints the native control but not its shape, which is the
  // half-measure this replaced.
  const hits: string[] = [];
  for (const file of walk(resolve(src, 'styles')).filter((f) => f.endsWith('.css'))) {
    const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/accent-color\s*:/.test(stripped)) hits.push(file.replace(root + '\\', ''));
  }
  assert.deepEqual(hits, []);
});

test('the tick and the dot are drawn from tokens, not literals', () => {
  const stripped = checkCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'check.css names a raw colour');
  assert.match(stripped, /var\(--fg-on-accent\)/, 'the tick follows the on-accent ink');
});

test('a radio keeps its round shape under the keyboard focus ring', () => {
  // global.css sets `border-radius: var(--radius-sm)` on every :focus-visible;
  // without this rule Tab turns a radio into a rounded square.
  assert.match(
    checkCss,
    /html\[data-input-mode='keyboard'\] \.tk-choice-row input\[type='radio'\]:focus-visible\s*\{\s*border-radius: 50%;/,
  );
});

test('the retired Radix radio classes are gone', () => {
  const controls = readFileSync(resolve(src, 'styles/components/controls.css'), 'utf8');
  assert.doesNotMatch(controls, /\.radio-(item|outer|inner)/);
});
