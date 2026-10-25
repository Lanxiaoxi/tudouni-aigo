import type { UsageDay } from '@/protocol/types';
import { dayKey } from './usageHeatmap';

/**
 * The usage panel's per-model charts' math, as pure functions — the trend
 * lines' and the donut's data, the way `usageHeatmap.ts` is the heatmap's.
 *
 * The input is the snapshot's `by_day` with its per-model split (protocol
 * 12). Days the split does not cover are zero-filled, because a silent day
 * is a real measurement — nothing was spent — and the trend must draw it at
 * the baseline rather than skip it. The split can sum to less than a day's
 * `tokens` (rows without a model land in no bucket — see `UsageDay.models`),
 * so these charts total **the split**, never the day totals: one number with
 * two sources would be two answers to "how much".
 *
 * Everything works in local calendar days, the same rule the heatmap and the
 * runtime's aggregation apply. A snapshot from a runtime below protocol 12
 * has no split at all, which the component reads as "hide the charts" —
 * absence is a sentence here too.
 */

/** The two ranges the trend's toggle offers, in days. */
export const TREND_RANGES = [7, 30] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

/** The most models the charts draw individually. A person configures a
 *  handful of routes at most; beyond that the remainder folds into one
 *  "other" series rather than recycling a colour onto a second model — two
 *  lines sharing a colour would claim two models are one. */
const MAX_MODELS = 6;

/** The folded remainder's name. A sentinel, not a label — the component
 *  renders it through i18n ("Other models"). */
export const OTHER_MODEL = '__other__';

export interface TrendSeries {
  /** The model's name as the ledger spells it, or `OTHER_MODEL`. */
  model: string;
  /** Tokens across the whole range — the donut's slice, the legend's number. */
  total: number;
  /** One value per day of the range, ascending, zero-filled. */
  points: number[];
}

export interface ModelTrend {
  /** The range's days, ascending, ending today — `YYYY-MM-DD`. */
  days: string[];
  /** One series per model, largest total first, at most `MAX_MODELS` of
   *  them. */
  series: TrendSeries[];
  /** Every series' sum: the donut's centre and the share's denominator. */
  total: number;
  /** The largest single point — the trend's y scale. Zero when nothing was
   *  spent in the range, which draws a flat baseline, not an empty chart:
   *  "nothing those days" is a measurement, like a streak of zero. */
  peakPoint: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the trend: the range's days zero-filled, one series per model the
 * split names, largest total first.
 *
 * A day outside the range is skipped, and a model with tokens on no day in
 * range does not exist here — the charts describe the window the toggle
 * names, not the ledger's whole history.
 */
export function buildModelTrend(byDay: UsageDay[], now: Date, range: TrendRange): ModelTrend {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days: string[] = [];
  for (let offset = range - 1; offset >= 0; offset--) {
    days.push(dayKey(new Date(today.getTime() - offset * DAY_MS)));
  }
  const at = new Map(days.map((day, i) => [day, i]));

  // The split accumulates into per-model point arrays; a day entry with no
  // split contributes nothing, and neither does a model key outside the
  // window. Zeros are never buckets: a model exists here only because some
  // day recorded tokens for it.
  const splits = new Map<string, number[]>();
  for (const entry of byDay) {
    if (!entry.models) continue;
    const day = at.get(entry.day);
    if (day === undefined) continue;
    for (const [model, tokens] of Object.entries(entry.models)) {
      if (!(tokens > 0)) continue;
      let points = splits.get(model);
      if (!points) {
        points = new Array<number>(range).fill(0);
        splits.set(model, points);
      }
      points[day] += tokens;
    }
  }

  const models = [...splits.entries()].map(([model, points]) => ({
    model,
    points,
    total: points.reduce((sum, n) => sum + n, 0),
  }));
  // Largest first — the legend and the donut read top-down — with the name
  // breaking ties, so the same ledger folds the same way twice.
  models.sort((a, b) => b.total - a.total || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));

  // At most MAX_MODELS series: past that, everything from the sixth model on
  // folds into one "other" — five named lines plus the remainder.
  let series: TrendSeries[];
  if (models.length <= MAX_MODELS) {
    series = models;
  } else {
    const merged = new Array<number>(range).fill(0);
    for (const model of models.slice(MAX_MODELS - 1)) {
      model.points.forEach((tokens, i) => {
        merged[i] += tokens;
      });
    }
    series = [
      ...models.slice(0, MAX_MODELS - 1),
      { model: OTHER_MODEL, total: merged.reduce((sum, n) => sum + n, 0), points: merged },
    ];
  }

  return {
    days,
    series,
    total: series.reduce((sum, s) => sum + s.total, 0),
    peakPoint: series.reduce((max, s) => Math.max(max, ...s.points), 0),
  };
}

export interface DonutSlice {
  /** The model's name as the ledger spells it, or `OTHER_MODEL`. */
  model: string;
  tokens: number;
  /** Fraction of the range's total, 0..1 — the arc's length. */
  share: number;
}

/**
 * The donut's slices, largest first, zero-share models dropped. The arcs are
 * drawn from this list in order, so the legend and the ring cannot disagree
 * about which slice is which.
 */
export function donutSlices(trend: ModelTrend): DonutSlice[] {
  if (trend.total <= 0) return [];
  return trend.series
    .map((s) => ({ model: s.model, tokens: s.total, share: s.total / trend.total }))
    .filter((slice) => slice.share > 0);
}

/** A share as the legend prints it: whole percents at a tenth of a percent's
 *  precision is noise, but a small model's 7.3% rounds to "7%" — the one
 *  decimal is what keeps a minority slice honest. */
export function formatShare(share: number): string {
  const pct = share * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/**
 * Which day indices get an x label: every day for the short range, every
 * fifth for the long one — and always the last day, because a trend that
 * does not say where "now" is leaves its window unanchored.
 */
export function trendTicks(count: number): number[] {
  const step = count <= 8 ? 1 : 5;
  const ticks: number[] = [];
  for (let i = 0; i < count; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== count - 1) ticks.push(count - 1);
  return ticks;
}
