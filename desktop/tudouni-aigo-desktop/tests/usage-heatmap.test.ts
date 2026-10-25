import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyGrid, buildWeeklyBuckets, dayLabel } from '@/components/panels/usageHeatmap';
import type { UsageDay } from '@/protocol/types';

/** A fixed "now" so the grid's window and today's column are assertable. */
const NOW = new Date(2026, 9, 25); // Sunday, Oct 25 2026 — local, like the ledger's days.

function byDay(entries: [string, number, number][]): UsageDay[] {
  return entries.map(([day, tokens, turns]) => ({ day, tokens, turns }));
}

test('the grid ends on today and pads its column with future cells', () => {
  const grid = buildDailyGrid(byDay([['2026-10-25', 100, 1]]), NOW);
  const last = grid.weeks[grid.weeks.length - 1].cells;

  // Oct 25 2026 is a Sunday, so today's column is the last one and its six
  // following cells are future padding — seven rows, only the first real.
  assert.equal(last[0].day, '2026-10-25');
  assert.equal(last[0].future, false);
  for (let i = 1; i < 7; i++) {
    assert.equal(last[i].future, true, `row ${i} of today's column is future padding`);
  }
  // Every column has seven rows, whatever day the window starts on.
  for (const week of grid.weeks) {
    assert.equal(week.cells.length, 7);
  }
});

test('the window is 365 days and unrecorded days are level 0, not missing', () => {
  const grid = buildDailyGrid(byDay([['2026-10-25', 100, 1]]), NOW);
  const cells = grid.weeks.flatMap((week) => week.cells);
  // 366 columns' worth of cells at most (365 days + padding); exactly 365
  // non-future ones.
  const real = cells.filter((cell) => !cell.future);
  assert.equal(real.length, 365);
  // A day with no record draws as empty — present, level 0 — rather than
  // being skipped: a hole in the grid would read as data the runtime lost.
  const first = real[0];
  assert.equal(first.tokens, 0);
  assert.equal(first.level, 0);
});

test('the ramp follows the quartiles of the non-zero days', () => {
  // Ten days: one at 10, one at 20, … one at 100. The quartile thresholds of
  // the non-zero tokens are 32.5 / 55 / 77.5, so 30 lands at level 1, 50 at 2,
  // 70 at 3, and 100 at 4.
  const entries: [string, number, number][] = [];
  for (let i = 1; i <= 10; i++) {
    entries.push([`2026-10-${10 + i}`, i * 10, 1]);
  }
  const grid = buildDailyGrid(byDay(entries), NOW);
  const byTokens = new Map(grid.weeks.flatMap((w) => w.cells).map((cell) => [cell.tokens, cell.level]));
  assert.equal(byTokens.get(10), 1);
  assert.equal(byTokens.get(30), 1);
  assert.equal(byTokens.get(50), 2);
  assert.equal(byTokens.get(70), 3);
  assert.equal(byTokens.get(100), 4);
});

test('a month label lands on the column that starts it, and a month mostly outside the window gets none', () => {
  const grid = buildDailyGrid([], NOW);
  const labels = new Map(grid.months.map((month) => [month.column, month.label]));
  // The window starts 364 days before Oct 25 2026 — around Oct 26 2025 — so
  // the first column begins mid-October 2025 and October gets no label there.
  assert.equal(labels.get(0), undefined);
  // November 2025 begins within the first weeks, and its column carries the
  // label.
  const november = grid.months.find((month) => month.label === 'Nov');
  assert.ok(november, 'November is labelled');
  const firstCell = grid.weeks[november!.column].cells[0].day;
  assert.ok(firstCell.startsWith('2025-11'), `Nov's column starts in November, got ${firstCell}`);
});

test('weekly buckets merge a Sunday-started week into one cell', () => {
  // Sat Oct 24 and Sun Oct 25 are different weeks; Mon Oct 19 … Sat Oct 24
  // share the week of Sunday Oct 18.
  const buckets = buildWeeklyBuckets(
    byDay([
      ['2026-10-19', 10, 1],
      ['2026-10-24', 20, 1],
      ['2026-10-25', 40, 2],
    ]),
    NOW,
  );
  const weekOf18 = buckets.find((bucket) => bucket.week === '2026-10-18');
  assert.ok(weekOf18, 'the week of Sunday Oct 18 exists');
  assert.equal(weekOf18!.tokens, 30);
  assert.equal(weekOf18!.turns, 2);
  // Today is a Sunday: its week holds only today, and the last bucket ends there.
  const last = buckets[buckets.length - 1];
  assert.equal(last.week, '2026-10-25');
  assert.equal(last.tokens, 40);
});

test('dayLabel says the ledger day the way the interface says dates', () => {
  assert.equal(dayLabel('2026-10-25'), 'Oct 25, 2026');
  assert.equal(dayLabel('2025-01-02'), 'Jan 2, 2025');
});
