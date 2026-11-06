import { useEffect, useState } from 'react';
import { AlertTriangle, CircleAlert, Database, Play, RefreshCw } from 'lucide-react';
import { useT } from '@/i18n/useT';
import type { CodeIntelSnapshot } from '@/protocol/types';
import { useApp, useSessionField } from '@/state/store';
import { EmptyState, PanelInfo } from '@/components/ui/kit';
import { formatBytes, formatRelative, formatTokens } from '@/utils/format';
import { PanelBody, PanelShell } from './PanelShell';

/**
 * Code intelligence: the workspace's code index, and whether the model may use it.
 *
 * **Two facts, drawn as two facts.** `enabled` is the person's permission and
 * `indexed` is whether a database exists; all four combinations are reachable and each
 * one is a different situation:
 *
 *   - both on — the model has `code_explore`; this panel is where you see how fresh it is;
 *   - enabled, no index — the switch is on but there is nothing to search, which is the
 *     state a new workspace lands in, and the only way forward is **Initialize**;
 *   - indexed, disabled — an index exists and nothing uses it (the model has no such
 *     tool). Nothing is wrong; this is what "I turned it off" looks like;
 *   - neither — the default. Nothing exists and nothing was asked for.
 *
 * A panel that collapsed these into one boolean could not tell the second from the
 * fourth, and the sentence a person needs is different in each.
 *
 * **Nothing is patched here.** Every action answers with a fresh snapshot and this
 * component redraws from it. That matters more here than in most panels because a build
 * is *asynchronous*: `init` and `sync` acknowledge immediately and the pass narrates
 * itself through pushed `ui(codeintel)` messages, so `building` and `progress` arrive in
 * the same shape as everything else and there is no second channel to keep in step.
 *
 * **Initialize asks twice, and sync asks once.** `init` rebuilds from scratch, which on a
 * large tree is minutes of CPU and a window in which the index is not usable; `sync` only
 * tops up. The second press is the same pattern session deletion and terminal kill use —
 * the first press arms, the second acts, and anything else disarms.
 *
 * **The sheet's shape is the shell's, not a bespoke grid.** `design/workbench-light-v2/13`
 * puts the index and the repository selection in the main column and the permission and
 * the last run in the rail; the path is a mono line under the title rather than a path
 * bar, because it is the page's subject and not a value to copy. The shell supplies the
 * two columns (`rail`), so the body here is one column of sections and every card is the
 * shared `.wb-card`.
 */
export function CodeIntelPanel() {
  const t = useT();
  const snapshot = useSessionField((rt) => rt.codeintel, null);
  const problem = useSessionField((rt) => rt.codeintelProblem, null);
  const codeIntelAction = useApp((s) => s.codeIntelAction);
  const hasSession = useApp((s) => s.activeKey !== null);

  // The initialize button's arm. Local state rather than a store field: it is unsaved
  // intent, it must not survive closing the panel, and the menu-style rule is that
  // anything else (the scrim, Escape, another press) takes it back.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (snapshot?.building === true) setArmed(false);
  }, [snapshot?.building]);

  // The clear button's arm, same pattern: the first press arms, the second acts.
  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (snapshot?.building === true) setClearArmed(false);
  }, [snapshot?.building]);

  if (!hasSession) {
    return (
      <PanelShell title={t('panel.codeintel.title')} note={t('panel.codeintel.note')}>
        <PanelBody>
          <EmptyState title={t('panel.codeintel.noSession')} />
        </PanelBody>
      </PanelShell>
    );
  }

  // The repository selection is locked once made, so the checklist is only a
  // thing before the first index: absent `repos` + no index is the first run.
  const selectionOpen = snapshot !== null && snapshot.repos === undefined && !snapshot.indexed;
  const initBlocked = selectionOpen;

  // Sync lives in the head because it is the cheap, always-safe verb: it is what a
  // person reaches for after a fetch or a branch switch, and it must not be
  // competing with Initialize for the eye.
  const syncButton = (
    <button
      type="button"
      className="btn btn-outline"
      disabled={snapshot === null || snapshot.building || !snapshot.indexed || !snapshot.parser}
      onClick={() => codeIntelAction('sync')}
    >
      <RefreshCw size={13} />
      {t('panel.codeintel.sync')}
    </button>
  );

  if (snapshot === null) {
    return (
      <PanelShell title={t('panel.codeintel.title')} note={t('panel.codeintel.note')} actions={syncButton}>
        <PanelBody>
          {problem !== null ? <ProblemAlert text={`${t('panel.codeintel.problem')}: ${problem}`} /> : null}
          <EmptyState title={t('common.loading')} />
        </PanelBody>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title={t('panel.codeintel.title')}
      info={<PanelInfo label={t('panel.codeintel.note')} />}
      note={snapshot.workspace}
      actions={syncButton}
      rail={<CodeIntelRail snapshot={snapshot} onToggle={(enabled) => codeIntelAction('config', { enabled })} />}
    >
      {/* No `PanelBody`: with a rail the shell already draws the design's two
          columns, and a body inside one of them would add a second padding. */}
      <div className="ci-page">
        {/* The refusal banner. Drawn from `codeintelProblem`, not from a notice, because
          * the panel is a modal layer: a notice explaining a failed build is printed
          * behind this dialog. The runtime's own sentence is shown unaltered — it is the
          * authority on why. */}
        {problem !== null ? <ProblemAlert text={`${t('panel.codeintel.problem')}: ${problem}`} /> : null}

        <section className="wb-section">
          <div className="wb-label">{t('panel.codeintel.state')}</div>
          <IndexCard snapshot={snapshot} />
        </section>

        <section className="wb-section">
          <div className="wb-label">{t('panel.codeintel.reposTitle')}</div>
          <p className="cfg-hint">{t('panel.codeintel.reposHint')}</p>

          {/* The locked selection, as the same card of checkboxes the first run
              offers: checked and disabled, because the lock is the point. New
              repositories discovered after the lock are reported under it, never
              added to it. */}
          {snapshot.repos !== undefined ? (
            <>
              <div className="wb-card ci-repos-card">
                {snapshot.repos.map((repo) => (
                  <label key={repo || '.'} className="cfg-check ci-repo-row">
                    <input type="checkbox" checked disabled />
                    <span className="ci-repo-name">{repo === '' ? t('panel.codeintel.repoRoot') : repo}</span>
                  </label>
                ))}
              </div>
              <p className="cfg-hint">{t('panel.codeintel.reposLocked')}</p>
              {snapshot.new_repos && snapshot.new_repos.length > 0 ? (
                <p className="cfg-hint">{t('panel.codeintel.newRepos', { repos: snapshot.new_repos.join(', ') })}</p>
              ) : null}
            </>
          ) : selectionOpen ? (
            <RepoChecklist
              candidates={snapshot.candidates ?? ['']}
              onConfirm={(repos) => codeIntelAction('config', { enabled: snapshot.enabled, repos })}
            />
          ) : null}

          {/* The two verbs. The primary is the one the current state is
              missing — confirm before the first build, initialize when there is
              no index, and a two-press rebuild once there is one. */}
          <div className="ci-actions">
            {snapshot.indexed ? (
              <button
                type="button"
                className={`btn ${armed ? 'btn-danger' : 'btn-outline'}`}
                disabled={snapshot.building || !snapshot.parser}
                onClick={() => {
                  if (armed) {
                    setArmed(false);
                    codeIntelAction('init');
                    return;
                  }
                  setArmed(true);
                }}
              >
                <Database size={13} />
                {armed ? t('panel.codeintel.initConfirm') : t('panel.codeintel.initAgain')}
              </button>
            ) : (
              <button
                type="button"
                // While the selection is still open this is one of the sheet's
                // two secondaries, not the screen's primary: the confirm above
                // is. It is still disabled for the same reason.
                className={`btn ${initBlocked ? 'btn-outline' : 'btn-primary'}`}
                disabled={snapshot.building || !snapshot.parser || initBlocked}
                onClick={() => codeIntelAction('init')}
              >
                <Play size={13} />
                {t('panel.codeintel.init')}
              </button>
            )}
            {/* The only door back to the checklist: clear the index and the
              * locked selection. Two presses, for the same reason init has
              * two — it deletes a database a person may have been working
              * against for weeks. */}
            <button
              type="button"
              className={`btn ${clearArmed ? 'btn-danger' : 'btn-outline'}`}
              disabled={snapshot.building || (snapshot.repos === undefined && !snapshot.indexed)}
              onClick={() => {
                if (clearArmed) {
                  setClearArmed(false);
                  codeIntelAction('clear');
                  return;
                }
                setClearArmed(true);
              }}
            >
              {clearArmed ? t('panel.codeintel.clearConfirm') : t('panel.codeintel.clear')}
            </button>
          </div>

          {initBlocked ? (
            <p className="cfg-hint">{t('panel.codeintel.chooseReposFirst')}</p>
          ) : !snapshot.parser ? (
            <p className="cfg-hint">{t('panel.codeintel.noParser')}</p>
          ) : null}
        </section>
      </div>
    </PanelShell>
  );
}

/* ============================================================
   The index card
   ============================================================ */

/** The index's own facts. The sheet asks for one card holding the state's
 *  title and one sentence; when there is an index there is more to say, and
 *  that is the real data winning over the sheet's empty state. */
function IndexCard({ snapshot }: { snapshot: CodeIntelSnapshot }) {
  const t = useT();

  if (!snapshot.indexed) {
    return (
      <div className="wb-card ci-index-card">
        <div className="ci-index-title">{t('panel.codeintel.notIndexed')}</div>
        <p className="cfg-hint">{t('panel.codeintel.notIndexedHint', { path: snapshot.path })}</p>
      </div>
    );
  }

  return (
    <div className="wb-card ci-index-card">
      <div className="ci-facts">
        <Fact label={t('panel.codeintel.files')} value={formatTokens(snapshot.files)} />
        <Fact label={t('panel.codeintel.nodes')} value={formatTokens(snapshot.nodes)} />
        <Fact label={t('panel.codeintel.edges')} value={formatTokens(snapshot.edges)} />
        <Fact label={t('panel.codeintel.unresolved')} value={formatTokens(snapshot.unresolved)} />
      </div>
      <div className="ci-meta">
        <span className="ci-meta-path">{snapshot.path}</span>
        <span className="ci-meta-dot">·</span>
        <span>{formatBytes(snapshot.size_bytes)}</span>
        {snapshot.indexed_at ? (
          <>
            <span className="ci-meta-dot">·</span>
            <span>{t('panel.codeintel.built', { when: formatRelative(Date.parse(snapshot.indexed_at)) })}</span>
          </>
        ) : null}
      </div>

      {snapshot.building ? <BuildProgress snapshot={snapshot} /> : <StalenessLine snapshot={snapshot} />}

      {snapshot.problem !== '' ? (
        <div className="wb-alert is-error">
          <AlertTriangle className="wb-alert-icon" size={15} aria-hidden />
          <span>{snapshot.problem}</span>
        </div>
      ) : null}

      {snapshot.deferred > 0 || snapshot.heuristic > 0 ? (
        <div className="ci-coverage">
          <div className="wb-label">{t('panel.codeintel.coverage')}</div>
          {snapshot.deferred > 0 ? (
            <p className="cfg-hint">
              {t('panel.codeintel.deferred', {
                n: snapshot.deferred,
                languages: languageList(snapshot.deferred_by_language),
              })}
            </p>
          ) : null}
          {snapshot.heuristic > 0 ? (
            <p className="cfg-hint">
              {t('panel.codeintel.heuristic', {
                n: snapshot.heuristic,
                languages: languageList(snapshot.heuristic_by_language),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The build in flight. The track is always drawn, so the bar's appearance is the
 *  only thing that changes when a build starts. */
function BuildProgress({ snapshot }: { snapshot: CodeIntelSnapshot }) {
  const t = useT();
  return (
    <div className="ci-progress">
      <div className="ci-progress-row">
        <span className="ci-progress-phase">{snapshot.progress?.phase ?? t('panel.codeintel.starting')}</span>
        <span className="ci-progress-count">{progressLabel(snapshot)}</span>
      </div>
      <div
        className="ci-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progressPercent(snapshot) ?? undefined}
      >
        <div
          className="ci-progress-bar"
          style={progressPercent(snapshot) === null ? undefined : { width: `${progressPercent(snapshot)}%` }}
        />
      </div>
      {/* Said once, here, and nowhere else: there is no cancel button, and the
        * reason is that the build writes in place — stopping it would leave a
        * half-updated graph rather than the previous one. */}
      <p className="cfg-hint">{t('panel.codeintel.noCancel')}</p>
    </div>
  );
}

/** How far behind the working tree the index is — the panel's main warning. */
function StalenessLine({ snapshot }: { snapshot: CodeIntelSnapshot }) {
  const t = useT();
  const stale = snapshot.stale;

  if (stale.count === 0) {
    return (
      <div className="ci-fresh">
        <span className="ci-fresh-dot" />
        {t('panel.codeintel.fresh', { n: formatTokens(stale.checked) })}
      </div>
    );
  }
  return (
    <div className="wb-alert">
      <AlertTriangle className="wb-alert-icon" size={15} aria-hidden />
      <span>
        {t('panel.codeintel.stale', {
          count: stale.count,
          changed: stale.changed,
          added: stale.added,
          removed: stale.removed,
        })}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ci-fact">
      <span className="ci-fact-value">{value}</span>
      <span className="ci-fact-label">{label}</span>
    </div>
  );
}

/* ============================================================
   The rail
   ============================================================ */

/** `PERMISSION` and `LAST RUN`: the two facts the runtime computed, beside the
 *  fields that change them. The sheet puts the on/off tag at the label's trailing
 *  edge and the situation sentence inside the permission card. */
function CodeIntelRail({
  snapshot,
  onToggle,
}: {
  snapshot: CodeIntelSnapshot;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useT();
  const last = snapshot.last;
  return (
    <>
      <section className="wb-section ci-rail-section">
        <div className="wb-label-row">
          <span className="wb-label">{t('panel.codeintel.permission')}</span>
          <span className="grow" />
          <span className="wb-tag">{snapshot.enabled ? t('panel.codeintel.on') : t('panel.codeintel.off')}</span>
        </div>
        <div className="wb-card ci-perm-card">
          <div className="ci-perm-title">{t('panel.codeintel.enable')}</div>
          <p className="cfg-hint">{t('panel.codeintel.enableHint')}</p>
          {/* The toggle is the same 32×18 switch as everywhere else, drawn by
              hand rather than through `SwitchRow` because the sheet puts it
              between the two sentences instead of at the row's trailing edge. */}
          <button
            type="button"
            role="switch"
            aria-checked={snapshot.enabled}
            aria-label={t('panel.codeintel.enable')}
            className={`tk-switch${snapshot.enabled ? ' is-on' : ''}`}
            onClick={() => onToggle(!snapshot.enabled)}
          >
            <span className="tk-switch-knob" />
          </button>
          {/* Which of the four situations this is, in one sentence. Derived from the
            * two flags rather than stored, because a stored sentence is a second
            * thing that can disagree with them. */}
          <p className="cfg-hint">{situationOf(snapshot, t)}</p>
        </div>
      </section>

      <section className="wb-section ci-rail-section">
        <div className="wb-label">{t('panel.codeintel.lastRun')}</div>
        <div className="wb-card ci-last-card">
          {last ? (
            <>
              <div className="ci-last-row">
                <span className={last.ok ? 'ci-last-ok' : 'ci-last-bad'}>
                  {last.full ? t('panel.codeintel.lastInit') : t('panel.codeintel.lastSync')}
                </span>
                <span className="wb-value is-muted">{formatRelative(Date.parse(last.at))}</span>
              </div>
              <p className="cfg-hint">
                {last.ok
                  ? t('panel.codeintel.lastOk', {
                      files: formatTokens(last.files),
                      nodes: formatTokens(last.nodes),
                      edges: formatTokens(last.edges),
                    })
                  : last.problem}
              </p>
            </>
          ) : (
            <p className="cfg-hint">{t('panel.codeintel.lastNone')}</p>
          )}
        </div>
      </section>
    </>
  );
}

/** The body's one alert: a 2px rule and a wash, not a bordered box. */
function ProblemAlert({ text }: { text: string }) {
  return (
    <div className="wb-alert is-error" role="alert">
      <CircleAlert className="wb-alert-icon" size={15} aria-hidden />
      <span>{text}</span>
    </div>
  );
}

/* ============================================================
   Words and numbers
   ============================================================ */

/** One sentence per situation. The four combinations are what this panel is about. */
function situationOf(snapshot: CodeIntelSnapshot, t: ReturnType<typeof useT>): string {
  if (snapshot.enabled && !snapshot.indexed) return t('panel.codeintel.situation.enabledNoIndex');
  if (snapshot.enabled && snapshot.indexed) return t('panel.codeintel.situation.enabledIndexed');
  if (!snapshot.enabled && snapshot.indexed) return t('panel.codeintel.situation.disabledIndexed');
  return t('panel.codeintel.situation.disabledNoIndex');
}

/** `{done}/{total}`, or the phase name alone when the indexer does not report totals. */
function progressLabel(snapshot: CodeIntelSnapshot): string {
  const progress = snapshot.progress;
  if (!progress) return '';
  if (progress.total <= 0) return String(progress.done);
  return `${progress.done}/${progress.total}`;
}

/** Percentage, or null when the total is unknown — an indeterminate bar, not a fake 0%. */
function progressPercent(snapshot: CodeIntelSnapshot): number | null {
  const progress = snapshot.progress;
  if (!progress || progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)));
}

/** `go, python, c` — the languages behind a coverage number, or the empty string. */
function languageList(counts: Record<string, number>): string {
  return Object.keys(counts ?? {})
    .sort()
    .join(', ');
}

/**
 * The first-run repository checklist.
 *
 * Shown only while nothing has been chosen yet (absent `repos` + no index):
 * every candidate pre-checked — the default is "index everything you found" —
 * and the person confirms or unchecks before the first build. The confirmed
 * selection is **locked** from then on; the only door back is `clear`, which
 * is why the confirm here is a one-way act and needs no armed second press.
 *
 * The card and the full-width confirm are one unit because the confirm's
 * enabled state is this component's: the section around it supplies the label,
 * the explanation and the two verbs that wait for the choice.
 */
function RepoChecklist({
  candidates,
  onConfirm,
}: {
  candidates: string[];
  onConfirm: (repos: string[]) => void;
}) {
  const t = useT();
  const [checked, setChecked] = useState<Set<string>>(() => new Set(candidates));

  const toggle = (repo: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  };

  return (
    <>
      {/* One row per repository. `.cfg-check` is the checkbox shape the Learn and
          Configuration panels use — the same native input, tinted with the app's
          own accent — so a ticked box here means the same thing as there. */}
      <div className="wb-card ci-repos-card" role="group" aria-label={t('panel.codeintel.reposTitle')}>
        {candidates.map((repo) => (
          <label key={repo || '.'} className="cfg-check ci-repo-row">
            <input type="checkbox" checked={checked.has(repo)} onChange={() => toggle(repo)} />
            <span className="ci-repo-name">{repo === '' ? t('panel.codeintel.repoRoot') : repo}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary ci-confirm"
        disabled={checked.size === 0}
        onClick={() => onConfirm([...checked])}
      >
        {t('panel.codeintel.reposConfirm')}
      </button>
    </>
  );
}
