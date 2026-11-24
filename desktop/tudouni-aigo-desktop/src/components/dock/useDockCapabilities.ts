import { useEffect } from 'react';
import type { DockCapabilities } from '@/state/workspaceDock/capabilities';
import { useApp } from '@/state/store';
import { activeHostTarget, activeWorkspaceIdOf, useWorkspaceConnection, workspaceHosts } from '@/workspaceHost';

/**
 * The capability table of the active workspace's host, or `null` while there is
 * none (not connected).
 *
 * **This is also where the host is lazily started** (design 3.1.1: "first time
 * the Dock is opened for the workspace"). The hook is only mounted while the
 * Dock is drawn, so a window that never opens the Dock never spawns a host, and
 * switching sessions within one workspace keeps the same id and therefore does
 * not reconnect. A `disconnected` host is not retried here: an automatic retry
 * loop would hide a host that keeps crashing; the empty state offers the retry.
 */
export function useDockCapabilities(): DockCapabilities | null {
  const workspaceId = useApp(activeWorkspaceIdOf);
  const connection = useWorkspaceConnection(workspaceId);

  useEffect(() => {
    if (workspaceId === null) return;
    const target = activeHostTarget(useApp.getState());
    if (target === null) return;
    const client = workspaceHosts.clientFor(target);
    if (client.connection.state === 'idle') void client.connect().catch(() => undefined);
  }, [workspaceId]);

  if (connection.state !== 'ready' || connection.capabilities === null) return null;
  const caps = connection.capabilities;
  return { files: caps.files === true, git: caps.git === true, terminal: caps.terminal === true };
}

/** Retry the active workspace's host after it went away. */
export function reconnectActiveHost(): void {
  const target = activeHostTarget(useApp.getState());
  if (target !== null) void workspaceHosts.reconnect(target).catch(() => undefined);
}
