/**
 * The dock opens outward: the window grows past its right edge by the dock's
 * width, and closing the dock takes the growth back off. These are the cases a
 * person only meets at a screen edge, so they are asserted here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planGrowth, planShrink } from '@/state/workspaceDock/windowGrowth';

const SCREEN = { x: 0, width: 2560 };

test('room on the right: the window keeps its left edge and grows by the dock', () => {
  assert.deepEqual(
    planGrowth({ window: { x: 200, width: 1280 }, workArea: SCREEN, extra: 560, maximized: false }),
    { x: 200, width: 1840 },
  );
});

test('against the right edge: it slides left only by what the edge cannot give', () => {
  assert.deepEqual(
    planGrowth({ window: { x: 1200, width: 1280 }, workArea: SCREEN, extra: 560, maximized: false }),
    { x: 720, width: 1840 },
  );
});

test('a second monitor: the work area offset is respected', () => {
  assert.deepEqual(
    planGrowth({ window: { x: 2700, width: 1280 }, workArea: { x: 2560, width: 1920 }, extra: 560, maximized: false }),
    { x: 2640, width: 1840 },
  );
});

test('maximized, or a screen that cannot hold both: no growth (the dock opens inward)', () => {
  assert.equal(planGrowth({ window: { x: 0, width: 1280 }, workArea: SCREEN, extra: 560, maximized: true }), null);
  assert.equal(
    planGrowth({ window: { x: 0, width: 1600 }, workArea: { x: 0, width: 1920 }, extra: 560, maximized: false }),
    null,
  );
  assert.equal(planGrowth({ window: { x: 0, width: 1280 }, workArea: SCREEN, extra: 0, maximized: false }), null);
});

test('closing an untouched dock puts the window back exactly', () => {
  const growth = { before: { x: 1200, width: 1280 }, after: { x: 720, width: 1840 } };
  assert.deepEqual(planShrink(growth, { x: 720, width: 1840 }, 960), { x: 1200, width: 1280 });
});

test('a window the person moved or resized since: only the growth comes off, at their left edge', () => {
  const growth = { before: { x: 200, width: 1280 }, after: { x: 200, width: 1840 } };
  assert.deepEqual(planShrink(growth, { x: 50, width: 2000 }, 960), { x: 50, width: 1440 });
  // Never below the window's minimum width.
  assert.deepEqual(planShrink(growth, { x: 50, width: 1200 }, 960), { x: 50, width: 960 });
  assert.equal(planShrink(growth, { x: 50, width: 960 }, 960), null);
});
