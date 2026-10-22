/**
 * The plus menu's second page scrolls.
 *
 * **What was wrong.** The menu is a `max-height: 320px` flex column, and the
 * skills page was a bare `<div>` holding a `.plus-menu-list`. As a flex item
 * that div defaults to `min-height: auto` and `overflow: visible`, so it — and
 * the list inside it — sized themselves to their **content**: measured in a
 * browser with a 24-skill catalogue, the list was 776px tall inside a 318px
 * menu. The menu's own `overflow: hidden` clipped the rest, and because the list
 * itself never overflowed, `.plus-menu-list`'s `overflow: auto` never engaged.
 * So there was no scrollbar, the wheel moved nothing, and `list.scrollTop = 500`
 * left it at 0: the rows below the fold were unreachable — not merely unstyled.
 *
 * Two things are therefore pinned, and they are the two halves of one bug:
 *
 *   1. the **stylesheet** gives the page container the shrink-container
 *      declarations (`min-height: 0` is the load-bearing one — with it the div
 *      is compressed into the menu and hands the overflow to the list);
 *   2. the **markup** gives every page that container. `.plus-menu-list` only
 *      works as a direct child of the flex column (the root page is one, and it
 *      was always fine); one `<div>` deeper and it needs the wrapper.
 *
 * The comment in `palette.css` carries the measurement; this file is what makes
 * someone read it before deleting the wrapper as redundant.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Resolved from the project root, not `import.meta.url`: the runner bundles the
// tests into `.test-build/` first, so a module-relative path would look for the
// sources inside the build directory.
const root = process.cwd();
const palette = readFileSync(resolve(root, 'src/styles/components/palette.css'), 'utf8');
const plusMenu = readFileSync(resolve(root, 'src/components/chrome/PlusMenu.tsx'), 'utf8');

/** The declarations of one rule, as written (same naive reader as stream-layout). */
function ruleBody(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

test('the menu page is a shrink container, not a block that grows to its content', () => {
  const page = ruleBody(palette, '.plus-menu-page');
  assert.ok(page !== null, 'the `.plus-menu-page` rule is gone from palette.css');

  // The declaration the bug turned on. Without it the container is `auto`-sized
  // and the list's `overflow: auto` has nothing to scroll — it is laid out at its
  // full content height and clipped by the menu.
  assert.match(
    page,
    /min-height:\s*0/,
    '`.plus-menu-page` must declare `min-height: 0`: a flex item defaults to ' +
      '`min-height: auto`, which is exactly what made the skills list size itself ' +
      'to its content (776px) inside a 320px menu and never scroll',
  );
  // It has to be a column either way — the back row above, the list below.
  assert.match(page, /display:\s*flex/, '`.plus-menu-page` must lay its row and list out as a column');
  assert.match(page, /flex-direction:\s*column/, '`.plus-menu-page` must be a column');
});

test('the list keeps the two declarations that make it scrollable at all', () => {
  const list = ruleBody(palette, '.plus-menu-list');
  assert.ok(list !== null, 'the `.plus-menu-list` rule is gone from palette.css');
  assert.match(list, /overflow:\s*auto/, '`.plus-menu-list` must scroll rather than grow');
  // Same reason as the page: without it the list refuses to be smaller than its
  // rows and the parent cannot compress it.
  assert.match(list, /min-height:\s*0/, '`.plus-menu-list` must be allowed to be shorter than its rows');
});

test('every page that puts the list under a wrapper uses the shrink container', () => {
  // A page's outer container must not be a bare `<div>`. That is precisely the
  // shape the skills page shipped in, and it looks like ordinary markup — which
  // is why it needs asserting rather than remembering.
  assert.doesNotMatch(
    plusMenu,
    /<div>\s*\n\s*<MenuBack/,
    'a plus-menu page is wrapped in a bare `<div>`, which is not a shrink ' +
      'container: its list will grow to its content and never scroll. Use ' +
      '`className="plus-menu-page"`',
  );

  // And every subpage carries one, so a page added later cannot inherit the bug
  // by copy-pasting an older page's markup. A subpage is recognisable by its
  // `MenuBack` row, which is the first thing it renders.
  const wrappers = (plusMenu.match(/className="plus-menu-page"/g) ?? []).length;
  const subpages = (plusMenu.match(/<MenuBack/g) ?? []).length;
  assert.ok(subpages > 0, 'no subpage found: this test is looking for the wrong markup');
  assert.ok(
    wrappers >= subpages,
    `${subpages} subpage(s) but only ${wrappers} \`.plus-menu-page\` wrapper(s): ` +
      'a subpage without one puts its list in a content-sized block, which never scrolls',
  );
});

test('the root page still renders its list directly, which is why it always worked', () => {
  // Not a style preference: `.plus-menu-list` is a flex child of `.plus-menu`
  // there, so it inherits the menu's height and its `min-height: 0` from the
  // list's own rule. Adding a wrapper here would be harmless but the asymmetry is
  // worth stating, because "why is this one different?" is the question that
  // produced the original mistake.
  const rootPage = plusMenu.slice(
    plusMenu.indexOf('function RootPage'),
    plusMenu.indexOf('/* ---------------- The file page'),
  );
  assert.ok(rootPage.includes('plus-menu-list'), 'RootPage no longer renders a list');
  assert.ok(
    !rootPage.includes('plus-menu-page'),
    'RootPage grew a wrapper: harmless, but update this test and the note in palette.css',
  );
});
