import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  GitCompare,
  Paperclip,
  RefreshCw,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip, EmptyState } from '@/components/ui/kit';
import { isHosted, openFilePath } from '@/runtime/tauri';
import { copyText } from '@/utils/clipboard';
import { useWorkspaceUi } from '@/state/workspaceDock/selectors';
import { ancestorsOf } from '@/state/workspaceDock/dataCache';
import { NO_DECOR, decorFromStatus, letterTone, pickDiffSource } from '@/state/workspaceDock/gitModel';
import {
  buildTreeRows,
  isPathVisible,
  terminalDirFor,
  treeKeyAction,
  wantedDirs,
  type EntryRow,
  type TreeRow,
} from '@/state/workspaceDock/treeModel';
import type { HostEntry } from '@/workspaceHost';
import type { DockModuleProps } from '../modules';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { useDataState, useGitWhenStale, useHostClient, useWorkspaceCache } from '../data';
import { attachWorkspaceFile, insertPathIntoComposer, requestTerminalAt } from '../dockActions';
import { isBool, usePersistedPref } from '../dockPrefs';
import { beginPathDrag, dragJustEnded } from './dragFile';
import { gitLetterLabel } from '../git/letters';

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 200;
const INDENT_PX = 14;

interface MenuState {
  x: number;
  y: number;
  row: EntryRow;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Explorer's left half: a lazy file tree, a name search and the row menu
 * (docs/design/workspace-dock.md 5.2, 5.4).
 *
 * Listings and the Git letters come from the workspace's shared data cache, so a
 * mode switch or a session switch inside the workspace reloads nothing, and an
 * event refreshes only the directories it touched.
 */
export function ExplorerNav({ workspace, capabilities, columns }: DockModuleProps) {
  const t = useT();
  const id = workspace.workspaceId;
  const ui = useWorkspaceUi(id);
  const client = useHostClient(id);
  const cache = useWorkspaceCache(id);
  const data = useDataState(cache);
  const toggleDir = useApp((s) => s.toggleWorkspaceDir);
  const setSelectedFile = useApp((s) => s.setWorkspaceSelectedFile);
  const setGitSelection = useApp((s) => s.setWorkspaceGitSelection);
  const setSearchPref = useApp((s) => s.setWorkspaceSearch);
  const setDockPane = useApp((s) => s.setDockPane);
  const setDockMode = useApp((s) => s.setDockMode);
  const dockPick = useApp((s) => s.dockPick);
  const finishDockPick = useApp((s) => s.finishDockPick);
  const cancelDockPick = useApp((s) => s.cancelDockPick);

  const [showHidden, setShowHidden] = usePersistedPref('explorer.showHidden', false, isBool);
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ---------------- search ---------------- */
  const [input, setInput] = useState(ui.searchQuery);
  const [query, setQuery] = useState(ui.searchQuery.trim());
  const [hits, setHits] = useState<{ entries: HostEntry[]; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchTick, setSearchTick] = useState(0);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(input.trim());
      setSearchPref(id, input);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [input, id, setSearchPref]);

  useEffect(() => {
    if (query === '' || !client) {
      setHits(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let live = true;
    setSearching(true);
    client
      .fsSearch(query, { limit: SEARCH_LIMIT })
      .then((d) => {
        if (!live) return;
        setHits({ entries: Array.isArray(d.results) ? d.results : [], truncated: d.truncated === true });
        setSearchError(null);
      })
      .catch((err: unknown) => {
        if (live) setSearchError(messageOf(err));
      })
      .finally(() => {
        if (live) setSearching(false);
      });
    return () => {
      live = false;
    };
  }, [client, query, searchTick]);

  // A change on disk can add or remove a match.
  useEffect(() => {
    if (cache === null) return;
    return cache.onInvalidate((n) => {
      if (n.files) setSearchTick((x) => x + 1);
    });
  }, [cache]);

  /* ---------------- rows ---------------- */
  const inSearch = query !== '';
  const treeRows = useMemo(
    () => buildTreeRows(data.dirs, ui.expandedDirs, showHidden),
    [data.dirs, ui.expandedDirs, showHidden],
  );
  const searchRows = useMemo<EntryRow[]>(
    () =>
      (hits?.entries ?? [])
        .filter((e) => isPathVisible(e.path, showHidden))
        .map((e) => ({
          type: 'entry',
          path: e.path,
          name: e.name,
          depth: 0,
          kind: e.kind,
          expanded: false,
          hidden: e.hidden,
          loading: false,
        })),
    [hits, showHidden],
  );
  const rows: readonly TreeRow[] = inSearch ? searchRows : treeRows;

  // Load what the open directories need; a fresh one is skipped by the cache.
  const wanted = useMemo(() => wantedDirs(treeRows), [treeRows]);
  useEffect(() => {
    if (cache === null || inSearch) return;
    for (const dir of wanted) void cache.ensureDir(dir);
  }, [cache, wanted, data.dirs, inSearch]);

  // The tree's Git letters share the status the Git page draws.
  useGitWhenStale(cache, capabilities.git, data);
  const status = data.git.status;
  const decor = useMemo(
    () => (status?.repo ? decorFromStatus(status.entries) : NO_DECOR),
    [status],
  );

  /* ---------------- selection and focus ---------------- */
  const items = useMemo(() => rows.filter((r): r is EntryRow => r.type === 'entry'), [rows]);
  const focusPath =
    (focused !== null && items.some((r) => r.path === focused) ? focused : null) ??
    (ui.selectedFile !== null && items.some((r) => r.path === ui.selectedFile) ? ui.selectedFile : null) ??
    items[0]?.path ??
    null;

  // Bring the selected row into view once it exists (a jump from the Git page).
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const target = ui.selectedFile;
    if (target === null || scrolledFor.current === target || inSearch) return;
    const el = rowElement(listRef.current, target);
    if (el === null) return;
    scrolledFor.current = target;
    el.scrollIntoView({ block: 'nearest' });
  }, [ui.selectedFile, treeRows, inSearch]);

  function reveal(path: string) {
    for (const dir of ancestorsOf(path)) toggleDir(id, dir, true);
  }

  function selectFile(path: string) {
    // Choosing for the composer: hand the file over and leave the Explorer as it
    // was (the selection stays where the person had it).
    if (finishDockPick() === 'attach') {
      attachWorkspaceFile(path);
      return;
    }
    setSelectedFile(id, path);
    if (columns === 'single') setDockPane('viewer');
  }

  function activate(row: EntryRow) {
    setFocused(row.path);
    if (row.kind === 'dir') {
      if (inSearch) {
        // A directory hit ends the search: the tree is the answer.
        setInput('');
        setQuery('');
        reveal(row.path);
        toggleDir(id, row.path, true);
        return;
      }
      toggleDir(id, row.path);
      return;
    }
    if (inSearch) reveal(row.path);
    selectFile(row.path);
  }

  function focusRow(path: string) {
    setFocused(path);
    rowElement(listRef.current, path)?.focus();
  }

  function openMenuAt(row: EntryRow, x: number, y: number) {
    setFocused(row.path);
    setMenu({ x, y, row });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const row = items.find((r) => r.path === focusPath);
    if (row && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      const box = rowElement(listRef.current, row.path)?.getBoundingClientRect();
      openMenuAt(row, (box?.left ?? 0) + 24, (box?.bottom ?? 0) - 4);
      return;
    }
    const action = treeKeyAction(rows, focusPath, e.key);
    if (action === null) return;
    // A search list is flat: Left/Right have nothing to open or close.
    if (inSearch && (action.type === 'expand' || action.type === 'collapse')) return;
    e.preventDefault();
    if (action.type === 'focus') focusRow(action.path);
    else if (action.type === 'expand') toggleDir(id, action.path, true);
    else if (action.type === 'collapse') toggleDir(id, action.path, false);
    else {
      const target = items.find((r) => r.path === action.path);
      if (target) activate(target);
    }
  }

  /* ---------------- the row menu ---------------- */
  function menuItems(row: EntryRow): MenuItem[] {
    const isFile = row.kind !== 'dir';
    const out: MenuItem[] = [
      {
        id: 'copy',
        label: t('dock.explorer.menu.copyPath'),
        icon: <Copy size={13} />,
        onSelect: () => void copyText(row.path),
      },
      {
        id: 'insert',
        label: t('dock.explorer.menu.insertPath'),
        icon: <CornerDownLeft size={13} />,
        onSelect: () => insertPathIntoComposer(row.path),
      },
    ];
    if (isFile) {
      out.push({
        id: 'attach',
        label: t('dock.explorer.menu.attach'),
        icon: <Paperclip size={13} />,
        onSelect: () => attachWorkspaceFile(row.path),
      });
    }
    out.push({
      id: 'terminal',
      label: t('dock.explorer.menu.terminal'),
      icon: <Terminal size={13} />,
      onSelect: () => requestTerminalAt(terminalDirFor(row.path, row.kind)),
    });
    const source = capabilities.git && status?.repo && isFile ? pickDiffSource(status.entries, row.path) : null;
    if (source !== null) {
      out.push({
        id: 'diff',
        label: t('dock.explorer.menu.diff'),
        icon: <GitCompare size={13} />,
        onSelect: () => {
          setGitSelection(id, { path: row.path, source });
          setDockMode('git');
          if (columns === 'single') setDockPane('viewer');
        },
      });
    }
    // Only a local workspace has a file the OS can open; the host never offers
    // this (`system_open` is always false), and a remote path means nothing here.
    if (isFile && workspace.remoteWorkspaceId === null && isHosted()) {
      out.push({
        id: 'open',
        label: t('dock.explorer.menu.open'),
        icon: <ExternalLink size={13} />,
        onSelect: () => void openFilePath(workspace.root, row.path).catch(() => undefined),
      });
    }
    return out;
  }

  /* ---------------- drawing ---------------- */
  const count = hits === null ? null : searchRows.length;

  return (
    <div
      className="dock-explorer"
      onKeyDown={(e) => {
        // Esc leaves the choosing state; the search box's own Esc (clearing its
        // text) runs first and cancels the event.
        if (e.key === 'Escape' && dockPick !== null && !e.defaultPrevented) {
          e.preventDefault();
          cancelDockPick();
        }
      }}
    >
      {dockPick === 'attach' ? (
        <div className="dock-pick" role="status">
          <Paperclip size={13} aria-hidden="true" />
          <span className="dock-pick-text">{t('dock.explorer.pick.attach')}</span>
          <button type="button" className="btn btn-ghost btn-compact" onClick={cancelDockPick}>
            {t('common.cancel')}
          </button>
        </div>
      ) : null}
      <div className="dock-tools">
        <label className="input dock-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && input !== '') {
                e.preventDefault();
                setInput('');
                setQuery('');
              } else if (e.key === 'ArrowDown' && items.length > 0) {
                e.preventDefault();
                focusRow(items[0]!.path);
              }
            }}
            placeholder={t('dock.explorer.search.placeholder')}
            aria-label={t('dock.explorer.search.label')}
            spellCheck={false}
          />
          {input !== '' ? (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-compact"
              aria-label={t('dock.explorer.search.clear')}
              onClick={() => {
                setInput('');
                setQuery('');
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        <Tip label={showHidden ? t('dock.explorer.hidden.hide') : t('dock.explorer.hidden.show')}>
          <button
            type="button"
            className={`btn btn-ghost btn-icon btn-compact${showHidden ? ' is-on' : ''}`}
            aria-label={showHidden ? t('dock.explorer.hidden.hide') : t('dock.explorer.hidden.show')}
            aria-pressed={showHidden}
            onClick={() => setShowHidden(!showHidden)}
          >
            {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </Tip>
        <Tip label={t('dock.explorer.refresh')}>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-compact"
            aria-label={t('dock.explorer.refresh')}
            onClick={() => {
              cache?.invalidateAll();
              setSearchTick((x) => x + 1);
            }}
          >
            <RefreshCw size={13} />
          </button>
        </Tip>
      </div>

      {inSearch ? (
        <div className="dock-tree-status" aria-live="polite">
          {searchError !== null
            ? t('dock.explorer.search.error', { message: searchError })
            : count === null || (searching && count === 0)
              ? t('dock.explorer.search.searching')
              : hits?.truncated
                ? t('dock.explorer.search.countMore', { n: count })
                : t('dock.explorer.search.count', { n: count })}
        </div>
      ) : null}

      <div
        ref={listRef}
        className="dock-tree"
        role="tree"
        aria-label={t('dock.explorer.tree')}
        onKeyDown={onKeyDown}
      >
        {inSearch && hits !== null && searchRows.length === 0 && !searching ? (
          <EmptyState compact title={t('dock.explorer.search.none', { q: query })} />
        ) : null}
        {rows.map((row) =>
          row.type === 'note' ? (
            <div
              key={row.path}
              role="presentation"
              className={`dock-tree-note${row.note === 'error' ? ' is-error' : ''}`}
              style={{ paddingLeft: 8 + row.depth * INDENT_PX + 18 }}
            >
              {row.note === 'loading' ? t('dock.explorer.loading') : null}
              {row.note === 'empty' ? t('dock.explorer.empty') : null}
              {row.note === 'truncated' ? t('dock.explorer.truncated') : null}
              {row.note === 'error' ? (
                <>
                  <span>{t('dock.explorer.error', { message: row.detail ?? '' })}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={() => void cache?.ensureDir(row.dir, true)}
                  >
                    {t('dock.explorer.retry')}
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <TreeItem
              key={row.path}
              row={row}
              inSearch={inSearch}
              selected={ui.selectedFile === row.path}
              focusable={focusPath === row.path}
              letter={row.kind === 'dir' ? '' : (decor.letters.get(row.path) ?? '')}
              changed={row.kind === 'dir' && decor.dirs.has(row.path)}
              setSize={items.length}
              onActivate={() => {
                if (!dragJustEnded()) activate(row);
              }}
              onMenu={(x, y) => openMenuAt(row, x, y)}
              onFocusRow={() => setFocused(row.path)}
            />
          ),
        )}
      </div>

      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('dock.explorer.menu.label')}
          items={menuItems(menu.row)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

function rowElement(root: HTMLElement | null, path: string): HTMLElement | null {
  if (root === null) return null;
  for (const el of root.querySelectorAll<HTMLElement>('[data-tree-path]')) {
    if (el.dataset.treePath === path) return el;
  }
  return null;
}

interface TreeItemProps {
  row: EntryRow;
  inSearch: boolean;
  selected: boolean;
  focusable: boolean;
  letter: string;
  changed: boolean;
  setSize: number;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
  onFocusRow: () => void;
}

function TreeItem({ row, inSearch, selected, focusable, letter, changed, onActivate, onMenu, onFocusRow }: TreeItemProps) {
  const t = useT();
  const isDir = row.kind === 'dir';
  const parent = inSearch ? row.path.slice(0, Math.max(0, row.path.length - row.name.length - 1)) : '';

  function onContextMenu(e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    onMenu(e.clientX, e.clientY);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (isDir) return;
    beginPathDrag(e, row.path, row.name);
  }

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={isDir && !inSearch ? row.expanded : undefined}
      aria-selected={selected}
      aria-label={row.name}
      tabIndex={focusable ? 0 : -1}
      data-tree-path={row.path}
      className={`dock-tree-row${selected ? ' is-selected' : ''}${row.hidden ? ' is-hidden-file' : ''}`}
      style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
      onClick={onActivate}
      onFocus={onFocusRow}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
    >
      <span className="dock-tree-twist" aria-hidden="true">
        {isDir && !inSearch ? row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
      </span>
      <span className="dock-tree-icon" aria-hidden="true">
        {isDir ? row.expanded ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileIcon size={14} />}
      </span>
      <span className="dock-tree-name">{row.name}</span>
      {parent !== '' ? <span className="dock-tree-parent">{parent}</span> : null}
      {letter !== '' ? (
        <span
          className={`dock-letter is-${letterTone(letter)}`}
          title={gitLetterLabel(t, letter)}
          aria-label={gitLetterLabel(t, letter)}
        >
          {letter}
        </span>
      ) : null}
      {changed ? (
        <span className="dock-dot" title={t('dock.explorer.hasChanges')} aria-label={t('dock.explorer.hasChanges')} />
      ) : null}
    </div>
  );
}
