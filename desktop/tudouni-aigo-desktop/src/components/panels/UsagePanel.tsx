import { useMemo, useState } from 'react';
import { useT } from '@/i18n/useT';
import { useApp } from '@/state/store';
import { EmptyState, Tip } from '@/components/ui/kit';
import { formatDuration, formatTokens } from '@/utils/format';
import { PanelBody, PanelShell } from './PanelShell';
import { buildDailyGrid, buildWeeklyBuckets, dayLabel } from './usageHeatmap';

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
 * yesterday) and draws as one.
 *
 * The date math lives in `usageHeatmap.ts`; this component draws what those
 * functions decided.
 */
export function UsagePanel() {
  const t = useT();
  const usage = useApp((s) => s.usage);
  const problem = useApp((s) => s.usageProblem);
  const hasSession = useApp((s) => s.activeKey !== null);
  const [granularity, setGranularity] = useState<'daily' | 'weekly'>('daily');

  // `now` is frozen per mount rather than read at draw time: the grid's shape
  // (which column is today, where the months start) should not reshuffle under
  // a reader at midnight — the next open of the panel gets the new day.
  const now = useMemo(() => new Date(), []);
  const daily = useMemo(() => (usage ? buildDailyGrid(usage.by_day, now) : null), [usage, now]);
  const weekly = useMemo(() => (usage ? buildWeeklyBuckets(usage.by_day, now) : null), [usage, now]);

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
