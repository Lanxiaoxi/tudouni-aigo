/**
 * The key a workspace is filed under in the Dock's per-workspace UI state.
 *
 * **It is the host channel's id, not a second scheme.** The Rust
 * `WorkspaceHostRegistry`, the `workspace_event` payloads and the connection
 * store are all keyed by `workspaceIdOf` (`src/workspaceHost/workspaceId.ts`);
 * a UI key built some other way would make "this workspace's expanded folders"
 * and "this workspace's host" two different workspaces that merely happen to
 * share a directory. So this delegates, and exists only so the Dock's state
 * code keeps one local name for it.
 *
 * Spelling variants of one local directory (`C:\Repo\`, `c:/repo`) land on one
 * id because `workspaceIdOf` hashes `normPath`, the same normal form the saved
 * session list is keyed by.
 */
import { workspaceIdOf } from '@/workspaceHost/workspaceId';

export function workspaceIdFor(root: string, remoteWorkspaceId: string | null): string {
  return workspaceIdOf(root, remoteWorkspaceId);
}
