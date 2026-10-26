import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The usage panel's stylesheet, as text.
 *
 * One layout defect lived here and every other test was blind to it: the
 * heatmap's cell size and gap were declared on `.usage-grid, .usage-weeks`,
 * but the month-label row (`.usage-months`) sits **between** the two grids in
 * the DOM and is neither of them. A custom property does not leak to sibling
 * elements, so its `grid-auto-columns: var(--usage-cell)` resolved to nothing
 * and fell back to `auto` — the auto-placed column track of a fit-content
 * grid is its content's width, and every month label bunched together at the
 * card's left edge while the grid above stretched out over 53 columns.
 *
 * CSS is the kind of file that tests usually read rather than run, so this
 * check is about the stylesheet's **structure**: the cell geometry must be
 * declared on an ancestor of everything that consumes it, and it must not be
 * declared on the grids themselves, because that is exactly where it was
 * before the fix.
 */

const css = readFileSync(
  resolve(process.cwd(), 'src', 'styles', 'components', 'usage.css'),
  'utf8',
);

/** The stylesheet as `selector → declaration body` for every rule. */
function rules(): [string, string][] {
  const out: [string, string][] = [];
  // Comments removed first: the file's header comments carry braces-free prose
  // that would otherwise read as selector text.
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([m[1], m[2]]);
  }
  return out;
}

/** Every selector the `--usage-cell` declaration sits on. */
function cellDeclaringSelectors(): string[] {
  return rules()
    .filter(([, body]) => /--usage-cell\s*:/.test(body))
    .map(([selector]) => selector.split(',').map((s) => s.trim()))
    .flat();
}

test('the cell geometry is declared where the month labels can inherit it', () => {
  // `.usage-months` is a child of the activity card, so the card itself is
  // the lowest common ancestor the property can be declared on. Anything
  // narrower — the grids themselves, which are the labels' **siblings** —
  // leaves the labels with an unresolved var and an `auto` column track.
  const declarers = cellDeclaringSelectors();
  assert.ok(
    declarers.includes('.usage-activity'),
    `--usage-cell is declared on ${JSON.stringify(declarers)}; the month row is not inside any of these, so its columns fall back to auto and the labels bunch up`,
  );
});

test('the cell geometry is not declared on the grids themselves', () => {
  const declarers = cellDeclaringSelectors();
  for (const forbidden of ['.usage-grid', '.usage-weeks']) {
    assert.ok(
      !declarers.includes(forbidden),
      `--usage-cell is declared on ${forbidden}: the month row is a sibling of the grids, not a descendant of them, so it would never see the value`,
    );
  }
});

test('the month row consumes the geometry, so it is a check worth keeping', () => {
  const months = rules()
    .filter(([selector]) => selector.includes('.usage-months'))
    .map(([, body]) => body)
    .join('\n');
  // If the row stopped consuming the variables, the declaration above would
  // be dead weight and this test would start guarding nothing.
  assert.match(months, /grid-auto-columns:\s*var\(--usage-cell\)/);
  assert.match(months, /gap:\s*var\(--usage-gap\)/);
});
