/**
 * System notifications: **when a session wants a person**.
 *
 * The whole feature is one rule, and the rule is deliberately narrow. A desktop
 * window that is minimized, or that is showing one conversation while four
 * others run, gives a person no way to learn that something behind it has
 * finished, failed, or is waiting on an answer. That is the gap this closes, and
 * it is the only gap it closes.
 *
 * ## The rule
 *
 * A notification is sent when a session's status **changes into** one of the
 * states that mean "a person has to do something, or would want to look":
 *
 *   - `asking`  — the runtime is blocked on an approval or a question. The most
 *                 urgent one, and the only one where nothing at all moves until
 *                 somebody acts.
 *   - `broken`  — the turn ended in a model error, or the child died unasked.
 *   - `unseen`  — a turn finished while nobody was looking at that conversation.
 *   - `idle`    — **only** when a turn was actually running the moment before.
 *
 * That last qualifier is not a detail. `idle` is also where a session that has
 * never been spoken to sits, and where one goes after being read; notifying on
 * either would be an interruption about nothing having happened.
 *
 * Two further guards, both of which exist to remove noise rather than to add
 * features:
 *
 *   - **Nothing is said about a session the first time it is seen.** "The
 *     application has just started looking at this" is not a change anybody needs
 *     telling about.
 *   - **Nothing is said about a session somebody is looking at.** See
 *     `isWatched` — that is where the multi-session and minimized cases are
 *     decided, and it is the reason a notification means something when it
 *     arrives.
 *
 * ## Why the *status* and not the messages
 *
 * `selectRowStatus` is already the interface's single answer to "what is this
 * session doing" — the left rail's dots, the workspace badges and the session
 * board all read it. Deriving notifications from the same function is what keeps
 * a notification from disagreeing with the dot beside it: there is one
 * definition of "needs you", and it is not restated here.
 *
 * ## The click
 *
 * A toast that names a session is worth nothing if clicking it does not go
 * there, so this module also holds the **destination** rule — which session a
 * click should show — as a pure function, and the thin call that hands a
 * finished sentence to the OS.
 *
 * ## What is *not* here
 *
 * **No delivery of its own.** Showing the toast is Rust's (`notify_send` in
 * `src-tauri/src/lib.rs`), which is a change from wrapping the notification
 * plugin's JS directly and worth stating: the plugin reports nothing about a
 * click on the desktop — its `notify` command drops the notification handle
 * inside `show()`, and its own `onAction` is documented as mobile-only — so a
 * toast that has to open its own session cannot be built on it. Windows
 * therefore gets a toast built on the API *underneath* the plugin
 * (`tauri-winrt-notification`, the same crate version notify-rust already pulls
 * in), and everything else keeps the plugin's delivery unchanged.
 *
 * That also means the AppUserModelID question is answered in Rust rather than
 * here, which is where it belongs: it is a fact about the executable and its
 * installation, not about this window.
 */

import { isHosted } from './tauri';
import type { RowStatus } from '@/state/store';
import type { Translate } from '@/i18n';
import { baseName, oneLine } from '@/utils/format';

/* ============================================================
   The rule — pure functions, so they can be asserted without an OS
   ============================================================ */

/** Why a notification is worth sending. One per thing a person can act on. */
export type NotifyReason = 'needs-you' | 'failed' | 'finished';

/**
 * Whether a change from `previous` to `next` deserves a notification, and why.
 *
 * `previous` is `undefined` for a session this window has not seen before, which
 * is the one case where the answer is always no.
 *
 * The order of the two guards matters and is worth stating: an **unchanged**
 * status can never notify, whatever it is. The caller diffs against its last
 * observation, but the rule is written to be correct on its own rather than
 * relying on the caller — a rule that is only true when called correctly is a
 * rule that will be called incorrectly.
 */
export function notifyReason(
  previous: RowStatus | undefined,
  next: RowStatus,
): NotifyReason | null {
  // A session seen for the first time. Its status is simply what it is; there is
  // no transition to report, and at start-up there would be one per open session.
  if (previous === undefined) return null;
  // No change, so nothing happened. A second approval request while the first is
  // still unanswered leaves the status at `asking`, and one notification about it
  // is the right number.
  if (previous === next) return null;

  switch (next) {
    case 'asking':
      return 'needs-you';
    case 'broken':
      return 'failed';
    case 'unseen':
      return 'finished';
    case 'idle':
      // Only the end of a turn that was really running. See the module comment.
      return previous === 'running' ? 'finished' : null;
    case 'running':
      // Work starting is not something to interrupt somebody for.
      return null;
  }
}

/** What is known about the window and the session, for `isWatched`. */
export interface WatchContext {
  /** The session being judged. */
  key: string;
  /** The session the interface is drawing, or null when nothing is open. */
  activeKey: string | null;
  /** The window is focused **and** not minimized. */
  windowForeground: boolean;
  /** The key of the blocking request at the head of the queue, if any. */
  modalKey: string | null;
  /** Whether that request is actually drawn (`selectModalVisible`). */
  modalVisible: boolean;
}

/**
 * Is somebody looking at this session right now?
 *
 * Three ways to be watched, and the third is the one that is easy to miss:
 *
 *   1. **The window has to be in the foreground at all.** A minimized window is
 *      nobody's attention, which makes it the single most important case for
 *      this feature: a turn that ends while the window is minimized and the
 *      session happens to be the one *on screen* would otherwise report as
 *      `idle` — a status the notifier would read as "somebody is watching this,
 *      be quiet" — and the person would be told nothing.
 *   2. **The session is the one on screen.**
 *   3. **A blocking prompt from this session is drawn while another session is
 *      on screen.** A request is drawn over the conversation column, so the
 *      session asking need not be `activeKey` while its prompt is perfectly
 *      visible — the session board is the case: it holds the column, a request
 *      arriving there is drawn once the card is clicked, and that click focuses
 *      the asker in the same beat. Whoever is on screen, a prompt in front of
 *      the person is being watched, and a notification would be a second copy
 *      of something already there.
 *
 * A background session is **not** watched merely because the window is focused:
 * that is the multi-session case the whole feature exists for. Four
 * conversations running while somebody reads a fifth is exactly when "one of
 * them finished" is worth saying — and the same rule is what makes a question
 * asked in the background announce itself instead of covering the conversation
 * being typed into (`selectModalVisible`).
 *
 * Pure, and takes a plain object rather than the store, so each of these cases
 * can be asserted without a window.
 */
export function isWatched(context: WatchContext): boolean {
  if (!context.windowForeground) return false;
  if (context.key === context.activeKey) return true;
  return context.modalVisible && context.modalKey === context.key;
}

/**
 * Whether a notification should be sent, and why — the two rules above, in the
 * order they apply.
 *
 * One function so a caller cannot apply one and forget the other.
 */
export function notifyDecision(
  previous: RowStatus | undefined,
  next: RowStatus,
  context: Omit<WatchContext, 'key'> & { key: string },
): NotifyReason | null {
  const reason = notifyReason(previous, next);
  if (reason === null) return null;
  if (isWatched(context)) return null;
  return reason;
}

/* ============================================================
   The words — the store holds facts, i18n holds sentences
   ============================================================ */

export interface NotifyContent {
  title: string;
  body: string;
}

/** Which session the notification is about, as a person would name it. */
export interface NotifySubject {
  /** The workspace the session is in, as the runtime named it. */
  workspace: string;
  /** The runtime's own session id. Empty before the handshake has landed. */
  sessionId: string;
  /** The session's stored one-line preview, when it has one. */
  preview: string;
}

/* ============================================================
   The watcher's input — one compact string, and why
   ============================================================ */

/**
 * The snapshot the notifier watches, decoded.
 *
 * **The format has one definition, and it is here**, next to its encoder. The
 * hook that consumes this never splits the string itself: two implementations of
 * one layout is how a field ends up read out of the wrong column, and the symptom
 * would be a notification about the wrong session — which is worse than none.
 */
export interface NotifySnapshot {
  /** The session being drawn, or empty when nothing is open. */
  activeKey: string;
  /** Whether the head blocking request is actually on screen. */
  modalVisible: boolean;
  /** The key of that request, or empty. */
  modalKey: string;
  rows: NotifyRow[];
}

/** The separators. Control characters: no field can contain one, so none can be
 *  mistaken for a boundary. See `encodeNotifyRows`. */
export const NOTIFY_FIELD = '\u0000';
export const NOTIFY_ROW = '\u0001';
export const NOTIFY_WATCH = '\u0002';
export const NOTIFY_SECTION = '\u0003';

/** Encode the three watch fields and the rows into the one watched string. */
export function encodeNotifySnapshot(snapshot: NotifySnapshot): string {
  const watch = [
    snapshot.activeKey,
    snapshot.modalVisible ? '1' : '0',
    snapshot.modalKey,
  ].join(NOTIFY_WATCH);
  return `${watch}${NOTIFY_SECTION}${encodeNotifyRows(snapshot.rows)}`;
}

/**
 * The inverse. A malformed string yields "nothing is watched, no rows" rather
 * than a guess — the notifier's response to that is to send nothing, which is
 * the safe direction for a rule whose whole job is not to interrupt people.
 */
export function decodeNotifySnapshot(text: string): NotifySnapshot {
  const [watch = '', rows = ''] = text.split(NOTIFY_SECTION);
  const [activeKey = '', modalVisible = '0', modalKey = ''] = watch.split(NOTIFY_WATCH);
  return {
    activeKey,
    modalVisible: modalVisible === '1',
    modalKey,
    rows: decodeNotifyRows(rows),
  };
}

/**
 * One session, as the notifier needs to see it.
 *
 * `key` is the child key rather than the session id, because it is the handle
 * that exists before `init` lands and the one the store is addressed by; the id
 * is carried beside it because it is what a person is shown.
 */
export interface NotifyRow {
  /** The bridge's child key. The handle, and the identity across messages. */
  key: string;
  /** The runtime's id, or empty before the handshake. Part of the message only. */
  sessionId: string;
  status: RowStatus;
  workspace: string;
}

/**
 * **The compact form, and the only form the watcher subscribes to.**
 *
 * The same reason `selectRowStatusKey` and its siblings exist: zustand compares
 * selector output by identity, so subscribing to `sessions` re-renders on every
 * streamed token — a long answer would drag this hook through every chunk of
 * itself. A string changes only when a status, a workspace or a session's
 * identity really does, which is exactly when there is something to decide.
 *
 * Format: `key\u0000sessionId\u0000status\u0000workspace` per row, joined by
 * `\u0001`. The separators are control characters because a Windows path cannot
 * contain one, a session id is a runtime-minted token, a child key is decimal
 * digits and a status is one of five fixed words — so no field can be mistaken
 * for a boundary. The same argument `selectWorkspaceAttentionKey` makes.
 */
export function encodeNotifyRows(rows: NotifyRow[]): string {
  return rows
    .map((row) =>
      [row.key, row.sessionId, row.status, row.workspace].join(NOTIFY_FIELD),
    )
    .join(NOTIFY_ROW);
}

/** The inverse. A row that does not have all four fields is dropped rather than
 *  guessed at — a malformed row would otherwise land in `notifyDecision` as a
 *  session with an unknown status. */
export function decodeNotifyRows(text: string): NotifyRow[] {
  const out: NotifyRow[] = [];
  if (text === '') return out;
  for (const part of text.split(NOTIFY_ROW)) {
    const fields = part.split(NOTIFY_FIELD);
    if (fields.length !== 4) continue;
    const [key, sessionId, status, workspace] = fields;
    if (key === '') continue;
    out.push({ key, sessionId, status: status as RowStatus, workspace });
  }
  return out;
}

/**
 * The notification's text.
 *
 * **The reason is the title and the session is the body**, in that order, and
 * the order is the whole point: a person reads the title of a toast first, and
 * "Waiting for your answer" is what decides whether they look. Which session it
 * was is the second question, and it is answered by the workspace and the id —
 * the same two facts the modals use to say who is asking (`selectModalOrigin`).
 *
 * The preview is appended only when there is one. It is the runtime's own text
 * (`sessions.items.preview`), passed through `oneLine` because a toast body is
 * two lines at most and a long first message would otherwise be cut mid-word by
 * the OS with no indication that anything was missing.
 */
export function notifyContent(
  t: Translate,
  reason: NotifyReason,
  subject: NotifySubject,
): NotifyContent {
  const workspace = subject.workspace.trim();
  const name = workspace === '' ? '' : baseName(workspace);
  const where = [name, subject.sessionId]
    .filter((part) => part !== '' && part !== undefined)
    .join(' · ');
  const preview = oneLine(subject.preview, 140);
  return {
    title: t(
      reason === 'needs-you'
        ? 'notify.title.needsYou'
        : reason === 'failed'
          ? 'notify.title.failed'
          : 'notify.title.finished',
    ),
    // The subject line is omitted rather than left as a dangling separator when
    // neither half is known — a session whose `init` has not landed has no id,
    // and " · " alone would read as a missing value where there is none.
    body: [where, preview].filter((part) => part !== '').join('\n'),
  };
}

/* ============================================================
   Preferences
   ============================================================ */

/**
 * Whether session notifications are switched on, read from storage.
 *
 * **Absent means on**, and that is the one place this differs from the other
 * preferences. They default to "do nothing" (`ericaiDefault: false`, an empty
 * workspace list) because they change what the application *does* on the
 * person's machine. This one only ever reads state the application already has
 * and shows a toast about it — and a notifier that starts switched off is a
 * feature nobody discovers, which is the state this whole change exists to leave
 * behind.
 *
 * Only `false` turns it off, so a corrupted value cannot silently disable it —
 * the failure direction for a malformed record is the feature working, which is
 * recoverable from the settings row, rather than the feature being invisible.
 */
export function readNotifyEnabled(raw: unknown): boolean {
  return raw !== false;
}

/* ============================================================
   The click — where a notification leads
   ============================================================ */

/**
 * Which session a toast is about, as it travels to the operating system and back.
 *
 * **Read off the same three facts `NotifyRow` carries**, because the click has to
 * arrive at the session the sentence named: `key` is the handle the front end
 * addresses a session by, and the id and workspace are what reopening needs when
 * that handle is gone.
 */
export interface NotifyTarget {
  /** The bridge's child key. Empty only if the caller had none, which cannot
   *  happen: a row without a key is dropped by `decodeNotifyRows`. */
  key: string;
  /** The runtime's session id, empty before the handshake has landed. */
  sessionId: string;
  /** The workspace this session is in, as the runtime named it. */
  workspace: string;
}

/**
 * What clicking a notification should do.
 *
 * Three answers rather than two, because "the session this was about is gone"
 * is a real case and the alternatives to naming it are both wrong: doing nothing
 * when the session could be reopened loses the only thing the click promised,
 * and focusing a key that no longer exists is a silent no-op that looks like the
 * click was ignored.
 */
export type NotifyDestination =
  | { kind: 'focus'; key: string }
  | { kind: 'reopen'; sessionId: string; workspace: string }
  | { kind: 'nothing' };

/**
 * Which session a click opens, given what is still open.
 *
 * **The live key wins, and it is not an optimisation.** Focusing a session that is
 * still running is a local act that sends nothing (`focusSession`), and it also
 * clears that session's `unseen` mark — the natural end of "it finished and I had
 * not looked", which is one of the reasons a notification was sent at all.
 * Reopening instead would spawn a second process on a session id that already has
 * one, and `openSession` refuses that anyway, so the two paths would agree by
 * accident rather than by construction.
 *
 * The reopen path exists for the case the notification outlives: a toast is at
 * least as old as the transition that raised it, and somebody who reads it a
 * minute later may have closed that conversation in between. `openSession`
 * handles the rest — it focuses a child that already has that id, and starts one
 * that does not.
 *
 * `nothing` is the honest answer when there is no live key **and** no id: a
 * session whose `init` never landed has no saved conversation to reopen, and
 * there is no key left to focus. Both fields empty is the only way to reach it.
 *
 * Pure, and takes the live keys rather than the store, so each of these cases can
 * be asserted without a window — the same reason `isWatched` takes a plain
 * object.
 */
export function notifyDestination(
  target: NotifyTarget,
  liveKeys: readonly string[],
): NotifyDestination {
  if (target.key !== '' && liveKeys.includes(target.key)) {
    return { kind: 'focus', key: target.key };
  }
  if (target.sessionId !== '') {
    return { kind: 'reopen', sessionId: target.sessionId, workspace: target.workspace };
  }
  return { kind: 'nothing' };
}

/* ============================================================
   Delivery — Rust's, wrapped once
   ============================================================ */

/**
 * The command that shows the toast, and answers whether a click can come back.
 *
 * It is the bridge's, not the plugin's, because only the bridge can hear the
 * click — see the module header. The name is paired with `notify_send` in
 * `src-tauri/src/lib.rs`.
 */
const NOTIFY_COMMAND = 'notify_send';

/**
 * Send one notification about one session.
 *
 * Returns whether it was delivered, so a caller can decide whether to mark the
 * notification as already sent. **A failure is never retried and never
 * reported**: a notification that did not arrive costs the old behaviour —
 * everything is still on screen — and a `notice` in the transcript about a toast
 * would be a sentence about the conversation for something that is not part of
 * it.
 *
 * The target travels **with** the sentence rather than being looked up when the
 * click arrives, and that is what makes the click work at all: by the time
 * somebody clicks, the store may no longer hold that session — that is precisely
 * the case `notifyDestination`'s reopen branch is for. It also keeps the payload
 * the OS carries to three short strings and no conclusion: what a click *means*
 * is decided here, at the moment it happens, against the sessions that exist
 * then.
 */
export async function sendNotification(
  content: NotifyContent,
  target: NotifyTarget,
): Promise<boolean> {
  if (!isHosted()) return false;
  try {
    await invokeNotify({
      key: target.key,
      sessionId: target.sessionId,
      workspace: target.workspace,
      title: content.title,
      body: content.body,
    });
    return true;
  } catch {
    return false;
  }
}

/** One IPC call, imported lazily like every other bridge call here — this module
 *  is also loaded in a plain browser, where there is no IPC at all. */
async function invokeNotify(content: Record<string, string>): Promise<void> {
  const mod = await import('@tauri-apps/api/core');
  await mod.invoke(NOTIFY_COMMAND, { content });
}
