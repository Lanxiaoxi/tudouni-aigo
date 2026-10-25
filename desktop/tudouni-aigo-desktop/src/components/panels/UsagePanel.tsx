import { useMemo, useState } from 'react';
import { useT } from '@/i18n/useT';
import { useApp } from '@/state/store';
import { EmptyState, Tip } from '@/components/ui/kit';
import { formatDuration, formatTokens, formatTokensCompact } from '@/utils/format';
import { PanelBody, PanelShell } from './PanelShell';
import { buildDailyGrid, buildWeeklyBuckets, dayLabel, dayLabelShort } from './usageHeatmap';
import {
  buildModelTrend,
  donutSlices,
  formatShare,
  trendTicks,
  OTHER_MODEL,
  TREND_RANGES,
  type DonutSlice,
  type ModelTrend,
  type TrendRange,
} from './usageCharts';

/**
 * Usage statistics: this user's token spend across every workspace, from the
 * ledger the runtime keeps beside `config.json` in the home directory.
 *
 * **The only workbench panel whose subject is the person, not a session or a
 * workspace.** The snapshot arrives in a window-level store slot (see
 * `storeShape.usage`) and is requested once per open, never polled — a person
 * reading totals does not need them to tick, and the ledger only grows on
 * finished turns anyway.
 *
 * **Absence is a sentence, and the panel keeps it one.** The runtime omits
 * `peak` and `longest_run_ms` when no record exists, and a ledger with no
 * turns draws the empty-state sentence rather than a row of zeros — "nothing
 * spent yet" and "the busiest day spent nothing" must not be the same screen.
 * A streak of zero, by contrast, is a real measurement (not active today or
 * yesterday) and draws as one. The same rule governs the two per-model
 * charts: a snapshot whose `by_day` carries no `models` split (a runtime
 * below protocol 12, or days whose rows recorded no model) hides them
 * entirely, and a range with nothing spent draws the trend's flat baseline
 * but no donut — proportions of nothing are not a chart.
 *
 * The date math lives in `usageHeatmap.ts`, the charts' math in
 * `usageCharts.ts`; this component draws what those functions decided.
 */
export function UsagePanel() {
  const t = useT();
  const usage = useApp((s) => s.usage);
  const problem = useApp((s) => s.usageProblem);
  const hasSession = useApp((s) => s.activeKey !== null);
  const [granularity, setGranularity] = useState<'daily' | 'weekly'>('daily');
  const [range, setRange] = useState<TrendRange>(7);

  // `now` is frozen per mount rather than read at draw time: the grid's shape
  // (which column is today, where the months start) should not reshuffle under
  // a reader at midnight — the next open of the panel gets the new day.
  const now = useMemo(() => new Date(), []);
  const daily = useMemo(() => (usage ? buildDailyGrid(usage.by_day, now) : null), [usage, now]);
  const weekly = useMemo(() => (usage ? buildWeeklyBuckets(usage.by_day, now) : null), [usage, now]);
  const trend = useMemo(
    () => (usage ? buildModelTrend(usage.by_day, now, range) : null),
    [usage, now, range],
  );

  if (!hasSession) {
    return (
      <PanelShell title={t('panel.usage.title')} note={t('panel.usage.note')}>
        <PanelBody>
          <EmptyState title={t('panel.usage.noSession')} />
        </PanelBody>
      </PanelShell>
    );
  }

  return (
    <PanelShell title={t('panel.usage.title')} note={t('panel.usage.note')}>
      <PanelBody>
        {/* The refusal banner, for the reason every panel's banner exists: the
          * panel is a modal layer, so a notice about a failed read would print
          * behind this dialog where nobody can see it. */}
        {problem !== null ? (
          <div className="cfg-problems" role="alert">
            <div className="cfg-problem is-blocking">
              {t('panel.usage.problem')}: {problem}
            </div>
          </div>
        ) : null}

        {usage === null ? (
          <EmptyState title={t('common.loading')} />
        ) : usage.totals.turns === 0 ? (
          <EmptyState title={t('panel.usage.empty')} />
        ) : (
          <>
            <div className="usage-facts">
              <UsageFact
                value={formatTokens(usage.totals.tokens)}
                label={t('panel.usage.fact.total')}
                hint={t('panel.usage.asOf', { when: asOf(usage.generated_at) })}
              />
              <UsageFact
                value={usage.peak ? formatTokens(usage.peak.tokens) : '—'}
                label={t('panel.usage.fact.peak')}
                sub={usage.peak ? dayLabel(usage.peak.day) : undefined}
              />
              <UsageFact
                value={formatDuration(usage.longest_run_ms)}
                label={t('panel.usage.fact.longestTurn')}
              />
              <UsageFact
                value={t('panel.usage.days', { n: usage.streak.current })}
                label={t('panel.usage.fact.streakCurrent')}
              />
              <UsageFact
                value={t('panel.usage.days', { n: usage.streak.longest })}
                label={t('panel.usage.fact.streakLongest')}
              />
            </div>

            <div className="usage-activity">
              <div className="usage-activity-head">
                <span className="usage-activity-title">{t('panel.usage.activity')}</span>
                <div className="usage-granularity" role="group" aria-label={t('panel.usage.activity')}>
                  <button
                    type="button"
                    className={`usage-granularity-btn${granularity === 'daily' ? ' is-on' : ''}`}
                    onClick={() => setGranularity('daily')}
                  >
                    {t('panel.usage.daily')}
                  </button>
                  <button
                    type="button"
                    className={`usage-granularity-btn${granularity === 'weekly' ? ' is-on' : ''}`}
                    onClick={() => setGranularity('weekly')}
                  >
                    {t('panel.usage.weekly')}
                  </button>
                </div>
              </div>

              {granularity === 'daily' && daily !== null ? (
                <>
                  <div className="usage-grid">
                    {daily.weeks.flatMap((week) =>
                      week.cells.map((cell) => (
                        <Tip key={cell.day} label={cellTip(t, cell.day, cell.tokens, cell.turns)}>
                          {/* A button, not a div: the tooltip needs a focusable
                            * trigger, and a keyboard-only reader gets the same
                            * sentence hover does. */}
                          <button
                            type="button"
                            className={`usage-cell usage-l${cell.level}${cell.future ? ' is-future' : ''}`}
                            tabIndex={-1}
                            aria-label={cellTipText(t, cell.day, cell.tokens, cell.turns)}
                          />
                        </Tip>
                      )),
                    )}
                  </div>
                  <div className="usage-months" aria-hidden="true">
                    {daily.months.map((month) => (
                      <span key={`${month.column}-${month.label}`} style={{ gridColumnStart: month.column + 1 }}>
                        {month.label}
                      </span>
                    ))}
                  </div>
                </>
              ) : null}

              {granularity === 'weekly' && weekly !== null ? (
                <div className="usage-weeks">
                  {weekly.map((bucket) => (
                    <Tip
                      key={bucket.week}
                      label={cellTip(t, t('panel.usage.cellWeek', { day: dayLabel(bucket.week) }), bucket.tokens, bucket.turns)}
                    >
                      <button
                        type="button"
                        className={`usage-cell usage-l${bucket.level}`}
                        tabIndex={-1}
                        aria-label={cellTipText(
                          t,
                          t('panel.usage.cellWeek', { day: dayLabel(bucket.week) }),
                          bucket.tokens,
                          bucket.turns,
                        )}
                      />
                    </Tip>
                  ))}
                </div>
              ) : null}

              <div className="usage-legend" aria-hidden="true">
                <span>{t('panel.usage.legendLess')}</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <div key={level} className={`usage-cell usage-l${level}`} />
                ))}
                <span>{t('panel.usage.legendMore')}</span>
              </div>
            </div>

            {/* The per-model charts. A snapshot without the split (protocol
              * 12's `models`) has no series to draw, so both cards stay
              * hidden — "the ledger does not say" is a different sentence
              * from "every model spent nothing". */}
            {trend !== null && trend.series.length > 0 ? (
              <>
                <div className="usage-activity">
                  <div className="usage-activity-head">
                    <span className="usage-activity-title">{t('panel.usage.trend')}</span>
                    <div className="usage-granularity" role="group" aria-label={t('panel.usage.trend')}>
                      {TREND_RANGES.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={`usage-granularity-btn${range === option ? ' is-on' : ''}`}
                          onClick={() => setRange(option)}
                        >
                          {t(option === 7 ? 'panel.usage.range7' : 'panel.usage.range30')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <TrendChart trend={trend} />
                  <div className="usage-models">
                    {trend.series.map((series, i) => (
                      <div key={series.model} className={`usage-model ${seriesClass(series.model, i)}`}>
                        <span className="usage-model-dot" aria-hidden="true" />
                        <span className="usage-model-name">{seriesName(t, series.model)}</span>
                        <span className="usage-model-total">{formatTokens(series.total)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {trend.total > 0 ? <ShareCard trend={trend} /> : null}
              </>
            ) : null}
          </>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/** One stat card. The shape is the code-index panel's fact (`.ci-fact`), plus
 *  the two extras this panel's cards need: a `sub` line under the value (the
 *  peak's date) and a `hint` for the tooltip (what "as of" means). */
function UsageFact({ value, label, sub, hint }: { value: string; label: string; sub?: string; hint?: string }) {
  return (
    <Tip label={hint}>
      <div className="usage-fact">
        <span className="usage-fact-value">{value}</span>
        <span className="usage-fact-label">{label}</span>
        {sub ? <span className="usage-fact-sub">{sub}</span> : null}
      </div>
    </Tip>
  );
}

/** One cell's tooltip, as a node: the date, then the day's spend. */
function cellTip(t: ReturnType<typeof useT>, day: string, tokens: number, turns: number) {
  if (tokens <= 0) return <>{`${day} · ${t('panel.usage.cellIdle')}`}</>;
  return <>{`${day} · ${t('panel.usage.cellTokens', { tokens: formatTokens(tokens), turns })}`}</>;
}

/** The same sentence as text, for the cell's accessible name. */
function cellTipText(t: ReturnType<typeof useT>, day: string, tokens: number, turns: number): string {
  if (tokens <= 0) return `${day} · ${t('panel.usage.cellIdle')}`;
  return `${day} · ${t('panel.usage.cellTokens', { tokens: formatTokens(tokens), turns })}`;
}

/** `generated_at` is the runtime's local clock without a zone, so `Date`
 *  parses it as local — and the sentence it becomes is the time only, because
 *  "as of" is always about now. */
function asOf(generatedAt: string): string {
  const at = new Date(generatedAt);
  if (Number.isNaN(at.getTime())) return generatedAt;
  return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The series' colour-slot class. A named model takes the palette slot its
 *  rank gives it; the folded remainder always takes the neutral one, because
 *  it is no single model and must wear no single model's colour. */
function seriesClass(model: string, index: number): string {
  return model === OTHER_MODEL ? 'usage-series-other' : `usage-series-${index}`;
}

/** The series' display name: the ledger's own spelling for a model, the
 *  i18n sentence for the folded remainder (a sentinel is not a label). */
function seriesName(t: ReturnType<typeof useT>, model: string): string {
  return model === OTHER_MODEL ? t('panel.usage.modelOther') : model;
}

const TREND_W = 640;
const TREND_H = 190;

/** The daily trend: one line per model over the chosen range, dotted
 *  gridlines, x labels along the bottom. Hand-written SVG with no chart
 *  dependency — the decision the heatmap made, for the same reason: the
 *  panel draws four shapes and should not carry a library to do it.
 *
 *  The y scale is the largest **single** point, not the largest day total:
 *  the lines overlay rather than stack, so a day where two models split the
 *  spend must not push every line into the bottom half of a frame sized for
 *  a sum none of them reaches. Days with no spend sit on the baseline — a
 *  silent day is a measurement, like a streak of zero. The points carry
 *  native `<title>` tooltips; the full-precision numbers live there and in
 *  the legend under the chart, not on the canvas. */
function TrendChart({ trend }: { trend: ModelTrend }) {
  const t = useT();
  const padX = 12;
  const padTop = 12;
  const padBottom = 26;
  const innerW = TREND_W - padX * 2;
  const innerH = TREND_H - padTop - padBottom;
  const n = trend.days.length;
  const xAt = (i: number) => padX + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number) => padTop + innerH - (trend.peakPoint > 0 ? (v / trend.peakPoint) * innerH : 0);
  const ticks = trendTicks(n);
  const summary = `${t('panel.usage.trend')} — ${trend.series
    .map((series) => `${seriesName(t, series.model)} ${formatTokens(series.total)}`)
    .join(', ')}`;

  return (
    <svg className="usage-trend" viewBox={`0 0 ${TREND_W} ${TREND_H}`} role="img" aria-label={summary}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line
          key={f}
          className="usage-trend-grid"
          x1={padX}
          x2={TREND_W - padX}
          y1={padTop + innerH * (1 - f)}
          y2={padTop + innerH * (1 - f)}
        />
      ))}
      {trend.series.map((series, i) => (
        <g key={series.model} className={seriesClass(series.model, i)}>
          <polyline
            className="usage-trend-line"
            points={series.points.map((v, j) => `${xAt(j)},${yAt(v)}`).join(' ')}
          />
          {series.points.map((v, j) =>
            v > 0 ? (
              <circle key={j} className="usage-trend-dot" cx={xAt(j)} cy={yAt(v)} r={3}>
                <title>
                  {`${dayLabel(trend.days[j])} · ${seriesName(t, series.model)} · ${formatTokens(v)} ${t('panel.usage.tokensUnit')}`}
                </title>
              </circle>
            ) : null,
          )}
        </g>
      ))}
      {ticks.map((i) => (
        <text
          key={i}
          className="usage-trend-tick"
          x={xAt(i)}
          y={TREND_H - 8}
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
        >
          {dayLabelShort(trend.days[i])}
        </text>
      ))}
    </svg>
  );
}

const DONUT_SIZE = 168;
const DONUT_STROKE = 22;

/** The model-share card: a donut on the left, the same slices as a list on
 *  the right — the ring shows the proportions, the list carries the numbers
 *  the ring cannot. */
function ShareCard({ trend }: { trend: ModelTrend }) {
  const t = useT();
  const slices = donutSlices(trend);
  return (
    <div className="usage-activity">
      <div className="usage-activity-head">
        <span className="usage-activity-title">{t('panel.usage.share')}</span>
      </div>
      <div className="usage-share">
        <DonutChart slices={slices} total={trend.total} />
        <div className="usage-share-list">
          {slices.map((slice, i) => (
            <div key={slice.model} className={`usage-share-row ${seriesClass(slice.model, i)}`}>
              <span className="usage-model-dot" aria-hidden="true" />
              <span className="usage-share-name">{seriesName(t, slice.model)}</span>
              <span className="usage-share-tokens">{formatTokens(slice.tokens)}</span>
              <span className="usage-share-pct">{formatShare(slice.share)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The donut itself: one `<circle>` per slice, drawn with dash patterns,
 *  starting at twelve o'clock and walking clockwise, largest first — the
 *  order the legend reads. A hairline gap between arcs keeps two neighbours
 *  from reading as one continuous ring; a single slice gets none, there is
 *  nothing to separate. */
function DonutChart({ slices, total }: { slices: DonutSlice[]; total: number }) {
  const t = useT();
  const radius = (DONUT_SIZE - DONUT_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = slices.length > 1 ? Math.min(3, circumference * 0.006) : 0;
  let walked = 0;
  const arcs = slices.map((slice, i) => {
    const arcStart = walked;
    walked += slice.share * circumference;
    const dash = Math.max(walked - arcStart - gap, 0.5);
    return (
      <circle
        key={slice.model}
        className={`usage-donut-arc ${seriesClass(slice.model, i)}`}
        cx={DONUT_SIZE / 2}
        cy={DONUT_SIZE / 2}
        r={radius}
        strokeWidth={DONUT_STROKE}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={-(arcStart + gap / 2)}
      >
        <title>
          {`${seriesName(t, slice.model)} · ${formatTokens(slice.tokens)} ${t('panel.usage.tokensUnit')} · ${formatShare(slice.share)}`}
        </title>
      </circle>
    );
  });
  return (
    <svg
      className="usage-donut"
      viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
      role="img"
      aria-label={slices
        .map((slice) => `${seriesName(t, slice.model)} ${formatShare(slice.share)}`)
        .join(', ')}
    >
      <g transform={`rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`}>{arcs}</g>
      <text className="usage-donut-total" x={DONUT_SIZE / 2} y={DONUT_SIZE / 2 - 2} textAnchor="middle">
        {formatTokensCompact(total)}
      </text>
      <text className="usage-donut-unit" x={DONUT_SIZE / 2} y={DONUT_SIZE / 2 + 16} textAnchor="middle">
        {t('panel.usage.tokensUnit')}
      </text>
    </svg>
  );
}
