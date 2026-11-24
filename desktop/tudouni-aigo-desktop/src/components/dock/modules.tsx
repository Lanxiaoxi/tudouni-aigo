/**
 * **Where the three modules plug into the Dock** (docs/design/workspace-dock.md
 * §12 stage 6). The framework (`WorkspaceDock.tsx`) renders these four regions
 * and decides when each may draw (`regionState`); everything below is a
 * placeholder to be replaced, one component per module, without touching the
 * framework:
 *
 *   - `ExplorerNavigator` — the file tree, left part in Explorer mode (6a).
 *   - `GitNavigator`      — the grouped change list, left part in Git mode (6b).
 *   - `DockViewer`        — the right part: file preview (explorer) or diff (git).
 *   - `TerminalDock`      — the body of the Terminal Dock: tab strip + terminal
 *                           surface (6c). The title bar (fold, maximize) is the
 *                           framework's; this body carries `data-terminal-focus`
 *                           from the framework, so global shortcuts already
 *                           leave its keys alone.
 *
 * A module is rendered **only when its capability is present** and a workspace is
 * bound, so it never has to draw "not connected" itself. In single-column
 * layout (`columns === 'single'`) the navigator should call
 * `useApp.getState().setDockPane('viewer')` after a selection to show the viewer;
 * the viewer already has a back button from the framework.
 *
 * State to use: `useWorkspaceUi(workspace.workspaceId)` and the
 * `setWorkspace*` / `toggleWorkspaceDir` store actions — never the session bucket.
 */
import type { ActiveWorkspaceKey } from '@/state/workspaceDock/selectors';
import type { DockCapabilities } from '@/state/workspaceDock/capabilities';
import type { DockMode } from '@/state/workspaceDock/uiState';
import { ExplorerNav } from './explorer/ExplorerNavigator';
import { ExplorerViewer } from './explorer/ExplorerViewer';
import { GitDiffViewer } from './git/DiffViewer';
import { GitNav } from './git/GitNavigator';

export interface DockModuleProps {
  workspace: ActiveWorkspaceKey;
  capabilities: DockCapabilities;
  /** `single`: navigator and viewer take turns; `dual`: side by side. */
  columns: 'single' | 'dual';
}

// Explorer (6a) and Git (6b) live in `./explorer/` and `./git/`.
export function ExplorerNavigator(props: DockModuleProps) {
  return <ExplorerNav {...props} />;
}

export function GitNavigator(props: DockModuleProps) {
  return <GitNav {...props} />;
}

export function DockViewer(props: DockModuleProps & { mode: DockMode }) {
  return props.mode === 'git' ? <GitDiffViewer {...props} /> : <ExplorerViewer {...props} />;
}

// The Terminal Dock (6c) lives in `./terminal/`; re-exported so the framework
// keeps importing every module from here.
export { TerminalDock } from './terminal/TerminalDock';
