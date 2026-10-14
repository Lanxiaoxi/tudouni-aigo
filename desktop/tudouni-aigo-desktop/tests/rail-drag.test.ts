/**
 * The two rails' dragged widths: the geometry, the clamp, and the stylesheet
 * wiring that carries a dragged value.
 *
 * This is the desktop's one *new* piece of behaviour here, and every part of it
 * is invisible in a rendered string:
 *
 *   - **The drag's sign.** Both handles sit on their rail's inner edge and
 *     outward must widen. That reads as `startW + dx` in both cases and is
 *     wrong for one of them — the right rail shipped that way once, and the
 *     left rail is its mirror image. `draggedRailWidth` is asserted from both
 *     sides so the pair cannot silently collapse into one expression.
 *   - **The clamp.** The store's own range is what the drag, the value read
 *     back from `localStorage`, and any future caller all land in. A rail that
 *     remembered a width outside it would survive a range change.
 *   - **`null` means "the stylesheet's default".** Double-click is the reset;
 *     a `0`, a `NaN` or a stale number slipping through as "a width" would pin
 *     the rail to something the stylesheet never chose.
 *   - **The two rails are independent.** One field each: dragging one must not
 *     move the other, and `resizing` names *which* rail is being dragged, or
 *     the other one's handle lights up for a gesture it is not part of.
 *
 * The stylesheet half is read as text, the way `stream-layout.test.ts` reads
 * its rules: the declarations have no behaviour to observe in Node, and what is
 * being protected is their *presence* — a `var(--rail-w-dragged, <default>)` on
 * each rail, in the base rule and in the narrow-window fallback, plus the left
 * rail's handle anchored on its inner (right) edge.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { draggedRailWidth } from '@/railWidth';
import { clampRailWidth, RAIL_MAX, RAIL_MIN, useApp } from '@/state/store';

// Resolved from the project root, not from `import.meta.url`: the tests are
// bundled into `.test-build/` before they run, so a path relative to this module
// would point inside the build directory. The runner sets `cwd` to the root.
const globalCss = readFileSync(resolve(process.cwd(), 'src', 'styles', 'global.css'), 'utf8');

/* ============================================================
   The geometry: which way is wider
   ============================================================ */

test('dragging either rail outward widens it', () => {
  const start = 300;

  // The right rail's handle is on its **left** edge: outward is leftward, so a
  // pointer moving left (a negative travel) is what makes it wider.
  assert.equal(
    draggedRailWidth('right', start, -40),
    start + 40,
    'the right rail must widen when its inner edge is pulled left',
  );
  assert.equal(
    draggedRailWidth('right', start, 40),
    start - 40,
    'the right rail must narrow when its inner edge is pushed right',
  );

  // The left rail's handle is on its **right** edge: outward is rightward.
  assert.equal(
    draggedRailWidth('left', start, 40),
    start + 40,
    'the left rail must widen when its inner edge is pulled right',
  );
  assert.equal(
    draggedRailWidth('left', start, -40),
    start - 40,
    'the left rail must narrow when its inner edge is pushed left',
  );
});

test('the two rails are mirror images, not the same expression', () => {
  // The failure this pins: one sign copied to both rails. `startW + dx` is the
  // correct right-edge geometry, so it is exactly what a copy-paste onto the
  // right rail produces — and then pulling the rail wider narrows it, which on
  // screen looks like a rail that resists the pointer rather than a bug.
  const travel = 25;
  assert.notEqual(
    draggedRailWidth('left', 300, travel),
    draggedRailWidth('right', 300, travel),
    'a shared sign would make one of the two rails resize backwards',
  );
});

test('a drag with no travel leaves the width where it was', () => {
  for (const rail of ['left', 'right'] as const) {
    assert.equal(draggedRailWidth(rail, 260, 0), 260);
  }
});

/* ============================================================
   The store: the clamp, the reset, and the two fields
   ============================================================ */

test('a dragged width is clamped into the shared range', () => {
  assert.equal(clampRailWidth(RAIL_MIN - 80), RAIL_MIN);
  assert.equal(clampRailWidth(RAIL_MAX + 80), RAIL_MAX);
  assert.equal(clampRailWidth(300), 300);
  // Non-finite input cannot become a width: it lands on the floor rather than
  // being stored as `NaN` and freezing the rail at whatever CSS does with it.
  assert.equal(clampRailWidth(Number.NaN), RAIL_MIN);
});

test("the left rail's width clamps, and null hands it back to the stylesheet", () => {
  const restore = useApp.getState();
  try {
    const set = (px: number | null) => useApp.getState().setLeftbarWidth(px);

    set(RAIL_MAX + 80);
    assert.equal(useApp.getState().leftbarWidth, RAIL_MAX);
    set(RAIL_MIN - 80);
    assert.equal(useApp.getState().leftbarWidth, RAIL_MIN);
    set(300);
    assert.equal(useApp.getState().leftbarWidth, 300);

    // Double-click: the width goes back to the stylesheet's own default,
    // including the narrow-window fallback — which is why this has to be
    // `null` and not a number the front end picked.
    set(null);
    assert.equal(useApp.getState().leftbarWidth, null);
  } finally {
    useApp.setState({ leftbarWidth: restore.leftbarWidth });
  }
});

test("the right rail's width is its own field, not the left rail's", () => {
  const restore = useApp.getState();
  try {
    // The report this guards: "I widened the sidebar and the other one moved".
    // One field shared by two rails would drag both from either handle.
    useApp.getState().setLeftbarWidth(300);
    useApp.getState().setSidebarWidth(360);

    assert.equal(useApp.getState().leftbarWidth, 300);
    assert.equal(useApp.getState().sidebarWidth, 360);

    useApp.getState().setLeftbarWidth(null);
    assert.equal(useApp.getState().leftbarWidth, null);
    assert.equal(
      useApp.getState().sidebarWidth,
      360,
      'resetting the left rail must not reset the right one',
    );
  } finally {
    useApp.setState({
      leftbarWidth: restore.leftbarWidth,
      sidebarWidth: restore.sidebarWidth,
    });
  }
});

test('a live drag names its rail, and stops naming anything when it ends', () => {
  const restore = useApp.getState();
  try {
    // `resizing` is what puts `is-resizing` on one rail only: the dragged one
    // drops its width transition, and its handle paints. A shared boolean would
    // light up the *other* rail's handle ("both stripes glow while I drag one").
    useApp.setState({ resizing: 'left' });
    assert.equal(useApp.getState().resizing, 'left');

    useApp.setState({ resizing: 'right' });
    assert.equal(useApp.getState().resizing, 'right');

    useApp.setState({ resizing: null });
    assert.equal(useApp.getState().resizing, null);
  } finally {
    useApp.setState({ resizing: restore.resizing });
  }
});

/* ============================================================
   The stylesheet wiring
   ============================================================ */

test('both rails take a dragged width through the same custom property', () => {
  // The base rules. `var(--rail-w-dragged, <default>)` is the whole mechanism:
  // `App.tsx` writes the variable on the rail element itself, so one name
  // shared by two rails resolves per element and is not a collision — while the
  // fallback keeps the stylesheet owning the default until somebody drags.
  for (const [selector, fallback] of [
    ['.app-rail-left', '244px'],
    ['.app-rail-right', '268px'],
  ] as const) {
    const body = ruleBody(selector);
    assert.ok(body !== null, `${selector} is gone from global.css`);
    assert.match(
      body,
      new RegExp(`--rail-w:\\s*var\\(--rail-w-dragged,\\s*${fallback.replace('.', '\\.')}\\)`),
      `${selector} must read a dragged width with its own ${fallback} fallback`,
    );
  }
});

test('the narrow-window fallback keeps a dragged width too', () => {
  // Below 1180px the rails have narrower defaults, and a width the person chose
  // is not suspended by the window getting narrower — so the override has the
  // same `var(..., fallback)` shape rather than a bare length. A bare length
  // would silently throw the dragged width away on a resize, which reads as
  // "my sidebar reset itself".
  const media = mediaBody('(max-width: 1180px)');
  assert.ok(media !== null, 'the 1180px media query is gone from global.css');

  assert.match(media, /--rail-w:\s*var\(--rail-w-dragged,\s*236px\)/, 'the right rail lost it');
  assert.match(media, /--rail-w:\s*var\(--rail-w-dragged,\s*216px\)/, 'the left rail lost it');
});

test("the left rail's handle is anchored on its inner (right) edge", () => {
  // `.rail-drag` defaults to `left: 0` — the right rail's geometry. The left
  // rail's inner edge is its right one, and without the override the strip
  // would sit against the window's outer edge, where dragging it does nothing
  // a person can connect to the rail's width.
  const body = ruleBody('.app-rail-left .rail-drag');
  assert.ok(body !== null, 'the left rail handle positioning rule is gone from global.css');
  assert.match(body, /right:\s*0/, 'the left rail handle must anchor to its right edge');
  assert.match(body, /left:\s*auto/, '`left: 0` must be switched off, not merely overridden');
});

/* ============================================================
   Reading the stylesheet
   ============================================================ */

/** The declarations of one rule, as written. Naive by design — see
 *  `stream-layout.test.ts`, which reads `app.css` the same way and for the same
 *  reason: the stylesheets have no nesting inside a rule, and a real CSS parser
 *  would be a dependency taken on to read a few lines a human wrote by hand. */
function ruleBody(selector: string): string | null {
  const at = globalCss.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = globalCss.indexOf('{', at);
  const close = globalCss.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return globalCss.slice(open + 1, close);
}

/** The same, for the inside of an at-rule block: finds `@media <query> {` and
 *  reads to its matching `}`, which is the last one before the next top-level
 *  rule. The stylesheets keep every `@media` block un-nested. */
function mediaBody(query: string): string | null {
  const at = globalCss.indexOf(`@media ${query} {`);
  if (at < 0) return null;
  const open = globalCss.indexOf('{', at);
  const close = globalCss.indexOf('\n}', open);
  if (open < 0 || close < 0) return null;
  return globalCss.slice(open + 1, close);
}
