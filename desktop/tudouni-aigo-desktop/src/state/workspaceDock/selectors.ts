/**
 * Reading the Dock's workspace from the store.
 *
 * The Dock belongs to a **workspace**, but the window only knows sessions, so
 * "which workspace" is derived from the active session — the same two facts the
 * rest of the desktop already uses: `activeWorkspaceOf` (the runtime's own
 * answer about its directory, falling back to what the bridge was started with)
 * and `remoteWorkspaceIdOf` (the one thing that separates a remote `/srv/app`
 * from a local one). Switching between two sessions of one workspace therefore
 * yields the *same* key, and the Dock does not move.
 */
import { useShallow } from 'zustand/react/shallow';
import { useApp } from '@/state/store';
import { activeWorkspaceOf, remoteWorkspaceIdOf } from '@/state/appView';
import type { AppStore } from '@/state/storeShape';
import { workspaceIdFor } from './workspaceId';
import { EMPTY_WORKSPACE_UI, type WorkspaceUiState } from './uiState';

export interface ActiveWorkspaceKey {
  /** `workspaceIdFor(root, remoteWorkspaceId)`: the key of the per-workspace UI state. */
  workspaceId: string;
  /** The directory as the runtime reported it (on the remote host for a remote one). */
  root: string;
  /** The saved remote entry's id, or `null` for a local workspace. */
  remoteWorkspaceId: string | null;
}

/** Pure form, for tests and for non-React callers. Allocates; hooks go through `useShallow`. */
export function selectActiveWorkspaceKey(s: AppStore): ActiveWorkspaceKey | null {
  if (s.activeKey === null) return null;
  const root = activeWorkspaceOf(s);
  if (root.trim() === '') return null;
  const remoteWorkspaceId = remoteWorkspaceIdOf(s, s.activeKey);
  return { workspaceId: workspaceIdFor(root, remoteWorkspaceId), root, remoteWorkspaceId };
}

/**
 * The active session's workspace, or `null` when no session is open.
 *
 * `useShallow` keeps the identity stable across unrelated store updates (the
 * selector builds a fresh object each call), so a component reading this does
 * not re-render on every streamed token.
 */
export function useActiveWorkspaceKey(): ActiveWorkspaceKey | null {
  return useApp(useShallow(selectActiveWorkspaceKey));
}

/** One workspace's UI state; a shared constant while it has none (stable identity). */
export function useWorkspaceUi(workspaceId: string | null): WorkspaceUiState {
  return useApp((s) => (workspaceId === null ? EMPTY_WORKSPACE_UI : (s.workspaceUi[workspaceId] ?? EMPTY_WORKSPACE_UI)));
}
