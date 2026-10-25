import type { UsageDay } from '@/protocol/types';

/**
 * The usage heatmap's date math, as pure functions.
 *
 * Kept out of the component for the usual two reasons: the grid is tedious
 * enough that its edge cases (a window that starts mid-week, a leap February,
 * a day whose record landed after midnight) deserve to be testable, and the
 * component should draw what these functions decided rather than make
 * decisions of its own.
 *
 * Everything here works in **local** calendar days. The ledger's timestamps
 * are the runtime's local time and the panel is drawn on the same machine, so
 * "the day the user was on" is the day `YYYY-MM-DD` spells — the same rule the
 * runtime's aggregation applies (see `internal/usage/aggregate.go`).
 */

/** One grid cell. `level` is the 0–4 activity ramp; `future` marks the cells
 *  past today that pad the last week out to seven rows — drawn blank, never
 *  as "no activity". */
export interface HeatCell {
  day: string;
  tokens: number;
  turns: number;
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

/** One column of the grid: seven cells, index 0 = Sunday, the convention the
 *  month labels align against. */
export interface HeatWeek {
  cells: HeatCell[];
}

export interface HeatGrid {
  weeks: HeatWeek[];
  /** Labels for the month header/footer row: which column a month starts at.
   *  A month mostly scrolled off the window's first column gets no label — a
   *  name floating over someone else's days is worse than a gap. */
  months: { column: number; label: string }[];
}

/** One aggregated week, for the weekly view: the same window, one bucket per
 *  Sunday-started week. */
export interface WeekBucket {
  /** The week's Sunday, `YYYY-MM-DD` — the bucket's key and its tooltip's date. */
  week: string;
  tokens: number;
  turns: number;
  level: 0 | 1 | 2 | 3 | 4;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The grid window: 365 days ending today, the same span the runtime's
 *  `by_day` series is cut to (see `internal/usage`'s `windowDays`). The two
 *  windows agreeing is what lets an older snapshot still draw a full year. */
const WINDOW_DAYS = 365;

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A human date for tooltips: "Oct 25, 2026" — the ledger's own day, said the
 *  way the rest of the interface says dates. */
export function dayLabel(day: string): string {
  const date = parseDay(day);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/**
 * The activity ramp's thresholds: the quartiles of the **non-zero** days.
 *
 * Scaling by the maximum would make one heavy day flatten every other day
 * into level 1, and a day with a thousand tokens is visually "a lot" even
 * next to a ten-thousand-token one. Quartiles keep the ramp honest about the
 * distribution the person actually has. With no non-zero days there is no
 * distribution, and every cell is level 0 — the empty ledger's grid.
 */
function levels(cellTokens: number[], nonZero: number[]): (0 | 1 | 2 | 3 | 4)[] {
  if (nonZero.length === 0) return cellTokens.map(() => 0 as const);
  const at = (q: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(q * nonZero.length))];
  const q1 = at(0.25);
  const q2 = at(0.5);
  const q3 = at(0.75);
  return cellTokens.map((tokens) => {
    if (tokens <= 0) return 0 as const;
    if (tokens <= q1) return 1 as const;
    if (tokens <= q2) return 2 as const;
    if (tokens <= q3) return 3 as const;
    return 4 as const;
  });
}

function sortKeys(map: Map<string, { tokens: number; turns: number }>): string[] {
  return [...map.keys()].sort();
}

/** Build the daily grid: one column per week, seven rows, ending today. */
export function buildDailyGrid(byDay: UsageDay[], now: Date): HeatGrid {
  const recorded = new Map<string, { tokens: number; turns: number }>();
  for (const day of byDay) recorded.set(day.day, { tokens: day.tokens, turns: day.turns });

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  // The window starts wherever it starts; the grid starts on the Sunday at or
  // before it, so the first column is whole.
  start.setDate(start.getDate() - start.getDay());

  const cells: HeatCell[] = [];
  const raw: number[] = [];
  for (let time = start.getTime(); time <= today.getTime(); time += DAY_MS) {
    const date = new Date(time);
    const key = dayKey(date);
    const hit = recorded.get(key);
    const tokens = hit?.tokens ?? 0;
    cells.push({ day: key, tokens, turns: hit?.turns ?? 0, level: 0, future: false });
    raw.push(tokens);
  }
  // Today's column pads out to Saturday with cells the person cannot have
  // filled yet. They exist so every column has seven rows; they draw blank.
  for (let rest = today.getDay() + 1; rest < 7; rest++) {
    cells.push({ day: dayKey(new Date(today.getTime() + (rest - today.getDay()) * DAY_MS)), tokens: 0, turns: 0, level: 0, future: true });
    raw.push(0);
  }

  const nonZero = raw.filter((tokens) => tokens > 0).sort((a, b) => a - b);
  const ramp = levels(raw, nonZero);
  cells.forEach((cell, i) => {
    cell.level = ramp[i];
  });

  const weeks: HeatWeek[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push({ cells: cells.slice(i, i + 7) });
  }

  // A column is labelled when its first day's month differs from the previous
  // column's — and the very first column only when it begins in the month's
  // first week, because a label for a month that is almost entirely outside
  // the window names days the grid does not show.
  const months: { column: number; label: string }[] = [];
  let previousMonth = -1;
  weeks.forEach((week, column) => {
    const first = parseDay(week.cells[0].day);
    if (first.getMonth() !== previousMonth) {
      const isInFirstWeek = first.getDate() <= 7;
      if (column > 0 || isInFirstWeek) {
        months.push({ column, label: MONTHS[first.getMonth()] });
      }
      previousMonth = first.getMonth();
    }
  });

  return { weeks, months };
}

/** Build the weekly view: the same window, one bucket per Sunday-started week,
 *  ramped by the quartiles of the **weekly** totals — a distribution seven
 *  times larger per bucket than the daily one, and scaled on its own terms. */
export function buildWeeklyBuckets(byDay: UsageDay[], now: Date): WeekBucket[] {
  const recorded = new Map<string, { tokens: number; turns: number }>();
  for (const day of byDay) recorded.set(day.day, { tokens: day.tokens, turns: day.turns });

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  start.setDate(start.getDate() - start.getDay());

  const buckets = new Map<string, { tokens: number; turns: number }>();
  for (let time = start.getTime(); time <= today.getTime(); time += DAY_MS) {
    const date = new Date(time);
    const hit = recorded.get(dayKey(date));
    if (!hit) continue;
    const weekStart = new Date(date.getTime());
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const key = dayKey(weekStart);
    const bucket = buckets.get(key) ?? { tokens: 0, turns: 0 };
    bucket.tokens += hit.tokens;
    bucket.turns += hit.turns;
    buckets.set(key, bucket);
  }

  const keys = sortKeys(buckets);
  const ramp = levels(keys.map((k) => buckets.get(k)!.tokens), keys.map((k) => buckets.get(k)!.tokens).filter((n) => n > 0).sort((a, b) => a - b));
  return keys.map((week, i) => ({ week, ...buckets.get(week)!, level: ramp[i] }));
}
