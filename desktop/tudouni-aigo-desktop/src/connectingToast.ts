/**
 * What the connecting toast shows, as one decision in one place.
 *
 * Opening a remote workspace for the first time is a multi-second cold start
 * (a config-sync check over SSH, a possible runtime install, the connection
 * itself, the handshake), and none of it used to be visible: the screen sat on
 * the session it displaced while the new one's boot phase quietly ticked
 * `connecting` -> `handshaking` in a badge only the sidebar row carries. The
 * toast names what is being opened, and it goes away the moment the handshake
 * lands.
 *
 * Local sessions are never in flight — their `connection.phase` is `'local'`
 * and the selector does not see them — so no "is this remote" test is needed
 * beyond the phase itself.
 *
 * One gap the phase alone cannot cover: `connectRemoteWorkspace` runs the
 * automatic install **before** the bucket exists, so the longest part of a
 * first open (the upload) has no session to read the phase off. `openingRemote`
 * parks the row the open was started for — by `enterRemoteWorkspace`, from
 * before the config-sync check through the install — and the install status is
 * keyed by that same row, which is what tells the two halves apart.
 */

import type { AppStore } from '@/state/store';
import { activeRuntime, type SessionRuntime } from '@/state/store';

export interface ConnectingToastState {
  /** The workspace being opened: the saved row's label, or its path. */
  name: string;
  /**
   * True while the runtime binary is still being installed on the host — the
   * longest and least obvious half of the wait, so the toast says *that*
   * rather than "connecting…" over an upload.
   */
  installing: boolean;
}

/**
 * The toast for the open in flight on screen, or `null` when nothing is being
 * connected.
 *
 * `ready` is the off-switch rather than the phase alone: the phase flips to
 * `'ready'` on the handshake's `init`, and that is the moment the toast has
 * served its purpose. A background session's in-flight phase is deliberately
 * invisible here — the toast answers "what am I waiting on", and a session the
 * person moved away from has a badge on its own sidebar row for that.
 */
export function selectConnectingToast(s: AppStore): ConnectingToastState | null {
  const rt = activeRuntime(s);
  if (rt === null || rt.ready) {
    return s.openingRemote !== null ? openToastFor(s) : null;
  }

  // Only phases that mean "an attempt toward this workspace is in flight". A
  // failure (`'failed'`, `'closed'`, `'interrupted'`) has its own surface —
  // the session's problem row and the badge's tooltip — and the toast's job is
  // to be gone by then, not to stand next to them.
  const phase = rt.connection.phase;
  if (phase !== 'connecting' && phase !== 'starting' && phase !== 'handshaking') {
    return null;
  }
  if (rt.problem !== null) return null;

  return { name: toastWorkspaceName(s, rt), installing: false };
}

/**
 * The pre-bucket half of the same rule: `openingRemote` says an open was
 * started for this row, before its session's bucket existed. It covers the
 * config-sync check, the automatic install, and the gap between the install
 * finishing and the bucket being installed.
 *
 * The row's own download button also installs, and it parks nothing — an
 * install started by the button is the badge's to announce, not the toast's.
 */
function openToastFor(s: AppStore): ConnectingToastState | null {
  const id = s.openingRemote;
  if (id === null) return null;
  const entry = s.remoteWorkspaces.find((item) => item.id === id);
  if (entry === undefined) return null;
  const install = s.installStatus[id];
  const installing =
    install !== undefined && install.stage !== 'done' && install.error === null;
  return { name: entry.label.trim() !== '' ? entry.label : entry.remotePath, installing };
}

/** The workspace's own name: the row's `label`, falling back to its path. */
function toastWorkspaceName(s: AppStore, rt: SessionRuntime): string {
  const entry =
    rt.remoteWorkspaceId !== null
      ? s.remoteWorkspaces.find((item) => item.id === rt.remoteWorkspaceId)
      : undefined;
  return entry !== undefined && entry.label.trim() !== '' ? entry.label : rt.workspace;
}
