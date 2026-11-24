/**
 * The Dock's per-workspace UI state (docs/design/workspace-dock.md §9.2).
 *
 * **Keyed by workspace, not by session.** Two conversations in one directory
 * share a file tree and a terminal, and switching between them must not move
 * either; closing a session must not forget where the person was. So none of
 * this hangs off a session bucket.
 *
 * Everything here is a pure function over plain data, for two reasons: the
 * rules (fold, evict, sanitise a stored record) are the part that is invisible
 * when wrong, and the store slice and the tests then share one implementation.
 */

/** The upper half's two modes; the terminal is not one of them (§2.3). */
export type DockMode = 'explorer' | 'git';

/** In single-column layout, which half is on screen. */
export type DockPane = 'navigator' | 'viewer';

/**
 * Why the Explorer is open as a file chooser, or `null` for the plain browser
 * (design 5.4: the composer's "attach file" entry opens the Explorer in a
 * selection state). Window-level and not persisted: a relaunch must not start
 * waiting for a choice nobody asked for.
 */
export type DockPick = null | 'attach';

/** Which comparison a Git diff shows (§6.3). */
export type GitDiffSource = 'worktree' | 'index' | 'untracked';

export interface GitSelection {
  path: string;
  source: GitDiffSource;
}

export interface WorkspaceUiState {
  /** Workspace-relative paths of the directories that are open. */
  expandedDirs: readonly string[];
  /** The file the Explorer's viewer shows. */
  selectedFile: string | null;
  /** The change the Git viewer shows, and which diff of it. */
  gitSelection: GitSelection | null;
  /** The terminal the Dock's tab strip had focused. May name a terminal that no
   *  longer exists after a host restart, so the module validates it. */
  activeTerminalId: string | null;
  /** The Explorer's file-name filter. */
  searchQuery: string;
}

/** A shared constant: store selectors must return a stable identity. */
export const EMPTY_WORKSPACE_UI: WorkspaceUiState = Object.freeze({
  expandedDirs: Object.freeze([]) as readonly string[],
  selectedFile: null,
  gitSelection: null,
  activeTerminalId: null,
  searchQuery: '',
});

/** How many workspaces' UI state is remembered; the least recently touched go first. */
export const MAX_REMEMBERED_WORKSPACES = 48;
/** A workspace that expands more directories than this stops remembering new ones. */
export const MAX_EXPANDED_DIRS = 2000;

const SOURCES: readonly GitDiffSource[] = ['worktree', 'index', 'untracked'];

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** One stored record, read back defensively: storage outlives every build. */
export function sanitizeWorkspaceUi(raw: unknown): WorkspaceUiState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_WORKSPACE_UI;
  const r = raw as Record<string, unknown>;
  const dirs = Array.isArray(r.expandedDirs)
    ? [...new Set(r.expandedDirs.filter((d): d is string => typeof d === 'string' && d !== ''))].slice(
        0,
        MAX_EXPANDED_DIRS,
      )
    : [];
  let git: GitSelection | null = null;
  if (typeof r.gitSelection === 'object' && r.gitSelection !== null) {
    const g = r.gitSelection as Record<string, unknown>;
    const path = stringOrNull(g.path);
    if (path !== null && SOURCES.includes(g.source as GitDiffSource)) {
      git = { path, source: g.source as GitDiffSource };
    }
  }
  return {
    expandedDirs: dirs,
    selectedFile: stringOrNull(r.selectedFile),
    gitSelection: git,
    activeTerminalId: stringOrNull(r.activeTerminalId),
    searchQuery: typeof r.searchQuery === 'string' ? r.searchQuery : '',
  };
}

export function sanitizeWorkspaceUiMap(raw: unknown): Record<string, WorkspaceUiState> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, WorkspaceUiState> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '') continue;
    out[id] = sanitizeWorkspaceUi(value);
  }
  return out;
}

function sameState(a: WorkspaceUiState, b: WorkspaceUiState): boolean {
  return (
    a.selectedFile === b.selectedFile &&
    a.activeTerminalId === b.activeTerminalId &&
    a.searchQuery === b.searchQuery &&
    a.gitSelection?.path === b.gitSelection?.path &&
    a.gitSelection?.source === b.gitSelection?.source &&
    a.expandedDirs.length === b.expandedDirs.length &&
    a.expandedDirs.every((d, i) => d === b.expandedDirs[i])
  );
}

/**
 * Apply a patch to one workspace's state.
 *
 * Returns **the same map** when nothing changed, so a no-op write neither
 * re-renders nor rewrites storage. A touched workspace moves to the end of the
 * map (the most recent), and the oldest are dropped past the cap — an object's
 * key order is the recency list, which is why the ids are never integer-like.
 */
export function withWorkspaceUi(
  map: Record<string, WorkspaceUiState>,
  workspaceId: string,
  patch: Partial<WorkspaceUiState>,
): Record<string, WorkspaceUiState> {
  if (workspaceId === '') return map;
  const before = map[workspaceId] ?? EMPTY_WORKSPACE_UI;
  const after: WorkspaceUiState = { ...before, ...patch };
  if (sameState(before, after)) return map;
  const rest: Record<string, WorkspaceUiState> = { ...map };
  delete rest[workspaceId];
  const next: Record<string, WorkspaceUiState> = { ...rest, [workspaceId]: after };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED_WORKSPACES))) delete next[id];
  return next;
}

/** The directory list with `path` opened or closed (toggled when `open` is omitted). */
export function withDirExpanded(
  dirs: readonly string[],
  path: string,
  open?: boolean,
): readonly string[] {
  const has = dirs.includes(path);
  const want = open ?? !has;
  if (want === has) return dirs;
  if (!want) return dirs.filter((d) => d !== path);
  if (dirs.length >= MAX_EXPANDED_DIRS) return dirs;
  return [...dirs, path];
}
