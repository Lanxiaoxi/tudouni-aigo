/**
 * The stable id a workspace is known by on the host channel.
 *
 * Decision (docs/design/workspace-dock.md §3.2, stage 0 "verify the premise"):
 *
 *   - A **remote** workspace already has one: `RemoteWorkspaceEntry.id`
 *     (`rw-<time>-<random>`), minted once by `addRemoteWorkspace`, persisted in
 *     `~/.tudouni/desktop.json`, and stable across edits of the label, the path
 *     and the binary. It is also what every session bucket already carries as
 *     `remoteWorkspaceId`. It is used as-is.
 *
 *   - A **local** workspace does not: `workspaces: string[]` is a bare list of
 *     directory strings, and the rest of the app identifies a local place by its
 *     path (`savedSessionsKey` is `normPath(path)`). A path is not an identity
 *     the host should be given — it differs by case and separator for the same
 *     directory, and it would put a machine path into every event — so the id is
 *     derived: `local:` + a 64-bit FNV-1a hash of `normPath(path)`, hex.
 *     Deriving (rather than minting and storing) means no migration of
 *     `desktop.json`, and the same directory gets the same id in every window and
 *     after every restart. Hash collisions between two of one person's
 *     directories are not a practical concern at 64 bits; the id is a label, not
 *     a capability, and the host also gets `--root`.
 *
 * One function so the Rust registry's key, the events and the UI's store can
 * never disagree about who is who. Pure (no Tauri), so it is testable in Node.
 */
import { normPath } from '@/utils/format';

/** 64-bit FNV-1a over the UTF-16 code units, as 16 hex digits. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The id of a local workspace directory. */
export function localWorkspaceId(path: string): string {
  return `local:${fnv1a64(normPath(path))}`;
}

/** The id of a workspace: the saved remote entry's id when remote, else derived
 *  from the local path. */
export function workspaceIdOf(path: string, remoteWorkspaceId: string | null): string {
  return remoteWorkspaceId !== null ? remoteWorkspaceId : localWorkspaceId(path);
}
