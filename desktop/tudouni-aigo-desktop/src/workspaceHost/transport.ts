/**
 * The seam between a `WorkspaceHostClient` and the thing that moves its lines.
 *
 * In the app that is the Tauri bridge (`tauri.ts`: the `host_*` commands and the
 * `workspace-host://*` events). In a test it is an object that records what was
 * sent and lets the test say what arrived — which is how request correlation,
 * timeouts and base64 decoding are asserted without a process.
 *
 * The transport multiplexes every workspace over one set of listeners and
 * dispatches by `workspace_id`; a client only ever sees its own.
 */
import type { HostConnectionParams } from './connection';

export interface HostAttachRequest {
  workspaceId: string;
  root: string;
  remoteWorkspaceId: string | null;
  connection: HostConnectionParams | null;
}

export interface HostAttachResponse {
  /** A host for this workspace was already running (or starting). */
  already_running: boolean;
  /** Set when the host was already running and had said `host_init` before this
   *  client existed (a window reload, a second client): the line to feed in as
   *  if it had just arrived. Absent when `host_init` is still to come. */
  init_line?: string;
}

export interface HostLineHandlers {
  line(line: string): void;
  exit(info: { code: number; reason: string }): void;
  stderr(line: string): void;
}

export interface HostListRow {
  workspace_id: string;
  root: string;
  remote: boolean;
  remote_workspace_id: string | null;
  pid: number | null;
  generation: number;
}

export interface HostTransport {
  /** Start the host unless it is running. Resolves only after the transport's
   *  own listeners are in place, so `host_init` cannot be emitted to nobody. */
  attach(request: HostAttachRequest): Promise<HostAttachResponse>;
  /** Write one already-encoded line. Rejects when no host is running. */
  send(workspaceId: string, line: string): Promise<void>;
  /** Ask the host to end (shutdown, a short wait, then a kill). */
  shutdown(workspaceId: string): Promise<void>;
  /** Receive one workspace's lines, exit and stderr. Synchronous and cheap:
   *  a client subscribes before it attaches, so nothing can be missed. */
  subscribe(workspaceId: string, handlers: HostLineHandlers): () => void;
  /** The running hosts, when the transport can say. */
  list?(): Promise<HostListRow[]>;
}
