/**
 * Workspace Dock slice (docs/design/workspace-dock.md §9).
 *
 * Two kinds of state, deliberately kept apart:
 *
 *   - **window** — open, mode, the three size preferences, the terminal's
 *     visibility. Persisted through `persistPrefs` with the other presentation
 *     prefs.
 *   - **per workspace** — `workspaceUi[workspaceId]`. Persisted in its own
 *     record, and never on a session bucket: two conversations in one directory
 *     share it, and closing one must not forget where the person was.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { persistPrefs } from '../prefs';
import { clampDockNavWidth, clampDockTermHeight, clampDockWidth } from '../workspaceDock/budget';
import { saveWorkspaceUi } from '../workspaceDock/persist';
import { applyDockShortcut } from '../workspaceDock/shortcuts';
import { withDirExpanded, withWorkspaceUi, type WorkspaceUiState } from '../workspaceDock/uiState';

type DockSliceKeys =
  | 'setDockOpen'
  | 'toggleDock'
  | 'setDockMode'
  | 'startDockPick'
  | 'finishDockPick'
  | 'cancelDockPick'
  | 'runDockShortcut'
  | 'setDockWidth'
  | 'setDockNavWidth'
  | 'setDockTermHeight'
  | 'setDockTermVisible'
  | 'setDockTermMaximized'
  | 'setDockPane'
  | 'toggleWorkspaceDir'
  | 'setWorkspaceSelectedFile'
  | 'setWorkspaceGitSelection'
  | 'setWorkspaceActiveTerminal'
  | 'setWorkspaceSearch'
  | 'forgetWorkspaceUi';

export function workspaceDockSlice(ctx: StoreContext): Pick<AppStore, DockSliceKeys> {
  const { set, get } = ctx;

  /** Write a window-level patch and persist it (only when something changed). */
  const setWindow = (patch: Partial<AppStore>) => {
    const s = get();
    const changed = (Object.keys(patch) as (keyof AppStore)[]).some((k) => s[k] !== patch[k]);
    if (!changed) return;
    set(patch);
    persistPrefs(get());
  };

  /** Abandon a pending file choice (a no-op when there is none). */
  const clearPick = () => {
    if (get().dockPick !== null) set({ dockPick: null });
  };

  /** Patch one workspace's state; a no-op patch writes nothing. */
  const patchWorkspace = (workspaceId: string, patch: Partial<WorkspaceUiState>) => {
    const before = get().workspaceUi;
    const after = withWorkspaceUi(before, workspaceId, patch);
    if (after === before) return;
    set({ workspaceUi: after });
    saveWorkspaceUi(after);
  };

  return {
    setDockOpen(open) {
      // Closing the dock abandons a pending choice: nothing would be left on
      // screen to make it with.
      if (!open) clearPick();
      setWindow({ dockOpen: open });
    },

    toggleDock() {
      if (get().dockOpen) clearPick();
      setWindow({ dockOpen: !get().dockOpen });
    },

    setDockMode(mode) {
      // Showing a mode shows the dock: the mode switch is only reachable from a
      // shortcut or a control that has just opened it, and a mode change with
      // nothing visible would be a key that appears to do nothing.
      //
      // A file choice only makes sense in the Explorer, so leaving it cancels.
      if (mode !== 'explorer') clearPick();
      setWindow({ dockMode: mode, dockOpen: true });
    },

    startDockPick(pick) {
      // Window state, not persisted (see `DockPick`). The navigator half is shown
      // because the choice is made there, even if the single-column layout was
      // left on the viewer.
      set({ dockPick: pick, dockPane: 'navigator' });
      setWindow({ dockMode: 'explorer', dockOpen: true });
    },

    finishDockPick() {
      // Hands back what was pending so the caller acts on it exactly once; a
      // second click finds `null` and behaves like an ordinary selection.
      const pending = get().dockPick;
      if (pending !== null) set({ dockPick: null });
      return pending;
    },

    cancelDockPick() {
      clearPick();
    },

    runDockShortcut(action) {
      const { dockOpen, dockMode, dockTermVisible } = get();
      const patch = applyDockShortcut({ dockOpen, dockMode, dockTermVisible }, action);
      // The shortcut closed the dock or left the Explorer: the choice goes too.
      if (patch.dockOpen === false || (patch.dockMode !== undefined && patch.dockMode !== 'explorer')) {
        clearPick();
      }
      setWindow(patch);
    },

    setDockWidth(px) {
      setWindow({ dockWidth: px === null ? null : clampDockWidth(px) });
    },

    setDockNavWidth(px) {
      setWindow({ dockNavWidth: px === null ? null : clampDockNavWidth(px) });
    },

    setDockTermHeight(px) {
      setWindow({ dockTermHeight: px === null ? null : clampDockTermHeight(px) });
    },

    setDockTermVisible(visible) {
      setWindow({ dockTermVisible: visible });
    },

    setDockTermMaximized(maximized) {
      setWindow({ dockTermMaximized: maximized });
    },

    setDockPane(pane) {
      // Not persisted: a relaunch starts at the navigator.
      if (get().dockPane !== pane) set({ dockPane: pane });
    },

    toggleWorkspaceDir(workspaceId, path, open) {
      const current = get().workspaceUi[workspaceId]?.expandedDirs ?? [];
      const next = withDirExpanded(current, path, open);
      if (next === current) return;
      patchWorkspace(workspaceId, { expandedDirs: next });
    },

    setWorkspaceSelectedFile(workspaceId, path) {
      patchWorkspace(workspaceId, { selectedFile: path });
    },

    setWorkspaceGitSelection(workspaceId, selection) {
      patchWorkspace(workspaceId, { gitSelection: selection });
    },

    setWorkspaceActiveTerminal(workspaceId, terminalId) {
      patchWorkspace(workspaceId, { activeTerminalId: terminalId });
    },

    setWorkspaceSearch(workspaceId, query) {
      patchWorkspace(workspaceId, { searchQuery: query });
    },

    forgetWorkspaceUi(workspaceId) {
      const before = get().workspaceUi;
      if (!(workspaceId in before)) return;
      const after = { ...before };
      delete after[workspaceId];
      set({ workspaceUi: after });
      saveWorkspaceUi(after);
    },
  };
}
