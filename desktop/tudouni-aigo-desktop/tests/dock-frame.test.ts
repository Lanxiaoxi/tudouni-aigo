/**
 * The Dock belongs to the window's frame, not to the rails' row.
 *
 * This is a regression guard for a layout defect that no type check and no
 * rendered string can show: the dock was the fourth flex item inside
 * `.app-main`, which is the row the two rails sit in — so the top bar and the
 * status bar spanned the *whole window* and therefore ran on underneath the
 * dock. What a person saw was the help/palette pair disappearing behind the
 * dock's head, and the status bar's readings continuing under its terminal
 * area.
 *
 * The fix is structural: the dock became a sibling of the entire app body
 * (`.app-body` > `.app-shell` + the dock), so both horizontal bars stop at the
 * dock's left edge and the dock owns its own top and bottom.
 *
 * **Read as source text**, the way `dock-budget.test.ts` and
 * `stream-layout.test.ts` read their stylesheets: what is being protected is
 * where an element sits in the tree and one declaration's presence, neither of
 * which has runtime behaviour observable in Node. A DOM assertion would need a
 * browser to say the same thing less clearly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const app = read('src/App.tsx');
const globalCss = read('src/styles/global.css');
const appCss = read('src/styles/app.css');
const dockCss = read('src/styles/components/dock.css');
const tokensCss = read('src/styles/tokens.css');

/** A rule's declarations, as written. Naive on purpose: this CSS is hand-written
 *  and flat, and a parser dependency to read twenty lines is not a trade. */
function ruleBody(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

/* ------------------------------------------------------------------ */
/* Where the dock sits in the tree                                     */
/* ------------------------------------------------------------------ */

test('the dock is a sibling of the app body, not an item in the rails row', () => {
  // `.app-main` starts the rails' row and ends before `<StatusBar />`; the dock
  // must not be inside that span. Both landmarks are asserted first, so a
  // rename makes this fail loudly instead of passing on an empty slice.
  const mainOpen = app.indexOf('<div className="app-main">');
  const statusBar = app.indexOf('<StatusBar />');
  assert.ok(mainOpen > 0, 'the `.app-main` wrapper is gone from App.tsx');
  assert.ok(statusBar > mainOpen, '`<StatusBar />` no longer follows `.app-main`');

  const insideMain = app.slice(mainOpen, statusBar);
  assert.ok(
    !insideMain.includes('<DockColumn'),
    'the Dock is inside `.app-main` again, so the top bar and the status bar ' +
      'span the whole window and run underneath it — see `.app-body` in global.css',
  );

  const bodyOpen = app.indexOf('<div className="app-body">');
  const shellOpen = app.indexOf('<div className="app-shell">');
  const dockUse = app.indexOf('<DockColumn');
  assert.ok(bodyOpen > 0, 'the `.app-body` wrapper is gone from App.tsx');
  assert.ok(shellOpen > bodyOpen, '`.app-shell` is not inside `.app-body`');
  assert.ok(dockUse > shellOpen, 'the Dock is not inside `.app-body`');
});

test('the two horizontal bars are inside the app shell, so they stop at the dock', () => {
  // Both bars have to live in `.app-shell` (the left column) for the dock to be
  // outside their width. A bar lifted back up to `.app` would span the window.
  const shellOpen = app.indexOf('<div className="app-shell">');
  const shellClose = app.indexOf('<StatusBar />');
  assert.ok(shellOpen > 0 && shellClose > shellOpen, 'cannot locate `.app-shell`');

  const shell = app.slice(shellOpen, shellClose);
  assert.match(shell, /<TopBar \/>/, 'the top bar left the app shell, so it spans the window again');
});

/* ------------------------------------------------------------------ */
/* The frame the dock is placed in                                     */
/* ------------------------------------------------------------------ */

test('.app-body is the positioning box a floating dock is measured against', () => {
  // The overlay form is absolutely positioned. Its containing block has to be
  // the band between the two bars, which is `.app-body` — not `.app-main`
  // (which would leave the floating dock under both bars) and not `.app`.
  const body = ruleBody(globalCss, '.app-body');
  assert.ok(body !== null, 'the `.app-body` rule is gone from global.css');
  assert.match(body, /position:\s*relative/, '`.app-body` must be the floating dock\'s containing block');
  assert.match(body, /display:\s*flex/, '`.app-body` is the row: app shell + dock');

  // And it is the *only* one: a second `position: relative` on `.app-main` would
  // silently win for a dock placed back inside it.
  const main = ruleBody(globalCss, '.app-main');
  assert.ok(main !== null, 'the `.app-main` rule is gone from global.css');
  assert.doesNotMatch(
    main,
    /position:\s*relative/,
    '`.app-main` is a containing block again; the floating dock anchors to it ' +
      'and the chrome bars are back over its head',
  );
});

test('a floating dock sits between the two bars, never over them', () => {
  const overlay = ruleBody(dockCss, ".app-dock[data-placement='overlay']");
  assert.ok(overlay !== null, "the overlay placement rule is gone from dock.css");

  // Inset by the bars' own heights as tokens, not by 0 and not by literals.
  // At `top: 0` the floating dock covers the top bar — including the master
  // switch that closes it, which is the one control that must stay reachable.
  assert.match(overlay, /top:\s*var\(--topbar-h\)/, 'the floating dock starts at the top bar\'s edge');
  assert.match(overlay, /bottom:\s*var\(--statusbar-h\)/, 'and ends at the status bar\'s edge');
  assert.doesNotMatch(overlay, /top:\s*0\b/, 'a floating dock at `top: 0` covers its own master switch');
});

/* ------------------------------------------------------------------ */
/* One height, one place                                               */
/* ------------------------------------------------------------------ */

test('the three bar heights are tokens, and every reader uses the token', () => {
  // The overlay insets are the same numbers the bars draw themselves at. Two
  // copies of a height is the kind of pair that drifts one change apart, and the
  // symptom (a 4px sliver of top bar visible above a floating dock) is invisible
  // in every test but one that compares the two.
  for (const [name, px] of [
    ['--titlebar-h', '36px'],
    ['--topbar-h', '42px'],
    ['--statusbar-h', '26px'],
  ]) {
    assert.match(tokensCss, new RegExp(`${name}:\\s*${px}`), `${name} is not ${px} in tokens.css`);
  }

  const titlebar = ruleBody(appCss, '.titlebar');
  const topbar = ruleBody(appCss, '.topbar');
  const statusbar = ruleBody(appCss, '.statusbar');
  assert.ok(titlebar && topbar && statusbar, 'a chrome bar rule is gone from app.css');
  assert.match(titlebar, /height:\s*var\(--titlebar-h\)/);
  assert.match(topbar, /height:\s*var\(--topbar-h\)/);
  assert.match(statusbar, /height:\s*var\(--statusbar-h\)/);
});
