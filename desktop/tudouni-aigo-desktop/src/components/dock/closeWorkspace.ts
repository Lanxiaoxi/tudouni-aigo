/**
 * What removing a workspace from the list does to its Dock resources
 * (docs/design/workspace-dock.md 9.4: "closing a workspace handles its
 * terminals explicitly").
 *
 * Kept apart from `dockActions.ts` on purpose: this module pulls in the real
 * terminal manager (and with it xterm), which the pure helpers and their tests
 * must not need.
 */
import { workspaceHosts } from '@/workspaceHost';
import { useApp } from '@/state/store';
import { forgetWorkspaceData } from '@/state/workspaceDock/dataCache';
import { terminalHosts } from './terminal/hostManager';

/** Terminals of this workspace that still have a live process. */
export function runningTerminalCount(workspaceId: string): number {
  return terminalHosts.terminals(workspaceId).filter((term) => term.state === 'running').length;
}

/**
 * Let go of everything the Dock holds for a workspace, then end its host.
 *
 * The caller has already asked the person when `runningTerminalCount` is not
 * zero: the host's terminals die with it. Order matters: the manager is
 * released first so it does not see the host going away as a failure to report.
 */
export async function closeWorkspaceResources(workspaceId: string): Promise<void> {
  terminalHosts.disposeWorkspace(workspaceId);
  forgetWorkspaceData(workspaceId);
  useApp.getState().forgetWorkspaceUi(workspaceId);
  // A host that is already gone is the state we want; nothing to report.
  await workspaceHosts.close(workspaceId).catch(() => undefined);
}
