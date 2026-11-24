/**
 * Which workspace the window is looking at, as a host target.
 *
 * The answers come from the existing store, unchanged:
 *   - active session bucket   → `activeRuntime(s)` (`state/appView.ts`)
 *   - remote or local         → `bucket.remoteWorkspaceId` (`null` = local)
 *   - root                    → local: `activeWorkspaceOf(s)` (`init.workspace`,
 *                               else the path the bridge started the child in);
 *                               remote: the saved entry's `remotePath`
 *   - how to reach the host   → `s.remoteWorkspaces` entry + `s.sshHosts` host
 *
 * Pure functions over `AppStore`, so they work in a selector and in a test. A
 * selector that returns a *new object* each call re-renders forever under
 * zustand's identity check: use `useApp(activeWorkspaceIdOf)` (a string) in
 * components and call `hostTargetOf(useApp.getState())` when connecting.
 */
import { activeRuntime, activeWorkspaceOf, runtimeOf } from '@/state/appView';
import type { AppStore } from '@/state/store';
import type { WorkspaceTarget } from './connection';
import { workspaceIdOf } from './workspaceId';

/** The host target of one session's workspace, or `null` when it cannot be
 *  named (no session, no workspace yet, or a remote entry/host that has been
 *  deleted since the session started). */
export function hostTargetOfSession(s: AppStore, key: string | null): WorkspaceTarget | null {
  const bucket = runtimeOf(s, key);
  if (bucket === null) return null;
  const remoteId = bucket.remoteWorkspaceId;

  if (remoteId === null) {
    const root = (bucket.session?.workspace ?? bucket.workspace).trim();
    if (root === '') return null;
    return { workspaceId: workspaceIdOf(root, null), root, remoteWorkspaceId: null, connection: null };
  }

  const entry = s.remoteWorkspaces.find((item) => item.id === remoteId);
  if (!entry) return null;
  const host = s.sshHosts.find((item) => item.id === entry.hostId);
  if (!host) return null;
  return {
    workspaceId: workspaceIdOf(entry.remotePath, remoteId),
    root: entry.remotePath,
    remoteWorkspaceId: remoteId,
    connection: {
      host: host.host,
      port: host.port,
      user: host.user,
      identityFiles: host.identityFiles,
      password: host.password ?? null,
      remoteBinary: entry.remoteBinary,
    },
  };
}

/** The host target of the workspace on screen. */
export function activeHostTarget(s: AppStore): WorkspaceTarget | null {
  return hostTargetOfSession(s, s.activeKey);
}

/** The workspace id of the screen — a string, so it is a safe selector. `null`
 *  when nothing is open. Does not require the remote entry to still exist. */
export function activeWorkspaceIdOf(s: AppStore): string | null {
  const bucket = activeRuntime(s);
  if (bucket === null) return null;
  if (bucket.remoteWorkspaceId !== null) return bucket.remoteWorkspaceId;
  const root = activeWorkspaceOf(s).trim();
  return root === '' ? null : workspaceIdOf(root, null);
}
