/**
 * What the window knows about one workspace's host connection.
 *
 * Plain data, no zustand and no Tauri, so the client (which produces it), the
 * store (which keeps it) and the UI (which draws it) share one definition and a
 * test can build one without a window.
 */
import type { WorkspaceCapabilities } from './protocol';

/**
 * - `idle`          no host has been asked for, or it was shut down on purpose;
 * - `connecting`    `host_attach` is in flight or `host_init` is awaited;
 * - `ready`         `host_init` arrived; requests may be sent;
 * - `disconnected`  the host exited unasked, or a connect failed. Reconnectable.
 *                   The terminals that were running are gone (the design does
 *                   not promise PTYs survive their host).
 */
export type HostConnectionState = 'idle' | 'connecting' | 'ready' | 'disconnected';

export interface HostExitInfo {
  /** The process exit code; `-1` when it could not be read. */
  code: number | null;
  /** `shutdown` (we asked), `ssh_closed` (a remote channel ended unasked) or
   *  `exited` (a local process ended unasked). */
  reason: string;
}

export interface WorkspaceConnection {
  state: HostConnectionState;
  /** Present only while `ready`: a stale capability list would claim features
   *  of a host that is gone. */
  capabilities: WorkspaceCapabilities | null;
  /** The root the host reported in `host_init` (a path on the host's machine). */
  root: string | null;
  hostVersion: string | null;
  hostPid: number | null;
  /** Why the last connect failed or the host went away, as a sentence. */
  lastError: string | null;
  /** The host's error code when it gave one, else the client's own
   *  (`timeout`, `not_connected`, `disconnected`, `send_failed`, …). */
  lastErrorCode: string | null;
  /** How the last host ended, when it did. */
  exit: HostExitInfo | null;
  /** `Date.now()` of the last `host_init`. */
  connectedAt: number | null;
}

/** The connection of a workspace nothing has been asked about. One shared
 *  frozen object: selectors return it for unknown ids, and zustand compares
 *  selector output by identity. */
export const IDLE_CONNECTION: WorkspaceConnection = Object.freeze({
  state: 'idle',
  capabilities: null,
  root: null,
  hostVersion: null,
  hostPid: null,
  lastError: null,
  lastErrorCode: null,
  exit: null,
  connectedAt: null,
});

/** What it takes to start a workspace's host. */
export interface HostConnectionParams {
  host: string;
  port: number;
  user: string;
  identityFiles: string[];
  password: string | null;
  /** Absolute path of the runtime binary on the remote host. */
  remoteBinary: string;
  connectTimeoutMs?: number;
}

/** One workspace as the host registry needs to know it. */
export interface WorkspaceTarget {
  /** `workspaceIdOf(root, remoteWorkspaceId)`; see `workspaceId.ts`. */
  workspaceId: string;
  /** The directory the host serves: local, or on the remote host. */
  root: string;
  /** The saved remote entry's id, or `null` for a local workspace. */
  remoteWorkspaceId: string | null;
  /** How to reach the far host; `null` for a local workspace. */
  connection: HostConnectionParams | null;
}
