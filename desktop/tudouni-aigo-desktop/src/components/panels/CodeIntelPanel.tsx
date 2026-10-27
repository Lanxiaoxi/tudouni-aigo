import { useEffect, useState } from 'react';
import { AlertTriangle, Database, Play, RefreshCw } from 'lucide-react';
import { useT } from '@/i18n/useT';
import type { CodeIntelSnapshot } from '@/protocol/types';
import { useApp, useSessionField } from '@/state/store';
import { EmptyState } from '@/components/ui/kit';
import { SwitchRow } from '@/components/ui/SwitchRow';
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

  // The repository selection is locked once made, so the checklist is only a
  // thing before the first index: absent `repos` + no index is the first run.
  const selectionOpen = snapshot !== null && snapshot.repos === undefined && !snapshot.indexed;
  const initBlocked = selectionOpen;

  if (!hasSession) {
    return (
      <PanelShell title={t('panel.codeintel.title')} note={t('panel.codeintel.note')}>
        <PanelBody>
          <EmptyState title={t('panel.codeintel.noSession')} />
        </PanelBody>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title={t('panel.codeintel.title')}
      note={snapshot?.workspace ?? t('panel.codeintel.note')}
      actions={
        // Sync lives in the head because it is the cheap, always-safe verb: it is what a
        // person reaches for after a fetch or a branch switch, and it must not be
        // competing with Initialize for the eye.
        <button
          type="button"
          className="btn btn-outline"
          disabled={snapshot === null || snapshot.building || !snapshot.indexed || !snapshot.parser}
          onClick={() => codeIntelAction('sync')}
        >
          <RefreshCw size={13} />
          {t('panel.codeintel.sync')}
        </button>
      }
    >
      <PanelBody>
        {/* The refusal banner. Drawn from `codeintelProblem`, not from a notice, because
          * the panel is a modal layer: a notice explaining a failed build is printed
          * behind this dialog. The runtime's own sentence is shown unaltered — it is the
          * authority on why. */}
        {problem !== null ? (
          <div className="cfg-problems" role="alert">
            <div className="cfg-problem is-blocking">
              {t('panel.codeintel.problem')}: {problem}
            </div>
          </div>
        ) : null}

        {snapshot === null ? (
          <EmptyState title={t('common.loading')} />
        ) : (
          <div className="wm">
            <div className="wm-main">
              <div className="wm-legend">{t('panel.codeintel.state')}</div>
              <IndexFacts snapshot={snapshot} />

              {/* The locked selection, in one line: which repositories the index
                * covers, and — reported, never acted on — any repositories that
                * appeared after the lock. */}
              {snapshot.repos !== undefined ? (
                <div className="ci-repos-locked">
                  <span className="ci-repo-name">
                    {snapshot.repos.length === 1 && snapshot.repos[0] === ''
                      ? t('panel.codeintel.repoRoot')
                      : snapshot.repos.map((r) => (r === '' ? t('panel.codeintel.repoRoot') : r)).join(' + ')}
                  </span>
                  <span className="ci-hint">{t('panel.codeintel.reposLocked')}</span>
                  {snapshot.new_repos && snapshot.new_repos.length > 0 ? (
                    <span className="ci-hint ci-new-repos">
                      {t('panel.codeintel.newRepos', { repos: snapshot.new_repos.join(', ') })}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {snapshot.building ? (
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
                  <p className="ci-hint">{t('panel.codeintel.noCancel')}</p>
                </div>
              ) : null}

              {snapshot.deferred > 0 || snapshot.heuristic > 0 ? (
                <div className="wm-unreadable">
                  <div className="wm-legend">{t('panel.codeintel.coverage')}</div>
                  {snapshot.deferred > 0 ? (
                    <div className="wm-unreadable-line">
                      {t('panel.codeintel.deferred', {
                        n: snapshot.deferred,
                        languages: languageList(snapshot.deferred_by_language),
                      })}
                    </div>
                  ) : null}
                  {snapshot.heuristic > 0 ? (
                    <div className="ci-hint">
                      {t('panel.codeintel.heuristic', {
                        n: snapshot.heuristic,
                        languages: languageList(snapshot.heuristic_by_language),
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {selectionOpen ? (
                <RepoChecklist
                  candidates={snapshot.candidates ?? ['']}
                  onConfirm={(repos) => codeIntelAction('config', { enabled: snapshot.enabled, repos })}
                />
              ) : null}

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
                    className="btn btn-primary"
                    disabled={snapshot.building || !snapshot.parser || initBlocked}
                    onClick={() => codeIntelAction('init')}
                  >
                    <Play size={13} />
                    {t('panel.codeintel.init')}
                  </button>
                )}
                {!snapshot.parser ? (
                  <span className="ci-hint">{t('panel.codeintel.noParser')}</span>
                ) : null}
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
                <span className="ci-hint">{t('panel.codeintel.chooseReposFirst')}</span>
              ) : null}
            </div>

            <aside className="wm-side">
              <div className="wm-side-head">
                <span className="wm-side-title">{t('panel.codeintel.permission')}</span>
                <span className={`wm-pill${snapshot.enabled ? ' is-on' : ''}`}>
                  {snapshot.enabled ? t('panel.codeintel.on') : t('panel.codeintel.off')}
                </span>
              </div>
              <div className="wm-group">
                <SwitchRow
                  label={t('panel.codeintel.enable')}
                  hint={t('panel.codeintel.enableHint')}
                  checked={snapshot.enabled}
                  onChange={(enabled) => codeIntelAction('config', { enabled })}
                />
              </div>
              {/* Which of the four situations this is, in one sentence. Derived from the
                * two flags rather than stored, because a stored sentence is a second
                * thing that can disagree with them. */}
              <p className="ci-hint ci-state-hint">{situationOf(snapshot, t)}</p>

              <div className="wm-side-head ci-side-head">
                <span className="wm-side-title">{t('panel.codeintel.lastRun')}</span>
              </div>
              {snapshot.last ? (
                <div className="ci-last">
                  <div className="ci-last-row">
                    <span className={snapshot.last.ok ? 'ci-last-ok' : 'ci-last-bad'}>
                      {snapshot.last.full ? t('panel.codeintel.lastInit') : t('panel.codeintel.lastSync')}
                    </span>
                    <span className="ci-last-when">{formatRelative(Date.parse(snapshot.last.at))}</span>
                  </div>
                  <div className="ci-last-body">
                    {snapshot.last.ok
                      ? t('panel.codeintel.lastOk', {
                          files: formatTokens(snapshot.last.files),
                          nodes: formatTokens(snapshot.last.nodes),
                          edges: formatTokens(snapshot.last.edges),
                        })
                      : snapshot.last.problem}
                  </div>
                </div>
              ) : (
                <p className="ci-hint">{t('panel.codeintel.lastNone')}</p>
              )}
            </aside>
          </div>
        )}
      </PanelBody>
    </PanelShell>
  );
}

/** The index's own facts: four counts, then where it lives and how big it is. */
function IndexFacts({ snapshot }: { snapshot: CodeIntelSnapshot }) {
  const t = useT();

  if (!snapshot.indexed) {
    return (
      <div className="ci-facts ci-facts-empty">
        <div className="ci-fact-line">{t('panel.codeintel.notIndexed')}</div>
        <div className="ci-hint">{t('panel.codeintel.notIndexedHint', { path: snapshot.path })}</div>
      </div>
    );
  }

  return (
    <>
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
      {/* Not while a pass is running: the graph is mid-write, so the comparison
        * can only say "N files added" — which is the opposite of the progress
        * bar's message. The runtime omits the counts for the same reason. */}
      {snapshot.building ? null : <StalenessLine snapshot={snapshot} />}
      {snapshot.problem !== '' ? (
        <div className="ci-warn">
          <AlertTriangle size={13} />
          <span>{snapshot.problem}</span>
        </div>
      ) : null}
    </>
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
    <div className="ci-warn">
      <AlertTriangle size={13} />
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
    <div className="ci-repos">
      <div className="wm-legend">{t('panel.codeintel.reposTitle')}</div>
      <p className="ci-hint">{t('panel.codeintel.reposHint')}</p>
      <div className="ci-repos-list" role="group" aria-label={t('panel.codeintel.reposTitle')}>
        {candidates.map((repo) => (
          <label key={repo || '.'} className="ci-repo-row">
            <input
              type="checkbox"
              checked={checked.has(repo)}
              onChange={() => toggle(repo)}
            />
            <span className="ci-repo-name">{repo === '' ? t('panel.codeintel.repoRoot') : repo}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={checked.size === 0}
        onClick={() => onConfirm([...checked])}
      >
        {t('panel.codeintel.reposConfirm')}
      </button>
    </div>
  );
}
