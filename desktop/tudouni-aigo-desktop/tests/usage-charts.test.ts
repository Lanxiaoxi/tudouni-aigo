import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelTrend,
  donutSlices,
  formatShare,
  trendTicks,
  OTHER_MODEL,
} from '@/components/panels/usageCharts';
import type { UsageDay } from '@/protocol/types';

/** A fixed "now" so the window's last day is assertable. */
const NOW = new Date(2026, 9, 25); // Sunday, Oct 25 2026 — local, like the ledger's days.

function byDay(entries: [day: string, models: Record<string, number>][]): UsageDay[] {
  return entries.map(([day, models]) => ({ day, tokens: Object.values(models).reduce((a, b) => a + b, 0), turns: 1, models }));
}

test('the window ends on today, is zero-filled, and skips unsplit days', () => {
  const trend = buildModelTrend(byDay([['2026-10-25', { 'm-a': 100 }]]), NOW, 7);
  // Seven days ending today, whatever the ledger recorded.
  assert.equal(trend.days.length, 7);
  assert.equal(trend.days[trend.days.length - 1], '2026-10-25');
  assert.equal(trend.days[0], '2026-10-19');
  // Every point of the range exists, and the six silent days sit at zero —
  // a silent day is a measurement, not a hole.
  assert.deepEqual(trend.series[0].points, [0, 0, 0, 0, 0, 0, 100]);
});

test('a day without a models split contributes nothing to the series', () => {
  const trend = buildModelTrend(
    byDay([
      ['2026-10-25', { 'm-a': 100 }],
      ['2026-10-24', {}],
    ]).map((entry, i) => (i === 1 ? { ...entry, models: undefined } : entry)),
    NOW,
    7,
  );
  assert.deepEqual(trend.series[0].points, [0, 0, 0, 0, 0, 0, 100]);
  // The total is the split's sum, never the day totals — one number with two
  // sources would be two answers to "how much".
  assert.equal(trend.total, 100);
});

test('series sort by total, largest first, and the y scale is the largest single point', () => {
  const trend = buildModelTrend(
    byDay([
      ['2026-10-24', { small: 10, big: 40 }],
      ['2026-10-25', { small: 100, big: 20 }],
    ]),
    NOW,
    7,
  );
  assert.deepEqual(trend.series.map((s) => s.model), ['small', 'big']);
  assert.equal(trend.series[0].total, 110);
  assert.equal(trend.series[1].total, 60);
  // The lines overlay rather than stack: the ceiling is the tallest single
  // point (small's 100), not the largest day total (130).
  assert.equal(trend.peakPoint, 100);
});

test('more than six models fold into one other series, everything beyond the fifth', () => {
  const entries: [string, Record<string, number>][] = [];
  for (let i = 1; i <= 8; i++) {
    entries.push(['2026-10-25', { [`m${i}`]: i * 10 }]);
  }
  const trend = buildModelTrend(byDay(entries), NOW, 7);
  assert.equal(trend.series.length, 6);
  assert.deepEqual(trend.series.slice(0, 5).map((s) => s.model), ['m8', 'm7', 'm6', 'm5', 'm4']);
  assert.equal(trend.series[5].model, OTHER_MODEL);
  // m1..m3 folded: 10 + 20 + 30.
  assert.equal(trend.series[5].total, 60);
  // Nothing lost in the fold.
  assert.equal(trend.total, 360);
});

test('donut slices are ordered, zero-free, and their shares sum to one', () => {
  const trend = buildModelTrend(
    byDay([
      ['2026-10-25', { big: 900, small: 100 }],
    ]),
    NOW,
    7,
  );
  const slices = donutSlices(trend);
  assert.deepEqual(slices.map((s) => s.model), ['big', 'small']);
  assert.equal(slices[0].share, 0.9);
  assert.equal(slices[1].share, 0.1);
  const sum = slices.reduce((acc, s) => acc + s.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `shares must sum to 1, got ${sum}`);
});

test('a range with nothing spent has no slices and a zero peak', () => {
  const trend = buildModelTrend([], NOW, 30);
  assert.equal(trend.total, 0);
  assert.equal(trend.peakPoint, 0);
  assert.deepEqual(donutSlices(trend), []);
});

test('shares print whole percents at ten and up, one decimal below', () => {
  assert.equal(formatShare(0.93), '93%');
  assert.equal(formatShare(0.073), '7.3%');
  assert.equal(formatShare(1), '100%');
});

test('x ticks label every day for the short range and every fifth plus the last for the long one', () => {
  assert.deepEqual(trendTicks(7), [0, 1, 2, 3, 4, 5, 6]);
  // 30 days: 0, 5, 10, 15, 20, 25 — then the last day, because a trend that
  // does not say where "now" is leaves its window unanchored.
  assert.deepEqual(trendTicks(30), [0, 5, 10, 15, 20, 25, 29]);
});
