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
 * ## What is *not* here
 *
 * **No delivery of its own.** The OS handshake, the permission prompt and the
 * platform's own toast are `tauri-plugin-notification`'s; this module holds the
 * rule (pure, and tested) and the thin call that hands a finished sentence over.
 * Reimplementing delivery would be a second implementation of something that
 * already exists, and on Windows it would also mean owning the AppUserModelID
 * registration a toast needs to be attributed to an installed application.
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
 *   3. **A blocking prompt from this session is rendered.** A request is drawn
 *      over whatever conversation is on screen, so the session asking may not be
 *      `activeKey` while its prompt is perfectly visible — in which case it is
 *      being watched, and a notification would be a second copy of something
 *      already in front of the person.
 *
 * A background session is **not** watched merely because the window is focused:
 * that is the multi-session case the whole feature exists for. Four
 * conversations running while somebody reads a fifth is exactly when "one of
 * them finished" is worth saying.
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
   Delivery — the plugin's, wrapped once
   ============================================================ */

/**
 * What the OS last said about permission.
 *
 * Held in a module rather than in the store because it is not a fact this
 * application owns: it belongs to the operating system, it can be revoked
 * outside this program, and nothing in the interface is rendered from it except
 * the settings row, which asks for itself when it is opened.
 *
 * `'unknown'` is the honest starting value and not a stand-in for "denied". The
 * first send asks.
 */
let permission: 'unknown' | 'granted' | 'denied' = 'unknown';

/** Whether permission has already been requested in this run. */
let requested = false;

/**
 * Ask the OS, once per run, and report what it said.
 *
 * **Once per run, deliberately.** The permission prompt is a modal owned by the
 * operating system; asking again after a refusal turns a notification feature
 * into something that interrupts on every turn, which is the opposite of what it
 * is for. A refusal therefore costs the notifications and nothing else — the
 * sessions, the dots and the board all still say what happened, exactly as they
 * did before this existed.
 *
 * `request: false` only **reads** the current state. The settings row uses that
 * on mount, so opening the panel never raises an OS dialog by itself.
 */
export async function notificationPermission(request: boolean): Promise<'granted' | 'denied' | 'unknown'> {
  if (!isHosted()) return 'unknown';
  try {
    const mod = await import('@tauri-apps/plugin-notification');
    if (await mod.isPermissionGranted()) {
      permission = 'granted';
      return permission;
    }
    if (!request) return permission;
    if (requested) return permission;
    requested = true;
    const answer = await mod.requestPermission();
    permission = answer === 'granted' ? 'granted' : 'denied';
    return permission;
  } catch {
    // The plugin is absent (a plain browser) or the OS refused to be asked. Not
    // an error worth surfacing: it means no notifications, nothing more.
    return permission;
  }
}

/**
 * Send one notification.
 *
 * Returns whether it was delivered, so a caller can decide whether to mark the
 * notification as already sent. **A failure is never retried and never
 * reported**: a notification that did not arrive costs the old behaviour —
 * everything is still on screen — and a `notice` in the transcript about a toast
 * would be a sentence about the conversation for something that is not part of
 * it.
 *
 * Permission is requested on the first send rather than at start-up, which is
 * the one behaviour worth arguing for: the OS dialog then appears at a moment
 * that explains itself (a session has just finished), instead of over the first
 * frame of an application the person is still reading.
 */
export async function sendNotification(content: NotifyContent): Promise<boolean> {
  if (!isHosted()) return false;
  if ((await notificationPermission(true)) !== 'granted') return false;
  try {
    const mod = await import('@tauri-apps/plugin-notification');
    mod.sendNotification({ title: content.title, body: content.body });
    return true;
  } catch {
    return false;
  }
}
