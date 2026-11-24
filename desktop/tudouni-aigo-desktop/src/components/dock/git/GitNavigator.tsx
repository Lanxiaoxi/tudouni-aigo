import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, GitBranch, RefreshCw } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Badge, EmptyState, Tip } from '@/components/ui/kit';
import { useWorkspaceUi } from '@/state/workspaceDock/selectors';
import {
  GIT_GROUP_ORDER,
  applyGitFilter,
  flattenGroups,
  groupGitStatus,
  isGitFilter,
  letterTone,
  type GitFilter,
  type GitGroupName,
  type GitRowItem,
} from '@/state/workspaceDock/gitModel';
import type { DockModuleProps } from '../modules';
import { useDataState, useGitCalibration, useGitWhenStale, useWorkspaceCache } from '../data';
import { usePersistedPref } from '../dockPrefs';
import { gitLetterLabel } from './letters';

const GROUP_LABEL = {
  staged: 'dock.git.group.staged',
  unstaged: 'dock.git.group.unstaged',
  conflicts: 'dock.git.group.conflicts',
} as const satisfies Record<GitGroupName, string>;

/** The filter's three stops, in the order the segmented control draws them. */
const FILTERS: readonly GitFilter[] = ['all', 'tracked', 'untracked'];

const GROUP_FILTER_LABEL = {
  all: 'dock.git.filter.all',
  tracked: 'dock.git.filter.tracked',
  untracked: 'dock.git.filter.untracked',
} as const satisfies Record<GitFilter, string>;

/**
 * The Git page's left half: the header and the grouped change list
 * (docs/design/workspace-dock.md 6.2). Read-only; a row selects the diff to show.
 */
export function GitNav({ workspace, columns }: DockModuleProps) {
  const t = useT();
  const id = workspace.workspaceId;
  const cache = useWorkspaceCache(id);
  const data = useDataState(cache);
  const selection = useWorkspaceUi(id).gitSelection;
  const setGitSelection = useApp((s) => s.setWorkspaceGitSelection);
  const setDockPane = useApp((s) => s.setDockPane);
  const [focused, setFocused] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Tracked / untracked filter on the change list. Persisted like the diff
  // layout: it is how this person likes to read, not where they were. Only the
  // unstaged group mixes the two kinds, so `applyGitFilter` leaves staged and
  // conflicts untouched.
  const [filter, setFilter] = usePersistedPref<GitFilter>('git.listFilter', 'all', isGitFilter);

  // This component is only mounted while the Git page is up, so being mounted
  // is "the page is visible": poll, and re-ask on focus.
  useGitCalibration(cache, true);
  useGitWhenStale(cache, true, data);

  const { status, loading, error, errorCode } = data.git;
  const groups = useMemo(() => (status?.repo ? groupGitStatus(status.entries) : null), [status]);
  const visibleGroups = useMemo(() => (groups === null ? null : applyGitFilter(groups, filter)), [groups, filter]);
  const flat = useMemo(() => (visibleGroups === null ? [] : flattenGroups(visibleGroups)), [visibleGroups]);
  // The unfiltered list, behind the "clean" empty state: a repo with changes
  // that the filter happens to hide must say "none match" rather than the
  // outright lie "no changes".
  const flatAll = useMemo(() => (groups === null ? [] : flattenGroups(groups)), [groups]);

  const selectedKey =
    selection === null
      ? null
      : (flat.find((r) => r.path === selection.path && r.source === selection.source)?.key ?? null);
  const focusKey =
    (focused !== null && flat.some((r) => r.key === focused) ? focused : null) ?? selectedKey ?? flat[0]?.key ?? null;

  function select(row: GitRowItem) {
    setFocused(row.key);
    setGitSelection(id, { path: row.path, source: row.source });
    if (columns === 'single') setDockPane('viewer');
  }

  function focusRow(key: string) {
    setFocused(key);
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-git-key]') ?? []) {
      if (el.dataset.gitKey === key) {
        el.focus();
        break;
      }
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey || flat.length === 0) return;
    const at = flat.findIndex((r) => r.key === focusKey);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(flat[Math.min(flat.length - 1, at + 1)]!.key);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(flat[Math.max(0, at - 1)]!.key);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusRow(flat[0]!.key);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusRow(flat[flat.length - 1]!.key);
    } else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) {
      e.preventDefault();
      select(flat[at]!);
    }
  }

  const refresh = (
    <Tip label={t('dock.git.refresh')}>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-compact"
        aria-label={t('dock.git.refresh')}
        disabled={loading}
        onClick={() => void cache?.ensureGit(true)}
      >
        <RefreshCw size={13} />
      </button>
    </Tip>
  );

  if (status === null) {
    return (
      <div className="dock-git">
        <div className="dock-git-head">
          <span className="dock-git-branch">
            <GitBranch size={13} aria-hidden="true" />
          </span>
          {refresh}
        </div>
        {error !== null ? (
          <EmptyState
            title={errorCode === 'not_git' ? t('dock.git.noGit.title') : t('dock.git.error.title')}
            hint={errorCode === 'not_git' ? t('dock.git.noGit.hint') : error}
          />
        ) : (
          <div className="dock-tree-status" aria-live="polite">
            {t('dock.git.loading')}
          </div>
        )}
      </div>
    );
  }

  if (!status.repo) {
    return (
      <div className="dock-git">
        <div className="dock-git-head">
          <span className="dock-git-branch">
            <GitBranch size={13} aria-hidden="true" />
          </span>
          {refresh}
        </div>
        <EmptyState title={t('dock.git.notRepo.title')} hint={t('dock.git.notRepo.hint')} />
      </div>
    );
  }

  const branchLabel = status.detached
    ? t('dock.git.detached')
    : status.branch !== ''
      ? status.branch
      : t('dock.git.noBranch');

  return (
    <div className="dock-git">
      <div className="dock-git-head">
        <div className="dock-git-id">
          <span className="dock-git-branch" title={branchLabel}>
            <GitBranch size={13} aria-hidden="true" />
            <span className="dock-git-branch-name">{branchLabel}</span>
          </span>
          {status.head !== '' ? <code className="dock-git-head-hash">{status.head}</code> : null}
        </div>
        {refresh}
      </div>
      <div className="dock-git-meta">
        {status.upstream !== '' ? (
          <span className="dock-git-upstream" title={t('dock.git.upstream', { name: status.upstream })}>
            {status.upstream}
          </span>
        ) : null}
        {status.ahead > 0 ? (
          <span className="dock-git-sync" title={t('dock.git.ahead', { n: status.ahead })}>
            ↑{status.ahead}
          </span>
        ) : null}
        {status.behind > 0 ? (
          <span className="dock-git-sync" title={t('dock.git.behind', { n: status.behind })}>
            ↓{status.behind}
          </span>
        ) : null}
        {status.unborn ? <Badge tone="info" dot={false}>{t('dock.git.unborn')}</Badge> : null}
        {status.detached ? <Badge tone="warning" dot={false}>{t('dock.git.detachedBadge')}</Badge> : null}
        {status.operation !== '' ? (
          <Badge tone="warning" dot={false}>
            {t('dock.git.operation', { name: status.operation })}
          </Badge>
        ) : null}
      </div>
      {error !== null ? (
        <div className="dock-view-banner is-error" role="alert">
          {t('dock.git.error.stale', { message: error })}
        </div>
      ) : null}
      {status.truncated ? (
        <div className="dock-view-banner" role="status">
          {t('dock.git.truncated')}
        </div>
      ) : null}

      {/* Tracked / untracked filter. It only ever narrows the unstaged group,
          so it is drawn whenever there are changes, and hidden for a clean
          repo (nothing to filter) and while loading. */}
      {flatAll.length > 0 ? (
        <div className="dock-git-filter" role="group" aria-label={t('dock.git.filter.label')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`dock-seg-btn${filter === f ? ' is-active' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(GROUP_FILTER_LABEL[f])}
            </button>
          ))}
        </div>
      ) : null}

      <div ref={listRef} className="dock-git-list" role="listbox" aria-label={t('dock.git.list')} onKeyDown={onKeyDown}>
        {flat.length === 0 ? (
          <EmptyState compact title={flatAll.length === 0 ? t('dock.git.clean') : t('dock.git.filter.empty')} />
        ) : (
          GIT_GROUP_ORDER.map((group) => {
            const rows = visibleGroups![group];
            if (rows.length === 0) return null;
            return (
              <div key={group} role="group" aria-label={t(GROUP_LABEL[group])} className="dock-git-group">
                <div className="dock-git-group-title" aria-hidden="true">
                  {t(GROUP_LABEL[group])}
                  <span className="dock-git-count">{rows.length}</span>
                </div>
                {rows.map((row) => {
                  const slash = row.path.lastIndexOf('/');
                  const dir = slash < 0 ? '' : row.path.slice(0, slash);
                  const base = row.path.slice(slash + 1);
                  return (
                    <div
                      key={row.key}
                      role="option"
                      aria-selected={selectedKey === row.key}
                      tabIndex={focusKey === row.key ? 0 : -1}
                      data-git-key={row.key}
                      className={`dock-tree-row dock-git-row${selectedKey === row.key ? ' is-selected' : ''}`}
                      title={row.origPath !== '' ? `${row.origPath} → ${row.path}` : row.path}
                      onClick={() => select(row)}
                      onFocus={() => setFocused(row.key)}
                    >
                      <span
                        className={`dock-letter is-${letterTone(row.letter)}`}
                        title={gitLetterLabel(t, row.letter)}
                        aria-label={gitLetterLabel(t, row.letter)}
                      >
                        {row.letter}
                      </span>
                      {row.origPath !== '' ? (
                        <span className="dock-tree-name dock-git-rename">
                          <span className="dock-git-old">{row.origPath}</span>
                          <ArrowRight size={11} aria-hidden="true" />
                          <span>{row.path}</span>
                        </span>
                      ) : (
                        <>
                          <span className="dock-tree-name">{base}</span>
                          {dir !== '' ? <span className="dock-tree-parent">{dir}</span> : null}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
