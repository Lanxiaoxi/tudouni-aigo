/**
 * The Dock's keyboard shortcuts (docs/design/workspace-dock.md §2.3).
 *
 * Chosen against the bindings that already exist (`useGlobalKeys`): `Ctrl+K`,
 * `B`, `L`, `S`, `T`, `F`, `\`, `1..9` and `Ctrl+Shift+R/P` (reload keys, which
 * are swallowed) are taken, and the old shell pane owns `Ctrl+Shift+\` and
 * `Ctrl+Shift+C`. None of the four below collides with them:
 *
 *   - `Ctrl+Shift+D` — the Dock itself. The design suggested `Ctrl+Shift+B`, and
 *     also said to pick something else because it reads as `Ctrl+B` (the right
 *     rail) with a modifier; D for Dock is unrelated to either.
 *   - `Ctrl+Shift+E` — Explorer, `Ctrl+Shift+G` — Git.
 *   - ``Ctrl+` `` — the Terminal Dock.
 *
 * Everything here is pure (no DOM, no store) so the matching and the state
 * transitions can be asserted: a shortcut that does nothing, or does the wrong
 * thing in one particular state, is invisible in a screenshot.
 */
import type { DockMode } from './uiState';

export type DockShortcut = 'dock' | 'explorer' | 'git' | 'terminal';

/** For tooltips. */
export const DOCK_SHORTCUT_LABELS: Record<DockShortcut, string> = {
  dock: 'Ctrl+Shift+D',
  explorer: 'Ctrl+Shift+E',
  git: 'Ctrl+Shift+G',
  terminal: 'Ctrl+`',
};

/** For `aria-keyshortcuts`. */
export const DOCK_SHORTCUT_ARIA: Record<DockShortcut, string> = {
  dock: 'Control+Shift+D',
  explorer: 'Control+Shift+E',
  git: 'Control+Shift+G',
  terminal: 'Control+`',
};

export interface DockKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Which Dock shortcut this key press is, if any.
 *
 * `altKey` disqualifies: on Windows AltGr arrives as Ctrl+Alt, and a European
 * layout types characters with it — those must stay ordinary typing.
 */
export function matchDockShortcut(e: DockKeyEvent): DockShortcut | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.shiftKey) {
    switch (e.key.toLowerCase()) {
      case 'd':
        return 'dock';
      case 'e':
        return 'explorer';
      case 'g':
        return 'git';
      default:
        return null;
    }
  }
  // `code` as well as `key`: some layouts need a dead key for the backtick.
  if (e.key === '`' || e.code === 'Backquote') return 'terminal';
  return null;
}

/** The attribute a terminal surface carries so the window leaves its keys alone. */
export const TERMINAL_FOCUS_ATTR = 'data-terminal-focus';

/**
 * Is the keyboard inside a Dock terminal?
 *
 * While it is, the window handler routes **only** the Dock shortcuts and
 * leaves every other key to the terminal (Ctrl+C, Esc, arrows, `Ctrl+K`…).
 * Structural parameter rather than `Element`, so the test needs no DOM.
 */
export function focusIsInDockTerminal(
  active: { closest(selector: string): unknown } | null | undefined,
): boolean {
  if (!active || typeof active.closest !== 'function') return false;
  return active.closest(`[${TERMINAL_FOCUS_ATTR}]`) !== null;
}

export interface DockWindowState {
  dockOpen: boolean;
  dockMode: DockMode;
  dockTermVisible: boolean;
}

/**
 * What a shortcut changes, as a patch.
 *
 * - `dock` toggles the column.
 * - `explorer` / `git` show that mode and open the dock; pressed again while
 *   that mode is what is showing, it closes the dock (the usual "toggle a
 *   view" feel). It never touches the terminal.
 * - `terminal` folds or unfolds the Terminal Dock; with the dock shut it opens
 *   the dock with the terminal showing, since that is what the press asked for.
 *
 * None of these touches a workspace resource: folding a terminal does not end
 * its process (§2.3).
 */
export function applyDockShortcut(
  s: DockWindowState,
  action: DockShortcut,
): Partial<DockWindowState> {
  switch (action) {
    case 'dock':
      return { dockOpen: !s.dockOpen };
    case 'explorer':
    case 'git':
      return s.dockOpen && s.dockMode === action
        ? { dockOpen: false }
        : { dockOpen: true, dockMode: action };
    case 'terminal':
      return s.dockOpen
        ? { dockTermVisible: !s.dockTermVisible }
        : { dockOpen: true, dockTermVisible: true };
  }
}
