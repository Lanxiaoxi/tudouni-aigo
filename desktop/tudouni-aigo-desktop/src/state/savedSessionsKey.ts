/**
 * Which list of saved sessions belongs to which place.
 *
 * **A path is not an identity.** The `savedSessions` map used to be keyed by
 * `normPath(workspace)`, and that is right for a local directory and wrong for
 * everything else, because two workspaces on two machines can share one path
 * string:
 *
 *   - `hostA:/srv/app` and `hostB:/srv/app` are two different places. Keyed by
 *     path they shared one bucket, so whichever answered last overwrote the
 *     other — both rails drew one list, and a row clicked in it carried the
 *     *other* host's `sessionId`, which the current child then answered for with
 *     an empty conversation (a session id with no file is read by the runtime as
 *     *a new session with that name*).
 *   - A **local** `/srv/app` collided with a remote `/srv/app` in exactly the
 *     same way, which is the common case on a Linux client — the remote path is
 *     often also a real local path (`/srv`, `/tmp`, `/home/...`).
 *
 * So the key carries the machine: a remote workspace is keyed by its
 * `remoteWorkspaceId` (the saved entry's own opaque id, stable across edits to
 * the label or the path), and a local one keeps `normPath(workspace)`.
 *
 * **Every caller passes the id explicitly, and that is deliberate.** The
 * tempting alternative — look up which machine a path belongs to by scanning the
 * live buckets — cannot answer the question: when a local `/srv/app` and a
 * remote `/srv/app` are both open, the path names two places and the scan would
 * have to pick one. The bucket that holds the answer is already in the caller's
 * hand (it is the session the rail is drawing), so the id travels with the call
 * instead of being guessed.
 *
 * Pure, and separate from the store, because the write and the read have to
 * agree about the key exactly, and that is the kind of agreement that silently
 * rots when it is written out twice.
 */
import { normPath } from '@/utils/format';

/** The key one workspace's saved-session list is filed under. */
export function savedSessionsKey(workspace: string, remoteWorkspaceId: string | null): string {
  return remoteWorkspaceId === null ? normPath(workspace) : `rw:${remoteWorkspaceId}`;
}
