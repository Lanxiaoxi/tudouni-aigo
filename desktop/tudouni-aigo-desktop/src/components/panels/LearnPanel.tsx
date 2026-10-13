import { useMemo, useState } from 'react';
import { AlertCircle, Check, FolderOpen } from 'lucide-react';
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
import { baseName, formatPath } from '@/utils/format';

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
 * Plain native radios and checkboxes: this build does not take a Radix
 * checkbox/radio package, and the other forms that need the controls
 * (`CloseConfirm`, `ConfigPanel`) use the same native inputs.
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
            the file boundary it works under is exactly this directory. */}
        <div className="etb-label">{t('panel.learn.workspace')}</div>
        {noWorkspace ? (
          <div className="learn-warn">
            <AlertCircle size={13} />
            <span>{t('panel.learn.noWorkspace')}</span>
          </div>
        ) : (
          <div className="learn-workspace" title={workspace}>
            <FolderOpen size={14} style={{ flex: 'none', color: 'var(--fg-muted)' }} />
            <span className="learn-workspace-base">{baseName(workspace)}</span>
            <span className="learn-workspace-path">{formatPath(workspace, 64)}</span>
          </div>
        )}

        <div className="learn-section">{t('panel.learn.scope')}</div>
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
            <span className="learn-scope-text">
              {t('panel.learn.scope.days', { n: daysValid ? days : '…' })}
            </span>
            <input
              className="learn-scope-num"
              inputMode="numeric"
              aria-label={t('panel.learn.scope.daysPlaceholder')}
              placeholder={t('panel.learn.scope.daysPlaceholder')}
              value={days}
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
            <span className="learn-scope-text">
              {t('panel.learn.scope.last', { n: countValid ? count : '…' })}
            </span>
            <input
              className="learn-scope-num"
              inputMode="numeric"
              aria-label={t('panel.learn.scope.countPlaceholder')}
              placeholder={t('panel.learn.scope.countPlaceholder')}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
            <span className="learn-scope-count">
              {scopeMode === 'last' && rangeValid ? inScope : '—'}
            </span>
          </label>
        </div>

        {scopeMode !== 'all' && !rangeValid ? (
          <div className="learn-warn">
            <AlertCircle size={13} />
            <span>{t('panel.learn.invalidRange')}</span>
          </div>
        ) : null}
        {rangeValid && inScope === 0 ? (
          <div className="learn-warn">
            <AlertCircle size={13} />
            <span>
              {eligible.length === 0 ? t('panel.learn.scope.none') : t('panel.learn.invalidRange')}
            </span>
          </div>
        ) : null}

        <div className="learn-section">{t('panel.learn.deliverables')}</div>
        <p className="learn-deliverables-hint">{t('panel.learn.deliverables.hint')}</p>
        <div className="learn-deliverables">
          {DELIVERABLES.map((which) => (
            <label key={which} className="learn-deliverable">
              <input
                type="checkbox"
                checked={picked.includes(which)}
                onChange={() => toggleDeliverable(which)}
                aria-label={which}
              />
              <span className="learn-deliverable-icon">
                <Check size={11} strokeWidth={3} />
              </span>
              <span className="learn-deliverable-text">{which}</span>
            </label>
          ))}
        </div>
        {picked.length === 0 ? (
          <div className="learn-warn">
            <AlertCircle size={13} />
            <span>{t('panel.learn.noneSelected')}</span>
          </div>
        ) : null}

        <div className="learn-section">{t('panel.learn.objectives')}</div>
        <textarea
          className="learn-focus"
          rows={2}
          value={objectives}
          onChange={(e) => setObjectives(e.target.value)}
          placeholder={t('panel.learn.objectives.placeholder')}
        />

        <p className="caption faint" style={{ marginTop: 'var(--space-4)' }}>
          {t('panel.learn.modelNote')}
        </p>
      </PanelBody>

      <div className="dialog-foot">
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
