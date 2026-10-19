/**
 * The welcome motto: one list, two front ends.
 *
 * The desktop shows the same line the TUI shows, on the same day. That is the
 * point of the feature and also its one failure mode: the list lives in two
 * files (`src/i18n/index.ts` here, `internal/i18n/en.go` in the runtime), and a
 * line edited in only one of them still renders — the screen just quietly stops
 * agreeing with the terminal. Nothing on screen would look wrong, which is why
 * the lists are compared here rather than trusted.
 *
 * The rotation is asserted too. Both sides divide the Unix day by 86,400 and
 * take `day % 15 + 1`; a front end that counted local midnights, or used a
 * zero-based index, would show a different line for part of the day. The TUI's
 * arithmetic is read from its source as text, because the thing being pinned is
 * the formula's *presence* — this suite cannot run Go.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { en, makeT, mottoOfDay } from '@/i18n';

// Resolved from the project root: the tests are bundled into `.test-build/`
// before they run. `cwd` is `desktop/tudouni-aigo-desktop`.
const runtimeI18n = readFileSync(
  resolve(process.cwd(), '..', '..', 'internal', 'i18n', 'en.go'),
  'utf8',
);
const tuiPanels = readFileSync(
  resolve(process.cwd(), '..', '..', 'internal', 'frontends', 'tui', 'panels.go'),
  'utf8',
);

/** The runtime's catalogue lines, by number. */
function runtimeMottos(): Map<number, string> {
  const found = new Map<number, string>();
  for (const line of runtimeI18n.split('\n')) {
    const match = line.match(/^\s*"motto\.(\d+)"\s*:\s*"([^"]*)",\s*$/);
    if (match) found.set(Number(match[1]), match[2]);
  }
  return found;
}

/** This front end's catalogue lines, by number — same shape, from `en`. */
function desktopMottos(): Map<number, string> {
  const found = new Map<number, string>();
  for (const [key, value] of Object.entries(en)) {
    const match = key.match(/^motto\.(\d+)$/);
    if (match) found.set(Number(match[1]), value);
  }
  return found;
}

test('both front ends carry the same motto, line for line', () => {
  assert.deepEqual(desktopMottos(), runtimeMottos());
});

test('the rotation is the TUI’s: Unix day, modulo 15, one-based', () => {
  assert.match(tuiPanels, /time\.Now\(\)\.Unix\(\)\s*\/\s*86_400/);
  assert.match(tuiPanels, /day%15\+1/);

  const day = 20_000; // any whole day; the assertion is about the formula
  const realNow = Date.now;
  Date.now = () => day * 86_400_000 + 12 * 3_600_000;
  try {
    assert.equal(
      mottoOfDay(makeT()),
      en[`motto.${(day % 15) + 1}` as keyof typeof en],
    );
  } finally {
    Date.now = realNow;
  }
});
