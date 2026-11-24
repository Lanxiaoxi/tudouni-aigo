import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileDiff, FolderTree, RefreshCw, X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { EmptyState, Tip } from '@/components/ui/kit';
import { useWorkspaceUi } from '@/state/workspaceDock/selectors';
import { shouldReloadDiff } from '@/state/workspaceDock/dataCache';
import {
  parseUnifiedDiff,
  splitAvailable,
  splitRows,
  type DiffHunk,
  type DiffLine,
} from '@/state/workspaceDock/diffParse';
import type { GitDiffData } from '@/workspaceHost';
import type { DockModuleProps } from '../modules';
import { useHostClient, useWorkspaceCache } from '../data';
import { usePersistedPref } from '../dockPrefs';

type Layout = 'unified' | 'split';
const isLayout = (v: unknown): v is Layout => v === 'unified' || v === 'split';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The Git page's right half: the diff of the selected change
 * (docs/design/workspace-dock.md 6.3). Unified always; Split only when the
 * viewer is wide enough to hold two columns of code.
 */
export function GitDiffViewer({ workspace, columns }: DockModuleProps) {
  const t = useT();
  const id = workspace.workspaceId;
  const selection = useWorkspaceUi(id).gitSelection;
  const client = useHostClient(id);
  const cache = useWorkspaceCache(id);
  const setSelectedFile = useApp((s) => s.setWorkspaceSelectedFile);
  const setGitSelection = useApp((s) => s.setWorkspaceGitSelection);
  const setDockMode = useApp((s) => s.setDockMode);
  const setDockPane = useApp((s) => s.setDockPane);

  const [data, setData] = useState<GitDiffData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pref, setPref] = usePersistedPref<Layout>('git.diffLayout', 'unified', isLayout);
  const [rootRef, width] = useWidth<HTMLDivElement>();

  const token = useRef(0);
  const selRef = useRef(selection);
  selRef.current = selection;
  const origRef = useRef('');
  origRef.current = data?.old_path ?? '';

  const load = useCallback(
    async (path: string, source: NonNullable<typeof selection>['source']) => {
      if (!client) return;
      const my = ++token.current;
      setLoading(true);
      try {
        const d = await client.gitDiff(path, source);
        if (my !== token.current) return;
        setData(d);
        setError(null);
      } catch (err) {
        if (my !== token.current) return;
        setData(null);
        setError(messageOf(err));
      } finally {
        if (my === token.current) setLoading(false);
      }
    },
    [client],
  );

  const path = selection?.path ?? null;
  const source = selection?.source ?? null;
  useEffect(() => {
    token.current += 1;
    setData(null);
    setError(null);
    if (path === null || source === null) {
      setLoading(false);
      return;
    }
    void load(path, source);
  }, [path, source, load]);

  // The selected file (or the index/HEAD under it) changed: ask again.
  useEffect(() => {
    if (cache === null) return;
    return cache.onInvalidate((notice) => {
      const sel = selRef.current;
      if (sel === null || !shouldReloadDiff(notice, sel.path, origRef.current)) return;
      void load(sel.path, sel.source);
    });
  }, [cache, load]);

  const parsed = useMemo(() => (data === null ? null : parseUnifiedDiff(data.diff)), [data]);
  const canSplit = splitAvailable(width);
  const layout: Layout = canSplit && pref === 'split' ? 'split' : 'unified';

  if (selection === null) {
    return (
      <div className="dock-placeholder">
        <EmptyState icon={<FileDiff size={18} />} title={t('dock.placeholder.viewer.git')} />
      </div>
    );
  }

  const name = selection.path.slice(selection.path.lastIndexOf('/') + 1);
  const renameFrom = data?.old_path || parsed?.renameFrom || '';

  const openInExplorer = () => {
    setSelectedFile(id, selection.path);
    setDockMode('explorer');
    if (columns === 'single') setDockPane('viewer');
  };

  // The way back from a diff to the placeholder: nothing else clears the
  // selection, so without this a person who opens one file is stuck on it —
  // in single-column mode the "Back" button only returns to the list, and in
  // dual mode there is no back button at all.
  const closeDiff = () => {
    setGitSelection(id, null);
    if (columns === 'single') setDockPane('navigator');
  };

  return (
    <div className="dock-view" ref={rootRef}>
      <div className="dock-view-head">
        <span className="dock-view-title" title={selection.path}>
          {name}
          <span className="dock-view-path">{selection.path}</span>
        </span>
        <span className="dock-view-actions">
          {canSplit ? (
            <span className="dock-seg" role="group" aria-label={t('dock.git.diff.layout')}>
              <button
                type="button"
                className={`dock-seg-btn${layout === 'unified' ? ' is-active' : ''}`}
                aria-pressed={layout === 'unified'}
                onClick={() => setPref('unified')}
              >
                {t('dock.git.diff.unified')}
              </button>
              <button
                type="button"
                className={`dock-seg-btn${layout === 'split' ? ' is-active' : ''}`}
                aria-pressed={layout === 'split'}
                onClick={() => setPref('split')}
              >
                {t('dock.git.diff.split')}
              </button>
            </span>
          ) : null}
          <Tip label={t('dock.git.diff.refresh')}>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-compact"
              aria-label={t('dock.git.diff.refresh')}
              onClick={() => void load(selection.path, selection.source)}
            >
              <RefreshCw size={13} />
            </button>
          </Tip>
          <Tip label={t('dock.git.diff.openInExplorer')}>
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={openInExplorer}
              disabled={selection.source === 'index' && parsed?.deletedFile === true}
            >
              <FolderTree size={13} />
              {t('dock.git.diff.openInExplorer')}
            </button>
          </Tip>
          <Tip label={t('dock.git.diff.close')}>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-compact"
              aria-label={t('dock.git.diff.close')}
              onClick={closeDiff}
            >
              <X size={13} />
            </button>
          </Tip>
        </span>
      </div>
      <div className="dock-view-meta">
        {t(`dock.git.source.${selection.source}` as 'dock.git.source.worktree')}
        {parsed !== null && !data?.binary ? (
          <>
            {' · '}
            <span className="dock-diff-add-count">+{parsed.added}</span>{' '}
            <span className="dock-diff-del-count">−{parsed.removed}</span>
          </>
        ) : null}
        {renameFrom !== '' ? (
          <span className="dock-diff-rename">
            {' · '}
            {renameFrom}
            <ArrowRight size={11} aria-hidden="true" />
            {selection.path}
          </span>
        ) : null}
      </div>
      {data?.truncated ? (
        <div className="dock-view-banner" role="status">
          {t('dock.git.diff.truncated')}
        </div>
      ) : null}
      <div className="dock-view-body">
        {error !== null ? (
          <EmptyState title={t('dock.git.diff.failed')} hint={error} />
        ) : data === null ? (
          <div className="dock-view-note" aria-live="polite">
            {loading ? t('dock.git.diff.loading') : null}
          </div>
        ) : data.binary || parsed?.binary ? (
          <EmptyState icon={<FileDiff size={18} />} title={t('dock.git.diff.binary')} />
        ) : parsed === null || parsed.hunks.length === 0 ? (
          <EmptyState
            icon={<FileDiff size={18} />}
            title={t(renameFrom !== '' ? 'dock.git.diff.renameOnly' : 'dock.git.diff.empty')}
          />
        ) : (
          <div className={`dock-diff is-${layout}`} role="table" aria-label={t('dock.git.diff.label', { name })}>
            {parsed.hunks.map((hunk, i) =>
              layout === 'split' ? <SplitHunk key={i} hunk={hunk} /> : <UnifiedHunk key={i} hunk={hunk} />,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SIGN = { add: '+', del: '−', context: ' ' } as const;

function Marker() {
  const t = useT();
  return <div className="dock-diff-nonl">{t('dock.git.diff.noNewline')}</div>;
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="dock-diff-hunk" role="rowgroup">
      <div className="dock-diff-hunkhead" role="row">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => (
        <div key={i} role="row">
          <div className={`dock-diff-row is-${line.kind}`}>
            <span className="dock-diff-no" aria-hidden="true">
              {line.oldNo ?? ''}
            </span>
            <span className="dock-diff-no" aria-hidden="true">
              {line.newNo ?? ''}
            </span>
            <span className="dock-diff-sign" aria-hidden="true">
              {SIGN[line.kind]}
            </span>
            <span className="dock-diff-text" role="cell">
              {line.text}
            </span>
          </div>
          {line.noNewline ? <Marker /> : null}
        </div>
      ))}
    </div>
  );
}

function Cell({ line, side }: { line: DiffLine | null; side: 'left' | 'right' }) {
  if (line === null) return <div className="dock-diff-cell is-empty" aria-hidden="true" />;
  const no = side === 'left' ? line.oldNo : line.newNo;
  return (
    <div className={`dock-diff-cell is-${line.kind}`} role="cell">
      <span className="dock-diff-no" aria-hidden="true">
        {no ?? ''}
      </span>
      <span className="dock-diff-sign" aria-hidden="true">
        {SIGN[line.kind]}
      </span>
      <span className="dock-diff-text">{line.text}</span>
    </div>
  );
}

function SplitHunk({ hunk }: { hunk: DiffHunk }) {
  const rows = useMemo(() => splitRows(hunk.lines), [hunk]);
  return (
    <div className="dock-diff-hunk" role="rowgroup">
      <div className="dock-diff-hunkhead" role="row">
        {hunk.header}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="dock-diff-split" role="row">
          <Cell line={row.left} side="left" />
          <Cell line={row.right} side="right" />
        </div>
      ))}
    </div>
  );
}
