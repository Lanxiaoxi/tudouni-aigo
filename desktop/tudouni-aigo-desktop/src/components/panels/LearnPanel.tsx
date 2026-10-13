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
 * **The scope count is computed, not promised.** The number next to each
 * option comes from applying the scope to the store's saved-session list
 * (the runtime's own answer to `session_list`), the same arithmetic
 * `learningSessionRefs` runs when the message is built — one function for
 * both, so the number a person reads and the list the agent is given cannot
 * disagree.
 *
 * **It wears the configuration panel's clothes.** Every section here is the
 * same three pieces `ConfigPanel` uses for the same jobs: an `.etb-label`
 * head with a `.set-hint` under it, a `.cfg-problem` for anything wrong, a
 * `.cfg-path-row` for a path that is a fact rather than a field, and
 * `.cfg-check` for the deliverable boxes. The one shape that is this
 * panel's own is the scope list below — nothing else in the app is three
 * exclusive options that each carry their own number — and it is built out
 * of the same tokens (`.learn-scope` in `components.css`). Inventing a
 * second vocabulary for "a section", "a warning" or "a checkbox" is what
 * made the first version read as a different application.
 *
 * **A row's number belongs to that row.** The day count and the session
 * count are disabled until their option is the chosen one. They used to be
 * live in all three rows at once, so typing into "Last 20 sessions" while
 * "All sessions" was selected changed a value that nothing on screen
 * reflected and nothing would use — a control that accepts input and has no
 * effect is worse than one that plainly refuses it.
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
    <PanelShell title={t('panel.learn.title')} note={t('panel.learn.note')}>
      <PanelBody>
        {/* The workspace the run will take: the one on screen, and only that
            one. A learning run is a child of the workspace it studies, and
            the file boundary it works under is exactly this directory. Drawn
            as `.cfg-path-row` because that is what it is — a path the panel
            reports rather than a field it edits — and the same row shape the
            configuration panel uses for `config.json`.
            With no workspace there is no path to report, and the footer is
            where the reason is already said once; repeating it here would be
            the same sentence twice in one dialog. */}
        {noWorkspace ? null : (
          <div className="learn-block">
            <div className="etb-label">{t('panel.learn.workspace')}</div>
            <div className="cfg-path-row" style={{ marginTop: 'var(--space-2)' }}>
              <FolderOpen size={13} className="learn-workspace-ic" />
              <span className="cfg-path mono" title={workspace}>
                {workspace}
              </span>
            </div>
          </div>
        )}

        <div className="learn-block">
          <div className="etb-label">{t('panel.learn.scope')}</div>
          <p className="set-hint">{t('panel.learn.scope.hint')}</p>
          <div className="learn-scope" role="radiogroup" aria-label={t('panel.learn.scope')}>
            <label className="learn-scope-row">
              <input
                type="radio"
                name="learn-scope"
                checked={scopeMode === 'all'}
                onChange={() => setScopeMode('all')}
              />
              <span className="learn-scope-text">{t('panel.learn.scope.all')}</span>
              <span className="learn-scope-count">{eligible.length}</span>
            </label>

            <label className="learn-scope-row">
              <input
                type="radio"
                name="learn-scope"
                checked={scopeMode === 'days'}
                onChange={() => setScopeMode('days')}
              />
              <span className="learn-scope-text">{t('panel.learn.scope.days')}</span>
              <input
                className="learn-scope-num"
                inputMode="numeric"
                aria-label={t('panel.learn.scope.daysPlaceholder')}
                placeholder={t('panel.learn.scope.daysPlaceholder')}
                value={days}
                disabled={scopeMode !== 'days'}
                onChange={(e) => setDays(e.target.value)}
              />
              <span className="learn-scope-count">
                {scopeMode === 'days' && rangeValid ? inScope : '—'}
              </span>
            </label>

            <label className="learn-scope-row">
              <input
                type="radio"
                name="learn-scope"
                checked={scopeMode === 'last'}
                onChange={() => setScopeMode('last')}
              />
              <span className="learn-scope-text">{t('panel.learn.scope.last')}</span>
              <input
                className="learn-scope-num"
                inputMode="numeric"
                aria-label={t('panel.learn.scope.countPlaceholder')}
                placeholder={t('panel.learn.scope.countPlaceholder')}
                value={count}
                disabled={scopeMode !== 'last'}
                onChange={(e) => setCount(e.target.value)}
              />
              <span className="learn-scope-count">
                {scopeMode === 'last' && rangeValid ? inScope : '—'}
              </span>
            </label>
          </div>

          {/* Only the scope's own two mistakes live here. The "nothing in this
              range" case is stated once, in the footer, because it is a
              statement about the run rather than about a field — and the
              count column already reads `0` beside the chosen row. */}
          {scopeMode !== 'all' && !rangeValid ? (
            <div className="cfg-problems">
              <div className="cfg-problem is-blocking">{t('panel.learn.invalidRange')}</div>
            </div>
          ) : null}
        </div>

        <div className="learn-block">
          <div className="etb-label">{t('panel.learn.deliverables')}</div>
          <p className="set-hint">{t('panel.learn.deliverables.hint')}</p>
          {/* Native checkboxes wearing the app's own accent, in one wrapped
              row: four short type names, not four sentences. `.cfg-check` is
              the checkbox shape the configuration panel already uses, so a
              ticked box means the same thing in both panels. */}
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
        </div>

        <div className="learn-block">
          <div className="etb-label">{t('panel.learn.objectives')}</div>
          <textarea
            className="cfg-textarea"
            rows={2}
            value={objectives}
            onChange={(e) => setObjectives(e.target.value)}
            placeholder={t('panel.learn.objectives.placeholder')}
          />
        </div>

        <p className="set-hint cfg-takes-effect">{t('panel.learn.modelNote')}</p>
      </PanelBody>

      <div className="dialog-foot">
        {/* What is stopping Start, on the left where the settings and config
            panels keep the same kind of sentence. The button carries no
            tooltip of its own: a disabled control that explains itself only
            on hover explains itself to nobody. */}
        <span className="cfg-status">
          {blocker !== null ? (
            <span className={blocker.tone === 'error' ? 'cfg-status-error' : 'cfg-status-pending'}>
              {blocker.text}
            </span>
          ) : (
            /* Not `cfg-status-pending`: that colour is this dialog's word for
               "there is something you have not dealt with yet" (an unsaved
               edit, a blocked save). This line is the opposite — the form is
               ready — so it is plain muted text. */
            <span className="learn-fact">{t('panel.learn.footScope', { n: inScope })}</span>
          )}
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
      </div>
    </PanelShell>
  );
}

/** A whole number of at least 1 — "0 days" is not a range and "1.5 sessions"
 *  is not a count. */
function isWholeNumber(value: string): boolean {
  return value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 1;
}
