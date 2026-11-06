/**
 * What "start work in a new session" needs, shared by every caller that does it.
 *
 * `runTask` (a template's Run) and `startTicket` (a Ticket's Start) both open a
 * brand-new child in a named workspace and then speak into it once the
 * handshake has landed. They used to be one function; they are two callers of
 * these helpers now, so the part that is easy to get subtly wrong exists once:
 *
 *   - the three open paths (`active` / `local` / `remote`);
 *   - the rule that **a session counts only if this open created it** - an open
 *     that merely focused an existing child, was parked by a config-sync
 *     prompt, or failed with its own problem row started nothing, and
 *     recording work against it would be a fake success;
 *   - the bounded wait for the handshake, with the timeout said out loud.
 */
import type { StoreContext } from './storeContext';
import { activeRuntime } from './appView';
import { nextId } from '@/state/entries';
import { sendTo } from '@/runtime/bus';
import type { TaskWorkspaceRef } from '@/task/tasks';

/** How long a first prompt waits for the handshake. Matches the
 *  `init`-then-`session_load` ordering rule: the prompt may only be written
 *  once the empty `session_load` of a fresh session has been applied, and a
 *  child that has not handshaken within half a minute is not about to. */
export const HANDSHAKE_WAIT_MS = 30_000;

/**
 * Wait for one session's handshake, and say **which** of the three outcomes
 * happened rather than folding them together.
 *
 * `gone` is the ordinary failure (the bucket was replaced by a problem row or
 * closed while waiting) and the failure is already on screen. `timeout` is
 * not: the child is still there and still booting, so nothing has been said
 * about the prompt that was never sent - the caller has to say it.
 */
export async function waitForReady(
  ctx: StoreContext,
  key: string,
): Promise<'ready' | 'gone' | 'timeout'> {
  const deadline = Date.now() + HANDSHAKE_WAIT_MS;
  for (;;) {
    const current = ctx.get().sessions[key];
    if (current === undefined) return 'gone';
    if (current.ready) return 'ready';
    if (Date.now() >= deadline) return 'timeout';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Say that a first prompt never left this window.
 *
 * A note rather than a silent return, because there is no other surface that
 * could carry it: the session is still booting (so there is no `problem`
 * row), and the composer's draft was never written (so the input box shows
 * nothing either).
 */
export function sayHandshakeTimedOut(ctx: StoreContext, key: string, task: string | null): void {
  ctx.patchWith(key, (bucket) => ({
    entries: [
      ...bucket.entries,
      {
        kind: 'note',
        id: nextId('note'),
        tone: 'warn',
        code: 'handshake_timeout',
        text: '',
        message: { code: 'handshakeTimeout', seconds: HANDSHAKE_WAIT_MS / 1000, task },
      },
    ],
  }));
}

/**
 * Await an open that was started by the caller, and answer with the key of the
 * bucket **that open created**, or `null` when it created none.
 *
 * `previousKeys` is the set of keys that existed before the open began (read
 * from the state the caller held before starting it). The open paths can also
 * merely focus an existing session, and a config-sync prompt can park the open
 * entirely, leaving the screen where it was; a failed open leaves its own
 * problem row. In every one of those no session was created, so nothing may be
 * recorded against what is on screen.
 */
export async function claimNewSession(
  ctx: StoreContext,
  previousKeys: ReadonlySet<string>,
  opened: Promise<unknown>,
): Promise<string | null> {
  try {
    await opened;
  } catch {
    // A refused open (the config check could not connect, for one) is the
    // caller's to show; nothing was started, so nothing is recorded.
    return null;
  }
  const after = ctx.get();
  const key = after.activeKey;
  const bucket = key !== null ? after.sessions[key] : undefined;
  if (key === null || bucket === undefined || previousKeys.has(key) || bucket.problem !== null) {
    return null;
  }
  return key;
}

/** A session an open created, with the facts the caller records about it. */
export interface OpenedSession {
  key: string;
  /** Read off the **bucket that actually opened**, not off the ref (which may
   *  say `active`): what matters later is which machine it ran on. */
  remoteWorkspaceId: string | null;
  workspaceLabel: string;
}

/**
 * Open a new session in the workspace `ref` names.
 *
 * `active` means the workspace on screen - whatever it is, local or remote,
 * `openSession(null)` already answers it: it dials another child there on a
 * remote screen and spawns here on a local one. An explicit local path is a
 * plain attach; an explicit remote ref is the forceNew connect when the
 * workspace already has a live child (a start means a **new** session, never
 * "focus the old one") and the rail's own entry otherwise, which owns the
 * config-sync decision and the automatic install.
 *
 * `null` means nothing was started.
 */
export async function openNewSession(
  ctx: StoreContext,
  ref: TaskWorkspaceRef,
): Promise<OpenedSession | null> {
  const { get } = ctx;
  const s = get();
  let workspaceLabel: string;
  let opened: Promise<void>;
  if (ref.kind === 'active') {
    const active = activeRuntime(s);
    workspaceLabel = active?.session?.workspace ?? active?.workspace ?? '';
    if (workspaceLabel === '') return null;
    opened = get().openSession(null);
  } else if (ref.kind === 'local') {
    workspaceLabel = ref.path;
    opened = get().openSession(null, ref.path);
  } else {
    const remoteId = ref.id;
    const entry = s.remoteWorkspaces.find((item) => item.id === remoteId);
    const host = entry !== undefined ? s.sshHosts.find((item) => item.id === entry.hostId) : undefined;
    if (entry === undefined || host === undefined) return null;
    workspaceLabel = entry.remotePath;
    const live = s.order.find((key) => s.sessions[key]?.remoteWorkspaceId === remoteId);
    opened =
      live !== undefined
        ? get().connectRemoteWorkspace(remoteId, { forceNew: true })
        : get().enterRemoteWorkspace(remoteId);
  }

  const key = await claimNewSession(ctx, new Set(s.order), opened);
  if (key === null) return null;
  const bucket = get().sessions[key];
  if (bucket === undefined) return null;
  return { key, remoteWorkspaceId: bucket.remoteWorkspaceId, workspaceLabel };
}

/**
 * Put `text` into a session as a user message, **without touching the
 * composer**.
 *
 * Not `setDraft` + `submitDraft`: those write the *active* session's draft, and
 * a message addressed to a particular session (a Ticket's brief, a reviewer's
 * feedback) must neither depend on which session is on screen nor throw away
 * what the person is typing in it.
 */
export function speak(ctx: StoreContext, key: string, text: string): void {
  ctx.patchWith(key, (bucket) => ({
    entries: [...bucket.entries, { kind: 'user' as const, id: nextId('user'), text, atMs: Date.now() }],
    history: [...bucket.history, text].slice(-100),
    historyCursor: null,
    hasSpoken: true,
    suggestions: null,
  }));
  sendTo(key, { v: 1, t: 'user_message', text });
}
