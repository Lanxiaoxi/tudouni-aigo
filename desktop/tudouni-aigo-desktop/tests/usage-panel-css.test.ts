import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDailyGrid } from '@/components/panels/usageHeatmap';

/**
 * The usage heatmap's stylesheet, as text.
 *
 * Two layout defects have lived here, and every other test was blind to both
 * because both are geometry, and geometry is what a browser decides:
 *
 *  1. **The month row did not see the cell size.** `--usage-cell` and
 *     `--usage-gap` were declared on `.usage-grid, .usage-weeks`, but
 *     `.usage-months` sits **between** the two grids in the DOM and is neither
 *     of them. A custom property does not reach a sibling, so its
 *     `grid-auto-columns: var(--usage-cell)` resolved to nothing and fell back
 *     to `auto` — and every month label bunched together at the card's left
 *     edge while the grid above stretched out over 53 columns.
 *
 *  2. **The tracks were fixed pixels, so the grid could outgrow its card.**
 *     `--usage-cell: 11px` on the day grid and a literal `15px` on the week row
 *     are claims about how much room there is, and the claim was wrong: 53
 *     columns of 11px plus their gaps is 739px inside a 716px content box at
 *     the panel's 800px rung. The day grid ran past the card's border by 7px
 *     and the week row (53 × 15px = 951px) by 232px, out through the dialog's
 *     edge where `overflow: hidden` silently clipped the last ten weeks. It was
 *     invisible on a wide display and unmissable on a narrow one, which is
 *     exactly the shape of bug a screenshot review misses.
 *
 * So this check is about the stylesheet's **structure**, and it is written to
 * fail if either defect is reintroduced rather than to describe today's file.
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

/** Every declaration body belonging to a selector that mentions `selector`. */
function bodiesOf(selector: string): string {
  return rules()
    .filter(([sel]) => sel.includes(selector))
    .map(([, body]) => body)
    .join('\n');
}

/** Every selector the `--usage-cols` declaration sits on. */
function colsDeclaringSelectors(): string[] {
  return rules()
    .filter(([, body]) => /--usage-cols\s*:/.test(body))
    .map(([selector]) => selector.split(',').map((s) => s.trim()))
    .flat();
}

test('the column count is declared where the month labels can inherit it', () => {
  // `.usage-months` is a child of the activity card, so the card itself is the
  // lowest common ancestor the property can be declared on. Anything narrower —
  // the grids themselves, which are the labels' **siblings** — leaves the labels
  // with an unresolved var and an `auto` column track, which is defect 1.
  const declarers = colsDeclaringSelectors();
  assert.ok(
    declarers.includes('.usage-activity'),
    `--usage-cols is declared on ${JSON.stringify(declarers)}; the month row is not inside any of these, so its columns fall back to auto and the labels bunch up`,
  );
});

test('the column count is not declared on the grids themselves', () => {
  const declarers = colsDeclaringSelectors();
  for (const forbidden of ['.usage-grid', '.usage-weeks', '.usage-months']) {
    assert.ok(
      !declarers.includes(forbidden),
      `--usage-cols is declared on ${forbidden}: the month row is a sibling of the grids, not a descendant of them, so it would never see the value`,
    );
  }
});

test('the three rows share one fractional column rhythm, not fixed pixels', () => {
  // The whole of defect 2 in one assertion. A pixel track cannot know the card's
  // width; `minmax(0, 1fr)` cannot get it wrong. All three must agree or the
  // labels stop lining up with the cells.
  for (const selector of ['.usage-grid', '.usage-weeks', '.usage-months']) {
    const body = bodiesOf(selector);
    assert.match(
      body,
      /grid-template-columns:\s*repeat\(var\(--usage-cols\),\s*minmax\(0,\s*1fr\)\)/,
      `${selector} must lay out its columns as fractions of the card, not as fixed tracks: a fixed track is a claim about available width, and the claim was wrong at the panel's own rung`,
    );
    assert.doesNotMatch(
      body,
      /grid-auto-columns:\s*(\d|var\(--usage-cell\))/,
      `${selector} still sizes columns by a literal or by --usage-cell; that is the rule that let 53 fixed columns overrun the card`,
    );
    assert.doesNotMatch(
      body,
      /width:\s*fit-content/,
      `${selector} must take the card's width. \`fit-content\` is what let the grid grow past the border instead of fitting inside it`,
    );
  }
});

test('a cell keeps its square shape while its column narrows', () => {
  // The tracks are fractions now, so the cell's size is decided by the column it
  // lands in and the row has to follow — `height: 100%` would have the row's
  // `auto` height resolve against a percentage of nothing.
  const cell = bodiesOf('.usage-cell');
  assert.match(cell, /aspect-ratio:\s*1/, '.usage-cell must derive its height from its width');
  assert.doesNotMatch(
    cell,
    /height:\s*100%/,
    '.usage-cell: a percentage height against an auto-sized row collapses the cell',
  );
});

test('the column count is the one the grid actually produces', () => {
  // `--usage-cols` is a constant that has to match a number computed elsewhere,
  // which is the kind of pair that drifts. It is 53 because `buildDailyGrid`
  // always emits 371 cells — 365 days plus the padding out to Saturday — and
  // 371 / 7 = 53. Asserting it against the real function means a change to
  // `WINDOW_DAYS` fails here, beside the number that would have to change with
  // it, rather than silently overflowing the card again.
  const grid = buildDailyGrid([], new Date(2026, 9, 25));
  const cells = grid.weeks.flatMap((week) => week.cells);
  assert.equal(cells.length, grid.weeks.length * 7, 'every column holds exactly seven rows');
  assert.equal(cells.length, 371, 'a year plus the padding to Saturday');

  const declared = /--usage-cols:\s*(\d+)/.exec(bodiesOf('.usage-activity'));
  assert.ok(declared, '--usage-cols must be a literal the grid can be checked against');
  assert.equal(
    Number(declared![1]),
    grid.weeks.length,
    `--usage-cols is ${declared![1]} but the grid draws ${grid.weeks.length} columns; the tracks and the cells must be the same count or the grid overruns its card`,
  );
});
