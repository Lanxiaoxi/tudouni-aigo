import { useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  activeWorkspaceOf,
  selectSavedSessions,
  useApp,
} from '@/state/store';
import { useT } from '@/i18n/useT';
import {
  DELIVERABLES,
  type Deliverable,
  type LearnScope,
} from '@/learn/template';
import { Info, PanelInfo } from '@/components/ui/kit';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * The workspace-learning configuration.
 *
 * This is a **form whose submit becomes a new session's first message** —
 * see `startLearning`. The panel holds no runtime state of its own and
 * sends nothing until the person presses Start; what it draws here is the
 * same set of facts the message will carry, so the person can read exactly
 * what the learning run will be told before it starts.
 *
 * **The shape is the task editor's, because this is the same kind of screen.**
 * A form with two kinds of content in it: things you decide (the scope, the
 * deliverable types, the focus) and things that are *true* of the run (which
 * workspace it studies, how many sessions that comes to, which model it
 * inherits). The left column holds the first, the tinted side card holds the
 * second, exactly as `TaskEditor` separates "what the run says" from "where it
 * says it". A single column of five stacked blocks — which is what this panel
 * was — made the facts look like more fields.
 *
 * **The scope count is computed, not promised.** The number next to each
 * option comes from applying the scope to the store's saved-session list
 * (the runtime's own answer to `session_list`), the same arithmetic
 * `learningSessionRefs` runs when the message is built — one function for
 * both, so the number a person reads and the list the agent is given cannot
 * disagree.
 *
 * **A row's number belongs to that row.** The day count and the session
 * count are disabled until their option is the chosen one. They used to be
 * live in all three rows at once, so typing into "Last 20 sessions" while
 * "All sessions" was selected changed a value that nothing on screen
 * reflected and nothing would use — a control that accepts input and has no
 * effect is worse than one that plainly refuses it.
 *
 * **The parts are the app's.** The three exclusive options are `.tk-choice`
 * rows — the same radio list the MCP transport is chosen from — and a section
 * head, a tick box, a textarea, a path row and the footer's sentence are all
 * classes Configuration and the task editor already use for those jobs. The
 * first version of this panel invented a parallel vocabulary for every one of
 * them, which is how a panel in the same dialog as Settings and Config came to
 * look like it belonged to another application.
 */
export function LearnPanel() {
  const t = useT();
  const workspace = useApp(activeWorkspaceOf);
  const saved = useApp((s) => selectSavedSessions(s, activeWorkspaceOf(s)));
  const startLearning = useApp((s) => s.startLearning);
  const closePanel = useApp((s) => s.closePanel);

  const [scopeMode, setScopeMode] = useState<'all' | 'days' | 'last'>('all');
  const [days, setDays] = useState('30');
  const [count, setCount] = useState('20');
  const [picked, setPicked] = useState<Deliverable[]>([...DELIVERABLES]);
  const [objectives, setObjectives] = useState('');

  /** The sessions any scope could pick: archived is "out of the list" in
   *  this app, and a learning run that digs through the archive is a scope
   *  the form does not offer. */
  const eligible = useMemo(
    () => saved.items.filter((row) => !row.archived),
    [saved.items],
  );

  const daysValid = isWholeNumber(days);
  const countValid = isWholeNumber(count);
  const rangeValid =
    scopeMode === 'all' || (scopeMode === 'days' ? daysValid : countValid);

  /** How many sessions the current settings would put in scope — the same
   *  arithmetic the message is built with, applied to the same list. */
  const inScope = useMemo(() => {
    if (scopeMode === 'all') return eligible.length;
    if (scopeMode === 'days') {
      if (!daysValid) return 0;
      const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
      return eligible.filter(
        (row) => row.modifiedAt !== null && row.modifiedAt * 1000 >= cutoff,
      ).length;
    }
    if (!countValid) return 0;
    return Math.min(Number(count), eligible.length);
  }, [eligible, scopeMode, days, count, daysValid, countValid]);

  const noWorkspace = workspace === '';
  const canStart = !noWorkspace && rangeValid && inScope > 0 && picked.length > 0;

  /**
   * The one sentence that explains a disabled Start, and how loudly to say it.
   *
   * Only ever one, and in the order that matters: no workspace at all is the
   * hardest stop; a number that is not a number is a mistake in a field; a
   * range that happens to be empty is a fact about the workspace rather than
   * about the form; and nothing ticked is a choice not yet made. The first
   * version folded the empty-range case into the invalid-number sentence, so
   * a perfectly well-formed "last 1 day" over a workspace whose sessions are
   * all older than a day was told it had given a bad number.
   *
   * The tone is `error` for the two that are the person's to fix and
   * `warn` for the two that are the workspace's state — the same split the
   * configuration panel draws between a blocking problem and a notice.
   *
   * It lives in the footer, beside the button it explains, and **not** in the
   * side card: a disabled control that explains itself somewhere other than
   * next to itself explains itself to nobody.
   */
  const blocker: { text: string; tone: 'error' | 'warn' } | null = noWorkspace
    ? { text: t('panel.learn.noWorkspace'), tone: 'error' }
    : scopeMode !== 'all' && !rangeValid
      ? { text: t('panel.learn.invalidRange'), tone: 'error' }
      : picked.length === 0
        ? { text: t('panel.learn.noneSelected'), tone: 'error' }
        : eligible.length === 0
          ? { text: t('panel.learn.scope.none'), tone: 'warn' }
          : inScope === 0
            ? { text: t('panel.learn.scope.empty'), tone: 'warn' }
            : null;

  function toggleDeliverable(which: Deliverable) {
    setPicked((current) =>
      current.includes(which) ? current.filter((row) => row !== which) : [...current, which],
    );
  }

  function start() {
    if (!canStart) return;
    const scope: LearnScope =
      scopeMode === 'all'
        ? { kind: 'all' }
        : scopeMode === 'days'
          ? { kind: 'days', days: Number(days) }
          : { kind: 'last', count: Number(count) };
    // The order is the point: the form closes first, so the screen that
    // appears when the new session starts is not covered by the form that
    // produced it. `startLearning`'s `attachSession` closes the panel too,
    // but that write lands after the attach, and the form should not be the
    // thing standing over its own result.
    closePanel();
    void startLearning(scope, DELIVERABLES.filter((row) => picked.includes(row)), objectives);
  }

  return (
    <PanelShell
      title={t('panel.learn.title')}
      info={<PanelInfo label={t('panel.learn.about')} />}
      note={t('panel.learn.note')}
      footer={
        <>
          <span className="cfg-status">
            {blocker !== null ? (
              <span
                className={blocker.tone === 'error' ? 'cfg-status-error' : 'cfg-status-pending'}
                role={blocker.tone === 'error' ? 'alert' : undefined}
              >
                {blocker.text}
              </span>
            ) : null}
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canStart}
            onClick={start}
          >
            {t('panel.learn.start')}
          </button>
        </>
      }
    >
      <PanelBody>
        <div className="tk-editor">
          <div className="tk-editor-main">
            <section className="tk-section">
              <div className="tk-section-head">
                <span className="tk-section-label">{t('panel.learn.scope')}</span>
                <Info label={t('panel.learn.scope.hint')} />
              </div>

              {/* One row per option, full width: the label names the choice, the
                  number input is that option's own parameter, and the count on the
                  right is the preview the form promises ("this scope studies N
                  sessions"). Three bordered rows joined by a shared hairline rather
                  than three detached boxes: they are one choice, and three cards
                  read as three unrelated settings. */}
              <div className="tk-choice" role="radiogroup" aria-label={t('panel.learn.scope')}>
                <label className="tk-choice-row">
                  <input
                    type="radio"
                    name="learn-scope"
                    checked={scopeMode === 'all'}
                    onChange={() => setScopeMode('all')}
                  />
                  <span className="tk-choice-text">{t('panel.learn.scope.all')}</span>
                  <span className="tk-choice-count">{eligible.length}</span>
                </label>

                <label className="tk-choice-row">
                  <input
                    type="radio"
                    name="learn-scope"
                    checked={scopeMode === 'days'}
                    onChange={() => setScopeMode('days')}
                  />
                  <span className="tk-choice-text">{t('panel.learn.scope.days')}</span>
                  <input
                    className="tk-choice-num"
                    inputMode="numeric"
                    aria-label={t('panel.learn.scope.daysPlaceholder')}
                    placeholder={t('panel.learn.scope.daysPlaceholder')}
                    value={days}
                    disabled={scopeMode !== 'days'}
                    onChange={(e) => setDays(e.target.value)}
                  />
                  <span className="tk-choice-count">
                    {scopeMode === 'days' && rangeValid ? inScope : '—'}
                  </span>
                </label>

                <label className="tk-choice-row">
                  <input
                    type="radio"
                    name="learn-scope"
                    checked={scopeMode === 'last'}
                    onChange={() => setScopeMode('last')}
                  />
                  <span className="tk-choice-text">{t('panel.learn.scope.last')}</span>
                  <input
                    className="tk-choice-num"
                    inputMode="numeric"
                    aria-label={t('panel.learn.scope.countPlaceholder')}
                    placeholder={t('panel.learn.scope.countPlaceholder')}
                    value={count}
                    disabled={scopeMode !== 'last'}
                    onChange={(e) => setCount(e.target.value)}
                  />
                  <span className="tk-choice-count">
                    {scopeMode === 'last' && rangeValid ? inScope : '—'}
                  </span>
                </label>
              </div>

              {/* Only the scope's own two mistakes live here. The "nothing in
                  this range" case is stated once, in the footer, beside the
                  button — and the count column already reads `0` beside the
                  chosen row. */}
              {scopeMode !== 'all' && !rangeValid ? (
                <div className="cfg-problems">
                  <div className="cfg-problem is-blocking">{t('panel.learn.invalidRange')}</div>
                </div>
              ) : null}
            </section>

            <section className="tk-section">
              <div className="tk-section-head">
                <span className="tk-section-label">{t('panel.learn.deliverables')}</span>
                <Info label={t('panel.learn.deliverables.hint')} />
              </div>
              {/* Native checkboxes wearing the app's own accent, in one wrapped
                  row: four short type names, not four sentences. `.cfg-check` is
                  the checkbox shape Configuration uses, so a ticked box means the
                  same thing in both panels — and it stays a real focusable input
                  rather than a painted chip over a hidden one. */}
              <div className="learn-deliverables">
                {DELIVERABLES.map((which) => (
                  <label key={which} className="cfg-check">
                    <input
                      type="checkbox"
                      checked={picked.includes(which)}
                      onChange={() => toggleDeliverable(which)}
                      aria-label={which}
                    />
                    <span>{which}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="tk-section">
              <div className="tk-section-head">
                <span className="tk-section-label">{t('panel.learn.objectives')}</span>
              </div>
              <textarea
                className="cfg-textarea"
                rows={3}
                value={objectives}
                onChange={(e) => setObjectives(e.target.value)}
                placeholder={t('panel.learn.objectives.placeholder')}
              />
            </section>
          </div>

          {/* The side card: what is *true* of the run. Every line here is read
              off the same sources the message will be built from — the workspace
              from the store, the count from the scope arithmetic above, the
              deliverable tally from the ticks — so nothing in it can be a
              promise the run does not keep. */}
          <aside className="tk-editor-side">
            <div className="tk-side-title">{t('panel.learn.sideTitle')}</div>

            {noWorkspace ? (
              <p className="tk-field-hint">{t('panel.learn.noWorkspace')}</p>
            ) : (
              <div className="cfg-path-row">
                <FolderOpen size={13} className="learn-workspace-ic" />
                <span className="cfg-path mono" title={workspace}>
                  {workspace}
                </span>
              </div>
            )}

            <div className="tk-side-facts">
              <span className="tk-fact">
                <span className="tk-fact-label">{t('panel.learn.factScope')}</span>
                <span className="tk-fact-value">{inScope}</span>
              </span>
              <span className="tk-fact">
                <span className="tk-fact-label">{t('panel.learn.factDeliverables')}</span>
                <span className="tk-fact-value">
                  {t('panel.learn.factDeliverablesValue', { n: picked.length, total: DELIVERABLES.length })}
                </span>
              </span>
            </div>

            <p className="tk-field-hint">{t('panel.learn.modelNote')}</p>
          </aside>
        </div>
      </PanelBody>
    </PanelShell>
  );
}

/** A whole number of at least 1 — "0 days" is not a range and "1.5 sessions"
 *  is not a count. */
function isWholeNumber(value: string): boolean {
  return value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 1;
}
