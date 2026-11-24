/**
 * The Explorer's tree as rows (docs/design/workspace-dock.md 5.2).
 *
 * Pure: which rows exist, in what order, and what a key does to the focused one.
 * The component only draws them and forwards keys, so the arithmetic that is
 * wrong silently (a hidden file shown, `.git` shown, Left landing on the wrong
 * parent) is asserted here instead of clicked through.
 */
import type { HostEntry, HostEntryKind } from '@/workspaceHost/protocol';
import type { DirState } from './dataCache';

export interface EntryRow {
  type: 'entry';
  path: string;
  name: string;
  depth: number;
  kind: HostEntryKind;
  expanded: boolean;
  hidden: boolean;
  /** The row of an open directory whose listing is not there yet. */
  loading: boolean;
}

/** A line that is not an item: "loading", "empty", an error, "truncated". It
 *  is never focusable and keys skip it. */
export interface NoteRow {
  type: 'note';
  /** Unique among rows. */
  path: string;
  depth: number;
  note: 'loading' | 'empty' | 'error' | 'truncated';
  /** The error text when `note` is `error`. */
  detail: string | null;
  /** The directory the note is about. */
  dir: string;
}

export type TreeRow = EntryRow | NoteRow;

/** `.git` is never listed; dotfiles only when the toggle says so. */
export function isEntryVisible(entry: Pick<HostEntry, 'name' | 'hidden'>, showHidden: boolean): boolean {
  if (entry.name === '.git') return false;
  return showHidden || !entry.hidden;
}

/** A search hit is visible when none of its path segments is hidden (or the
 *  toggle is on): a file inside `.config/` is as hidden as `.config` itself. */
export function isPathVisible(path: string, showHidden: boolean): boolean {
  const parts = path.split('/');
  if (parts.includes('.git')) return false;
  return showHidden || !parts.some((p) => p.startsWith('.'));
}

/**
 * Flatten the cached listings into the rows to draw. Only directories that are
 * open are walked, and a directory with no listing yet contributes a
 * "loading" note instead of children.
 */
export function buildTreeRows(
  dirs: Readonly<Record<string, DirState>>,
  expanded: readonly string[],
  showHidden: boolean,
): TreeRow[] {
  const open = new Set(expanded);
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir];
    if (!state || (!state.loaded && state.error === null)) {
      rows.push({ type: 'note', path: `${dir}\0loading`, depth, note: 'loading', detail: null, dir });
      return;
    }
    if (!state.loaded && state.error !== null) {
      rows.push({ type: 'note', path: `${dir}\0error`, depth, note: 'error', detail: state.error, dir });
      return;
    }
    let shown = 0;
    for (const entry of state.entries) {
      if (!isEntryVisible(entry, showHidden)) continue;
      shown += 1;
      const isOpen = entry.kind === 'dir' && open.has(entry.path);
      rows.push({
        type: 'entry',
        path: entry.path,
        name: entry.name,
        depth,
        kind: entry.kind,
        expanded: isOpen,
        hidden: entry.hidden,
        loading: isOpen && (!dirs[entry.path] || (!dirs[entry.path]!.loaded && dirs[entry.path]!.error === null)),
      });
      if (isOpen) walk(entry.path, depth + 1);
    }
    if (shown === 0) rows.push({ type: 'note', path: `${dir}\0empty`, depth, note: 'empty', detail: null, dir });
    if (state.truncated) rows.push({ type: 'note', path: `${dir}\0truncated`, depth, note: 'truncated', detail: null, dir });
    // A refresh that failed keeps the old listing; the error is still worth a line.
    if (state.error !== null) rows.push({ type: 'note', path: `${dir}\0error`, depth, note: 'error', detail: state.error, dir });
  };

  walk('', 0);
  return rows;
}

/** The open directories the rows reach: what the view needs listed. */
export function wantedDirs(rows: readonly TreeRow[]): string[] {
  const out = [''];
  for (const r of rows) if (r.type === 'entry' && r.kind === 'dir' && r.expanded) out.push(r.path);
  return out;
}

/* ============================================================
   Keys
   ============================================================ */

export type TreeAction =
  | { type: 'focus'; path: string }
  | { type: 'expand'; path: string }
  | { type: 'collapse'; path: string }
  | { type: 'activate'; path: string };

/**
 * What a key does, given the rows and the focused path. `null` is "not a tree
 * key" (the caller leaves it alone, so Tab and typing still work).
 *
 *   Down/Up      next / previous item;     Home/End  first / last item
 *   Right        collapsed dir → open it; open dir → its first child
 *   Left         open dir → close it;     else → the parent directory
 *   Enter/Space  activate (open a dir, preview a file)
 */
export function treeKeyAction(rows: readonly TreeRow[], focused: string | null, key: string): TreeAction | null {
  const items = rows.filter((r): r is EntryRow => r.type === 'entry');
  if (items.length === 0) return null;
  const at = focused === null ? -1 : items.findIndex((r) => r.path === focused);
  const cur = at >= 0 ? items[at]! : null;
  const focus = (i: number): TreeAction => ({ type: 'focus', path: items[Math.max(0, Math.min(items.length - 1, i))]!.path });

  switch (key) {
    case 'ArrowDown':
      return focus(at + 1);
    case 'ArrowUp':
      return focus(at < 0 ? 0 : at - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(items.length - 1);
    case 'ArrowRight': {
      if (cur === null || cur.kind !== 'dir') return null;
      if (!cur.expanded) return { type: 'expand', path: cur.path };
      const next = items[at + 1];
      return next !== undefined && next.depth === cur.depth + 1 ? { type: 'focus', path: next.path } : null;
    }
    case 'ArrowLeft': {
      if (cur === null) return null;
      if (cur.kind === 'dir' && cur.expanded) return { type: 'collapse', path: cur.path };
      for (let i = at - 1; i >= 0; i -= 1) {
        if (items[i]!.depth < cur.depth) return { type: 'focus', path: items[i]!.path };
      }
      return null;
    }
    case 'Enter':
    case ' ':
      return cur === null ? null : { type: 'activate', path: cur.path };
    default:
      return null;
  }
}

/** The directory a "new terminal here" should use: the row itself for a
 *  directory, its parent for a file. */
export function terminalDirFor(path: string, kind: HostEntryKind): string {
  if (kind === 'dir') return path;
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
