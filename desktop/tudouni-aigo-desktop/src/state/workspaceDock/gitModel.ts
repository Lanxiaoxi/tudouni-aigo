/**
 * Git status as the Dock draws it (docs/design/workspace-dock.md 6.2, 6.4).
 *
 * Pure: the grouping and the tree decoration are the rules that are wrong
 * silently. The one that matters most is that a file with a change in the
 * index **and** another in the worktree is two rows in two groups, not one row
 * de-duplicated by path.
 */
import type { GitDiffSource, GitStatusEntry } from '@/workspaceHost/protocol';
import { ancestorsOf } from './dataCache';

export type GitGroupName = 'staged' | 'unstaged' | 'conflicts';

export interface GitRowItem {
  /** Unique across groups: the same path may appear in two. */
  key: string;
  group: GitGroupName;
  path: string;
  /** The old name when this row's change is a rename or copy; else `''`. */
  origPath: string;
  /** The one-letter status of **this** side (`M`, `A`, `D`, `R`, `?`, `U`...). */
  letter: string;
  /** Which `git_diff` shows this row. */
  source: GitDiffSource;
}

export interface GitGroups {
  staged: GitRowItem[];
  unstaged: GitRowItem[];
  conflicts: GitRowItem[];
}

const NONE = new Set(['.', ' ', '']);

function changed(letter: string): boolean {
  return !NONE.has(letter);
}

/**
 * Split status entries into the three groups.
 *
 *   - a conflict is only in Conflicts (its index/worktree letters are the
 *     unmerged pair, not two changes);
 *   - an untracked file is in Unstaged, with `?` and the `untracked` diff;
 *   - otherwise a changed index column is a Staged row and a changed worktree
 *     column an Unstaged row — **both** when both changed.
 *
 * `orig_path` belongs to a rename/copy, and a rename is one side's change: the
 * other side of the same file is an ordinary modification, so only a row whose
 * own letter is `R` or `C` carries the old name.
 */
export function groupGitStatus(entries: readonly GitStatusEntry[]): GitGroups {
  const out: GitGroups = { staged: [], unstaged: [], conflicts: [] };
  for (const e of entries) {
    if (e.conflict) {
      out.conflicts.push({
        key: `conflicts:${e.path}`,
        group: 'conflicts',
        path: e.path,
        origPath: '',
        letter: 'U',
        source: 'worktree',
      });
      continue;
    }
    if (e.untracked) {
      out.unstaged.push({
        key: `unstaged:${e.path}`,
        group: 'unstaged',
        path: e.path,
        origPath: '',
        letter: '?',
        source: 'untracked',
      });
      continue;
    }
    const renamed = (letter: string) => (letter === 'R' || letter === 'C' ? e.orig_path : '');
    if (changed(e.index)) {
      out.staged.push({
        key: `staged:${e.path}`,
        group: 'staged',
        path: e.path,
        origPath: renamed(e.index),
        letter: e.index,
        source: 'index',
      });
    }
    if (changed(e.worktree)) {
      out.unstaged.push({
        key: `unstaged:${e.path}`,
        group: 'unstaged',
        path: e.path,
        origPath: renamed(e.worktree),
        letter: e.worktree,
        source: 'worktree',
      });
    }
  }
  return out;
}

/** The three groups in display order (design 6.2), empty ones kept so a caller can decide. */
export const GIT_GROUP_ORDER: readonly GitGroupName[] = ['staged', 'unstaged', 'conflicts'];

/** The navigator's tracked/untracked filter. Only the unstaged group mixes the
 *  two kinds (a tracked worktree change and an untracked file); staged and
 *  conflict rows are tracked by construction, so the filter never touches them. */
export type GitFilter = 'all' | 'tracked' | 'untracked';

export const isGitFilter = (v: unknown): v is GitFilter => v === 'all' || v === 'tracked' || v === 'untracked';

/**
 * Apply the filter to the groups: keep every staged and conflict row, and from
 * unstaged only the rows whose kind matches — `untracked` rows are exactly
 * `source === 'untracked'` (the `?` letter is the same fact, read differently).
 * A no-op for `'all'`, returning the input unchanged so nothing re-renders.
 */
export function applyGitFilter(groups: GitGroups, filter: GitFilter): GitGroups {
  if (filter === 'all') return groups;
  const keep = (r: GitRowItem) => (r.source === 'untracked') === (filter === 'untracked');
  return { ...groups, unstaged: groups.unstaged.filter(keep) };
}

/** All rows in display order (Staged, Unstaged, Conflicts): the keyboard order. */
export function flattenGroups(groups: GitGroups): GitRowItem[] {
  return GIT_GROUP_ORDER.flatMap((g) => groups[g]);
}

export type LetterTone = 'mod' | 'add' | 'del' | 'rename' | 'untracked' | 'conflict';

export function letterTone(letter: string): LetterTone {
  switch (letter) {
    case 'A':
      return 'add';
    case 'D':
      return 'del';
    case 'R':
    case 'C':
      return 'rename';
    case '?':
      return 'untracked';
    case 'U':
      return 'conflict';
    default:
      return 'mod';
  }
}

/**
 * The single letter a file's tree row shows: a conflict first, then untracked,
 * then the worktree column (what is on disk now), then the index column.
 */
export function treeLetter(e: GitStatusEntry): string {
  if (e.conflict) return 'U';
  if (e.untracked) return '?';
  if (changed(e.worktree)) return e.worktree;
  if (changed(e.index)) return e.index;
  return '';
}

export interface GitDecor {
  /** Changed file → its letter. */
  letters: ReadonlyMap<string, string>;
  /** Every directory that contains a changed file (the dot on a tree row). */
  dirs: ReadonlySet<string>;
}

export const NO_DECOR: GitDecor = { letters: new Map(), dirs: new Set() };

export function decorFromStatus(entries: readonly GitStatusEntry[]): GitDecor {
  const letters = new Map<string, string>();
  const dirs = new Set<string>();
  for (const e of entries) {
    const letter = treeLetter(e);
    if (letter === '') continue;
    letters.set(e.path, letter);
    for (const dir of ancestorsOf(e.path)) dirs.add(dir);
  }
  return { letters, dirs };
}

/**
 * Which diff to open for a file the Explorer names: a conflict or a worktree
 * change shows the worktree diff (the thing on disk), an untracked file its
 * contents, and a file changed only in the index the staged diff. `null` when
 * the file has no change at all.
 */
export function pickDiffSource(entries: readonly GitStatusEntry[], path: string): GitDiffSource | null {
  const e = entries.find((x) => x.path === path);
  if (!e) return null;
  if (e.conflict) return 'worktree';
  if (e.untracked) return 'untracked';
  if (changed(e.worktree)) return 'worktree';
  if (changed(e.index)) return 'index';
  return null;
}
