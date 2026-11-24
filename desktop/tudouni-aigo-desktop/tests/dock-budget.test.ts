/**
 * The Workspace Dock's space budget (docs/design/workspace-dock.md §2.1, §2.2).
 *
 * The failure here is invisible in every way but one: a window of exactly the
 * wrong width. "The conversation was squeezed to 480px" does not show in a
 * rendered string or a type check, so the rules are asserted at the sizes that
 * matter, and as a property over a whole range of windows.
 *
 * The stylesheet half is read as text (the way `rail-drag.test.ts` does): the
 * budget restates the rails' default widths because the stylesheet owns them,
 * and two copies of a number are only honest while something compares them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONVERSATION_MIN,
  DOCK_DEFAULT,
  DOCK_DUAL_MIN,
  DOCK_MAX,
  DOCK_MIN,
  NARROW_RAIL_BREAKPOINT,
  NAV_MAX,
  NAV_MIN,
  RAIL_DEFAULTS,
  TERM_MAX,
  TERM_MIN,
  clampDockNavWidth,
  clampDockTermHeight,
  clampDockWidth,
  navigatorRange,
  navigatorWidth,
  nominalRailWidth,
  planDockLayout,
  terminalHeight,
  terminalRange,
} from '@/state/workspaceDock/budget';

const base = { leftRailNarrow: null, preferredWidth: 780 };

test('the design example: 1280px, a 56px rail, no other panel leaves 664px', () => {
  const plan = planDockLayout({ ...base, windowWidth: 1280, leftRail: 56, rightRail: 0 });
  assert.equal(plan.placement, 'docked');
  assert.equal(plan.width, 664, 'min(preferred 780, available 664), not a forced 780');
  assert.equal(plan.dropRightRail, false);
});

test('a roomy window gives the dock exactly what was asked for', () => {
  const plan = planDockLayout({
    windowWidth: 1920,
    leftRail: 244,
    rightRail: 268,
    leftRailNarrow: null,
    preferredWidth: 600,
  });
  assert.equal(plan.placement, 'docked');
  assert.equal(plan.width, 600);
  assert.equal(plan.dropRightRail, false);
  assert.equal(plan.columns, 'dual');
});

test('degradation order: the session-info rail gives way before anything else', () => {
  // 1280 with both rails: 1280 - 244 - 268 - 560 = 208 < 320, so the dock does
  // not fit — but without the right rail 476 is available.
  const plan = planDockLayout({ ...base, windowWidth: 1280, leftRail: 244, rightRail: 268 });
  assert.equal(plan.placement, 'docked');
  assert.equal(plan.dropRightRail, true);
  assert.equal(plan.narrowLeftRail, false);
  assert.equal(plan.width, 1280 - 244 - CONVERSATION_MIN);
});

test('then the workspace rail narrows, when it has a narrow form', () => {
  const plan = planDockLayout({
    windowWidth: 1100,
    leftRail: 244,
    leftRailNarrow: 56,
    rightRail: 268,
    preferredWidth: 780,
  });
  // 1100 - 244 - 560 = 296 < 320, 1100 - 56 - 560 = 484 >= 320.
  assert.equal(plan.placement, 'docked');
  assert.equal(plan.dropRightRail, true);
  assert.equal(plan.narrowLeftRail, true);
  assert.equal(plan.width, 484);
});

test('without a narrow form the next step is the overlay, not a squeezed conversation', () => {
  const plan = planDockLayout({ ...base, windowWidth: 1100, leftRail: 244, rightRail: 268 });
  assert.equal(plan.placement, 'overlay');
  assert.equal(plan.dropRightRail, false, 'an overlay leaves the layout underneath as it was');
  assert.ok(plan.width >= DOCK_MIN);
  assert.ok(plan.width <= 1100 - 244, 'it may not cover the workspace rail');
});

test('the dock never leaves the conversation under 560px, at any window width', () => {
  for (let windowWidth = 640; windowWidth <= 2600; windowWidth += 7) {
    for (const preferredWidth of [320, 560, 780, 1000]) {
      for (const [leftRail, rightRail] of [
        [0, 0],
        [244, 268],
        [216, 236],
        [244, 0],
      ] as const) {
        const plan = planDockLayout({ windowWidth, leftRail, leftRailNarrow: null, rightRail, preferredWidth });
        if (plan.placement !== 'docked') continue;
        const right = plan.dropRightRail ? 0 : rightRail;
        const conversation = windowWidth - leftRail - right - plan.width;
        assert.ok(
          conversation >= CONVERSATION_MIN,
          `${windowWidth}px, rails ${leftRail}/${rightRail}, preferred ${preferredWidth}: conversation ${conversation}px`,
        );
        assert.ok(plan.width >= DOCK_MIN, 'a docked dock is never narrower than its minimum');
        assert.ok(plan.width <= preferredWidth || preferredWidth < DOCK_MIN, 'it never exceeds the preference');
      }
    }
  }
});

test('the layout is a function of the inputs: shrinking and regrowing the window loses nothing', () => {
  const input = { ...base, leftRail: 56, rightRail: 0 };
  const wide = planDockLayout({ ...input, windowWidth: 1600 });
  planDockLayout({ ...input, windowWidth: 900 });
  const wideAgain = planDockLayout({ ...input, windowWidth: 1600 });
  assert.deepEqual(wideAgain, wide);
  assert.equal(wide.width, 780, 'the preference came back untouched');
});

test('single column below 520px, two columns from 520px (§2.1)', () => {
  const at = (width: number) =>
    planDockLayout({
      windowWidth: 560 + width,
      leftRail: 0,
      leftRailNarrow: null,
      rightRail: 0,
      preferredWidth: width,
    }).columns;
  assert.equal(at(DOCK_MIN), 'single');
  assert.equal(at(DOCK_DUAL_MIN - 1), 'single');
  assert.equal(at(DOCK_DUAL_MIN), 'dual');
  assert.equal(at(760), 'dual');
});

test('an unusable window width falls into the overlay instead of NaN', () => {
  for (const windowWidth of [0, -1, Number.NaN]) {
    const plan = planDockLayout({ ...base, windowWidth, leftRail: 0, rightRail: 0 });
    assert.equal(plan.placement, 'overlay');
    assert.ok(Number.isFinite(plan.width) && plan.width >= DOCK_MIN);
  }
});

test('preference clamps: one range for the drag and for what is read back', () => {
  assert.equal(clampDockWidth(10), DOCK_MIN);
  assert.equal(clampDockWidth(99999), DOCK_MAX);
  assert.equal(clampDockWidth(Number.NaN), DOCK_MIN);
  assert.equal(clampDockWidth(500.6), 501);
  assert.equal(clampDockNavWidth(1), NAV_MIN);
  assert.equal(clampDockNavWidth(9999), NAV_MAX);
  assert.equal(clampDockTermHeight(1), TERM_MIN);
  assert.equal(clampDockTermHeight(9999), TERM_MAX);
});

test('the navigator always leaves the viewer its floor', () => {
  assert.deepEqual(navigatorRange(320), { min: NAV_MIN, max: NAV_MIN });
  assert.equal(navigatorRange(760).max, NAV_MAX);
  assert.equal(navigatorWidth(null, 760), 240, 'no preference: the default');
  assert.equal(navigatorWidth(480, 560), 560 - 240 - 1, 'a wide preference is clamped by a narrow dock');
  assert.equal(navigatorWidth(480, 760), 480, 'and comes back when the dock widens');
});

test('the terminal always leaves the upper half its floor, unless the dock is too short for both', () => {
  assert.equal(terminalRange(1400).max, TERM_MAX, 'a tall dock is capped by the ceiling');
  assert.equal(terminalRange(900).max, 900 - 36 - 160 - 1, 'a shorter one by the upper half\'s floor');
  assert.equal(terminalRange(600).max, 600 - 36 - 160 - 1);
  assert.equal(terminalRange(200).max, TERM_MIN, 'a usable shell beats a usable preview');
  assert.equal(terminalHeight(null, 900), 260, 'no preference: the default');
  assert.equal(terminalHeight(800, 500), terminalRange(500).max);
});

test('rails: a dragged width wins, otherwise the narrow default applies at or below the breakpoint', () => {
  assert.equal(nominalRailWidth('left', 300, 1920), 300);
  assert.equal(nominalRailWidth('right', null, 1920), RAIL_DEFAULTS.right.wide);
  assert.equal(nominalRailWidth('right', null, NARROW_RAIL_BREAKPOINT), RAIL_DEFAULTS.right.narrow);
  assert.equal(nominalRailWidth('left', null, NARROW_RAIL_BREAKPOINT + 1), RAIL_DEFAULTS.left.wide);
});

test('the rail defaults restated here are the ones global.css declares', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
  assert.match(css, new RegExp(`--rail-w: var\\(--rail-w-dragged, ${RAIL_DEFAULTS.left.wide}px\\)`));
  assert.match(css, new RegExp(`--rail-w: var\\(--rail-w-dragged, ${RAIL_DEFAULTS.right.wide}px\\)`));
  assert.match(css, new RegExp(`--rail-w: var\\(--rail-w-dragged, ${RAIL_DEFAULTS.left.narrow}px\\)`));
  assert.match(css, new RegExp(`--rail-w: var\\(--rail-w-dragged, ${RAIL_DEFAULTS.right.narrow}px\\)`));
  assert.match(css, new RegExp(`@media \\(max-width: ${NARROW_RAIL_BREAKPOINT}px\\)`));
});

test('the default preference is itself a legal width', () => {
  assert.equal(clampDockWidth(DOCK_DEFAULT), DOCK_DEFAULT);
});
