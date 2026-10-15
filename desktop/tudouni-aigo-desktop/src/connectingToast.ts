/**
 * What the "Connecting <workspace>" toast shows, as one decision in one place.
 *
 * Opening a remote workspace for the first time is a multi-second cold start —
 * a config-sync check over SSH, a possible runtime install, the connection
 * itself, the handshake — and none of it was visible: the screen sat on the
 * session it displaced while the new one's connection quietly ticked
 * `connecting` -> `handshaking` in a badge only the sidebar row carries. The
 * toast names what is being opened, and it goes away the moment the handshake
 * lands.
 *
 * Local sessions are never in flight — their `connection.phase` is `'local'` —
 * so no "is this remote" test is needed beyond the phase itself.
 *
 * The wait has two halves the toast must both cover:
 *
 *   - **pre-bucket.** The config-sync check and the automatic install run
 *     before `connectRemoteWorkspace` builds a bucket, so there is no session
 *     to read `connection.phase` off. `openingRemote` marks the row the open
 *     was started for; this is what the toast reads in that stretch.
 *   - **post-bucket.** Once the bucket exists, its own `connection.phase`
 *     (`'connecting'` until the SSH dial returns, then `'handshaking'` until
 *     the runtime's `init`) is the signal, and `openingRemote` is cleared.
 */

import type { AppStore } from '@/state/store';
import { activeRuntime, type SessionRuntime } from '@/state/store';

export interface ConnectingToastState {
  /** The workspace being opened: the saved row's label, or its path. */
  name: string;
}

/**
 * The toast for the open in flight, or `null` when nothing is being connected.
 *
 * `ready` is the off-switch rather than the phase alone: the phase flips to
 * `'ready'` on the handshake's `init`, and that is the moment the toast has
 * served its purpose. A failure (`'failed'`, `'closed'`, `'interrupted'`, or a
 * `problem` set) has its own surface — the session's problem row and the badge
 * tooltip — and the toast's job is to be gone by then, not to stand beside it.
 */
export function selectConnectingToast(s: AppStore): ConnectingToastState | null {
  // The pre-bucket half first: while `openingRemote` is set the open is in
  // flight but has no bucket yet (or one that is not the focus), and the mark
  // is the only thing that says so. It outranks the focus below, which is what
  // keeps the toast alive through the check and install, before a session
  // exists to be focused on.
  if (s.openingRemote !== null) return openToastFor(s);

  const rt = activeRuntime(s);
  if (rt === null || rt.ready) return null;

  const phase = rt.connection.phase;
  if (phase !== 'connecting' && phase !== 'starting' && phase !== 'handshaking') {
    return null;
  }
  if (rt.problem !== null) return null;

  return { name: toastWorkspaceName(s, rt) };
}

/**
 * The pre-bucket half: `openingRemote` says an open was started for this row
 * before its bucket existed. It covers the config-sync check, the automatic
 * install, and the gap until the bucket lands (the moment `openingRemote` is
 * cleared and the phase-based half takes over, in one write).
 *
 * The row's own download button also installs, and it parks nothing — an
 * install started by the button is the row's install badge to announce, not
 * the toast's.
 */
function openToastFor(s: AppStore): ConnectingToastState | null {
  const id = s.openingRemote;
  if (id === null) return null;
  const entry = s.remoteWorkspaces.find((item) => item.id === id);
  if (entry === undefined) return null;
  return { name: entry.label.trim() !== '' ? entry.label : entry.remotePath };
}

/** The workspace's own name: the row's `label`, falling back to its path. */
function toastWorkspaceName(s: AppStore, rt: SessionRuntime): string {
  const entry =
    rt.remoteWorkspaceId !== null
      ? s.remoteWorkspaces.find((item) => item.id === rt.remoteWorkspaceId)
      : undefined;
  return entry !== undefined && entry.label.trim() !== '' ? entry.label : rt.workspace;
}
