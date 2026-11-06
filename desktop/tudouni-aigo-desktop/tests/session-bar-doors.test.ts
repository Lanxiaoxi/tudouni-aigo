/**
 * The session bar draws its controls **once**, and both board doors are there.
 *
 * **What was wrong.** `SessionBar` had two `return`s — a placeholder for "no
 * handshake yet" and the real one — and each spelled the row's controls out by
 * hand. The Ticket board's door was added to the placeholder only, so it was on
 * screen for the moment before `init` and gone for the rest of the window's
 * life. With the left rail folded, the workbench row inside it is `inert`, so
 * the ticket board had **no reachable entrance at all** — a silent failure that
 * renders perfectly.
 *
 * A static render cannot catch that here: zustand answers a server render from
 * `getInitialState`, so a `setState` before `renderToStaticMarkup` is invisible
 * and the "a session is open" branch is unreachable from a test (the same
 * limitation `notice-center.test.tsx` states). What is asserted instead is the
 * **shape of the source**, which is where the bug lived: one shell, one place
 * per control, and the two doors distinguishable from each other.
 *
 * `render-check.mjs` covers the other half — that the pair is in the right
 * place and that each opens its own board — in a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Resolved from the project root, not `import.meta.url`: the runner bundles the
// tests into `.test-build/` first, so a module-relative path would look for the
// sources inside the build directory.
const root = process.cwd();
const bar = readFileSync(resolve(root, 'src/components/chrome/SessionBar.tsx'), 'utf8');
const app = readFileSync(resolve(root, 'src/styles/app.css'), 'utf8');

/** Every occurrence of `needle`, counted rather than merely found. */
const count = (needle: string) => bar.split(needle).length - 1;

test('the bar has one shell, so a new control cannot land in only one branch', () => {
  assert.equal(
    count('<div className="sessionbar">'),
    1,
    'the row is spelled out more than once: that is how the ticket door came to exist only before the handshake',
  );
  // The placeholder branch itself is gone. It is asserted by its signature — an
  // early return on "no session" — because that is the line that made the two
  // shells possible, and a new one would arrive the same way.
  assert.doesNotMatch(
    bar,
    /if \(!session\) \{/,
    'an early return on "no session" is back: the controls below it would be skipped until the handshake lands',
  );
  // Facts are the only thing the two states differ on, so they are the only
  // thing branched on.
  assert.match(bar, /const facts = session \? \(/, 'the facts branch is gone: the row is being duplicated again');
});

test('each control is rendered exactly once', () => {
  for (const anchor of ['{leftToggle}', '{boardButton}', '{ticketButton}', '{facts}', '{findButton}', '{rightToggle}']) {
    assert.equal(count(anchor), 1, `${anchor} is rendered ${count(anchor)} times: expected exactly one`);
  }
});

test('the ticket door is the session door with a second class, not a second kind of control', () => {
  // The pair is one square in one run: same size, same hover, same engaged
  // fill, same turn duration. Only the angle differs, so the two must share
  // `.sb-board` — a second base class would let the pair drift apart.
  assert.match(
    bar,
    /className=\{`sb-board sb-ticket\$\{board === 'tickets' \? ' is-active' : ''\}`\}/,
    'the ticket door no longer wears `.sb-board` + `.sb-ticket`',
  );
  // `aria-pressed` is per-board, not "is any board up": reading `board !== null`
  // would light both squares for one board.
  assert.match(
    bar,
    /aria-pressed=\{board === 'tickets'\}/,
    'the ticket door reports the wrong state',
  );
  assert.match(bar, /aria-pressed=\{sessionBoardOpen\}/, 'the session door reports the wrong state');
});

test('both doors pivot, each by its own glyph\'s angle', () => {
  // The pair shares one transition, so they move together; what differs is the
  // angle, and it is chosen per glyph rather than per control. The grid is
  // fourfold symmetric, so a quarter is the largest turn that leaves it reading
  // as itself; `lucide`'s Ticket has its notches on the left and right edges, so
  // a quarter would stand the stub on its end and a half is the opposite end of
  // that same symmetry.
  assert.match(
    app,
    /\.sessionbar \.sb-board svg \{[^}]*transition: transform var\(--motion-base\)/,
    'the shared turn transition is gone: a pair that animates at two speeds reads as two controls',
  );
  assert.match(
    app,
    /\.sessionbar \.sb-board\.is-active:not\(\.sb-ticket\) svg \{\s*transform: rotate\(90deg\);/,
    'the grid no longer turns a quarter',
  );
  assert.match(
    app,
    /\.sessionbar \.sb-board\.is-active\.sb-ticket svg \{\s*transform: rotate\(180deg\);/,
    'the ticket door no longer turns a half',
  );
  // Two `transform` declarations on one element resolve by source order rather
  // than adding up, so the two angles must be scoped apart, never both applied.
  const both = [...app.matchAll(/\.sessionbar \.sb-board\.is-active[^{]*\{[^}]*rotate\((\d+)deg\)/g)].map(
    (m) => m[0],
  );
  assert.equal(both.length, 2, 'expected exactly two engaged-angle rules');
  assert.ok(
    both.some((rule) => rule.includes(':not(.sb-ticket)')) &&
      both.some((rule) => rule.includes('.sb-ticket svg')),
    'the two angles are not scoped apart: one would silently win',
  );
  // And the engaged fill is shared by both doors, or the pair reads as two
  // different states of one thing.
  assert.match(
    app,
    /\.sessionbar \.sb-board\.is-active \{\s*background: var\(--accent-subtle\);/,
    'the engaged fill no longer covers both board doors',
  );
});

test('the ticket gate is `blocked` alone, because tickets outlive sessions', () => {
  // The session door asks for a live child (`!boardAvailable && !boardOpen`);
  // the ticket door must not, or the list that says what to start next is
  // unopenable exactly when nothing is running.
  const ticket = bar.slice(bar.indexOf('const ticketButton'));
  assert.match(ticket.slice(0, ticket.indexOf('</Tip>')), /disabled=\{blocked\}/);
});
