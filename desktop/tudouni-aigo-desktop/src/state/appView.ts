/**
 * Reading the store from the outside: which session is on screen, where it is,
 * and whether it has ever been used.
 *
 * These used to sit inside `store.ts`. They are not actions and they write
 * nothing — they are the shared vocabulary every action, selector and component
 * uses to answer "which bucket do you mean". Moving them out is what lets the
 * selectors live in their own file without importing the store back at runtime.
 *
 * Types are imported type-only from `./store`, so there is no module cycle at
 * run time: the store imports these functions, and these functions only mention
 * the store's shape.
 */
import { hasRunningTurn } from '@/state/entries';
import type { AppStore, SessionRuntime } from './store';


/** The active session's bucket, or null when nothing is open. */
export function activeRuntime(s: AppStore): SessionRuntime | null {
  return s.activeKey === null ? null : (s.sessions[s.activeKey] ?? null);
}

/**
 * The workspace the session on screen is in, as its own runtime named it.
 *
 * `init.workspace` first — the runtime's own answer about where it is — and
 * `bucket.workspace` (what the bridge was started with) as the fallback for the
 * moment before the handshake lands. This is the same precedence the left rail
 * and the top bar use, in one place, because it is also the **key** the saved
 * session list is filed under: two expressions of "which workspace is this"
 * would eventually file a list where nothing looks for it.
 */
export function activeWorkspaceOf(s: AppStore): string {
  const rt = activeRuntime(s);
  if (!rt) return '';
  return rt.session?.workspace ?? rt.workspace;
}

/** The connection facts of one session's remote workspace, or `null`.
 *
 * The saved entry and its host are the **only** sources a front-end dial can
 * use — the same record `connectRemoteWorkspace` reads when it starts the
 * child — so a download or a picture read reaches the machine the session
 * actually runs on, never a destination assembled from a display label.
 * `null` for a local session, or when the entry or its host has been deleted
 * since the session started (the session keeps running; its files are simply
 * unreachable from this window, and the refusal says so).
 */
export function remoteConnectionOf(
  s: AppStore,
  key: string | null,
): { host: string; port: number; user: string; workspace: string } | null {
  if (key === null) return null;
  const bucket = s.sessions[key];
  const id = bucket?.remoteWorkspaceId ?? null;
  if (id === null) return null;
  const entry = s.remoteWorkspaces.find((item) => item.id === id);
  if (!entry) return null;
  const host = s.sshHosts.find((item) => item.id === entry.hostId);
  if (!host) return null;
  return {
    host: host.host,
    port: host.port,
    user: host.user,
    workspace: entry.remotePath,
  };
}

/**
 * Which workspace a child about to be started should be given.
 *
 * Three answers, in order of how directly a person said them:
 *
 *   1. **The caller's** — pressing a workspace row, or `/resume` naming one.
 *   2. **The active session's**, from `init.workspace`. "New conversation"
 *      almost always means "here", and the runtime's own answer about where a
 *      session is open is the only thing entitled to say where here is.
 *   3. **The remembered one** — the workspace last worked in.
 *
 * And then **nothing**: the empty string, which callers must treat as "do not
 * start a child at all" rather than as a value to pass on. That last part is
 * not a detail. An absent workspace reaches the bridge as `None`, whose
 * documented meaning is "the directory the application was started in" — for a
 * packaged app, its own install folder. That is how a launch with nothing
 * recalled ended up opening a workspace nobody chose, and it is the one
 * fallback that can never be right.
 *
 * Pure, and exported, so the precedence can be asserted without a bridge.
 */
export function resolveAttachWorkspace(
  requested: string | undefined,
  active: string | undefined,
  remembered: string | null,
): string {
  for (const candidate of [requested, active, remembered ?? undefined]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return '';
}

/**
 * Whether an open session has never become a conversation.
 *
 * There is one state where this matters, and it is the one a launch leaves
 * behind. `openFirstSession` starts a child in the workspace last worked in, so
 * the window always comes up with a session open — and if the person then opens
 * a past conversation instead of typing here, that first session stays: a live
 * child, no file, no message, and a rail row reading "open now / Nothing has run
 * in it yet". It is not a conversation anybody can come back to, so it is
 * **closed** when the screen moves off it (`abandonIfUntouched`) rather than
 * merely left out of the list. Hiding the row would be worse than showing it —
 * with no file there is no delete button either, so a live child nobody draws is
 * a process nobody can reach or end.
 *
 * Every exclusion below is a thing a person would notice losing, and each one
 * also *dis*qualifies the session: it is then a conversation in progress, and it
 * is left exactly where it is.
 *
 * Exported and pure so the rule can be asserted without a child process, which
 * is how the rail's groups are tested — see `tests/rail-groups.test.ts`.
 */
export function isUntouchedSession(s: AppStore, key: string): boolean {
  const rt = s.sessions[key];
  if (!rt) return false;

  // The handshake has to have landed, and it has to say this is a **new**
  // session. Before `init` there is nothing to judge — the child has not said
  // which conversation it is — and a resumed one is a conversation the person
  // picked by name, whatever its transcript happens to hold. Without the second
  // half, the gap between `init` and `session_load` would read as "empty": the
  // history has not been rebuilt yet, so `hasSpoken` is still false.
  if (!rt.ready || rt.session?.resumed !== false) return false;

  // Said something, or is saying it now. `hasSpoken` is set as the message goes
  // out, so it covers the turn that follows it.
  if (rt.hasSpoken || rt.activeRunId !== null || hasRunningTurn(rt.entries)) return false;
  // Typed something, or staged a picture, without sending it.
  if (rt.draft.trim() !== '' || rt.pastedImages.length > 0 || rt.attachedFiles.length > 0) return false;
  // A shell is running, made by this session's child — closing the session ends
  // it, and the scrollback this end holds goes with it.
  if (rt.terminals.length > 0 || rt.activeTerminalId !== null) return false;
  // Something to read rather than nothing to lose: a child that would not start,
  // one that died, an input the composer refused and explained.
  if (rt.problem !== null || rt.runtimeExit !== null || rt.composerNotice !== null) return false;
  // A transcript, however short. The handshake's own notices do not count —
  // every session has those, and "no ripgrep" is not a conversation.
  if (rt.entries.some((entry) => entry.kind !== 'note')) return false;
  // Waiting on the person. Nothing closes a session that is holding a request:
  // the runtime waits on that id for ever.
  if (s.pendingModals.some((entry) => entry.key === key)) return false;

  return true;
}

/** One session's bucket, or null. The `key === null` form is the one the store
 *  itself uses — `sessions[null]` would be a string lookup with the wrong type. */
export function runtimeOf(s: AppStore, key: string | null): SessionRuntime | null {
  return key === null ? null : (s.sessions[key] ?? null);
}
