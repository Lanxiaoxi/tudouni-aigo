/**
 * What the Ticket board draws, as pure functions of Tickets.
 *
 * Nothing here reads a session or writes a Ticket: the column a Ticket sits in,
 * why a `needs_you` Ticket is waiting, and which buttons its card offers are
 * all facts of the record (plus one boolean the caller reads off the session -
 * "is the child there"), so they can be asserted without a window.
 */
import { unbindableField, type Assignment, type Ticket, type TicketStatus } from './model';

export const TICKET_COLUMNS = ['open', 'running', 'needs_you', 'review', 'done'] as const;
export type TicketColumn = (typeof TICKET_COLUMNS)[number];

/** `dropped` has no column of its own: it is a way of being finished, so it
 *  sits at the foot of Done (design 7.3). */
export function columnOf(status: TicketStatus): TicketColumn {
  return status === 'dropped' ? 'done' : status;
}

export interface TicketGroups {
  open: Ticket[];
  running: Ticket[];
  needs_you: Ticket[];
  review: Ticket[];
  done: Ticket[];
  /** The Done column's folded region. */
  dropped: Ticket[];
}

/** Split the list into the board's columns, keeping insertion order inside
 *  each: a card must not move because its status wobbled, only because it
 *  changed column. */
export function groupTickets(tickets: readonly Ticket[]): TicketGroups {
  const groups: TicketGroups = { open: [], running: [], needs_you: [], review: [], done: [], dropped: [] };
  for (const ticket of tickets) {
    if (ticket.status === 'dropped') groups.dropped.push(ticket);
    else groups[ticket.status].push(ticket);
  }
  return groups;
}

/** Why a Ticket is waiting on the person. */
export type TicketCause = 'blocked' | 'disconnected' | 'crashed' | 'unreachable';

/**
 * The reason behind a `needs_you` Ticket, read from its newest cause event.
 *
 * A report with `blocked` and an unrequested exit are the only two ways in; the
 * newer of the two is the one the card should explain. `disconnected` comes
 * from the bridge's `reason: ssh_closed` (carried on the exit event), never from
 * the workspace type - the card must say "connection lost" rather than "error"
 * for a dropped SSH link (design 6.5). `unreachable` is the front end's own
 * verdict on a child that never answered its handshake (a Start whose session
 * never came up), which is a different sentence again: nothing was running, so
 * there is no conversation to reopen. `null` outside `needs_you`.
 */
export function needsYouCause(ticket: Ticket): TicketCause | null {
  if (ticket.status !== 'needs_you') return null;
  for (let i = ticket.events.length - 1; i >= 0; i -= 1) {
    const event = ticket.events[i];
    if (event.type === 'reported') {
      const applied = event.data?.applied;
      if (applied === true) return 'blocked';
      continue;
    }
    if (event.type === 'assignmentExited' && event.data?.requested === false) {
      if (event.data.reason === 'disconnected') return 'disconnected';
      if (event.data.reason === 'unreachable') return 'unreachable';
      return 'crashed';
    }
  }
  // Records written by a build that did not mark `applied`: the report is what
  // the card has to show, so name it rather than guess a crash.
  return ticket.lastReport?.status === 'blocked' ? 'blocked' : 'crashed';
}

/** Why a Ticket is in `review`: the agent said it was done, or it stopped
 *  without saying anything (design 5.5). */
export type ReviewCause = 'reported' | 'unreported';

/**
 * The reason behind a `review` Ticket, read from its newest cause event.
 *
 * Matters because the two read differently: after a send-back, `lastReport` is
 * still the *previous* round's report, so a card that stopped without reporting
 * must not show it as the agent's answer. `reported` is only a cause when it
 * `applied` (a report that arrived in review did not put the Ticket there).
 * Records with neither event (written before this existed) read as `reported`.
 * `null` outside `review`.
 */
export function reviewCause(ticket: Ticket): ReviewCause | null {
  if (ticket.status !== 'review') return null;
  for (let i = ticket.events.length - 1; i >= 0; i -= 1) {
    const event = ticket.events[i];
    if (event.type === 'turnEndedUnreported') return 'unreported';
    if (event.type === 'reported' && event.data?.applied === true) return 'reported';
  }
  return 'reported';
}

/** One button a card can offer. `continue` is `open` when nothing is
 *  connected: it brings the original session back instead of switching to it. */
export type TicketAction =
  | 'start'
  | 'runNow'
  | 'open'
  | 'continue'
  | 'restart'
  | 'accept'
  | 'sendBack'
  | 'reopen';

/**
 * The state-specific buttons (design 7.3). `drop`, edit and delete are on every
 * card and are not listed. `connected` is whether the Assignment's session is a
 * live child right now; it only changes the wording of the "go to the session"
 * button, never which Tickets have one.
 */
export function ticketActions(status: TicketStatus, connected: boolean): TicketAction[] {
  const go: TicketAction = connected ? 'open' : 'continue';
  switch (status) {
    case 'open':
      return ['start', 'runNow'];
    case 'running':
      return [go];
    case 'needs_you':
      return [go, 'restart'];
    case 'review':
      return ['open', 'accept', 'sendBack'];
    case 'done':
    case 'dropped':
      return ['reopen'];
  }
}

/**
 * Whether "Continue" can reach the Assignment's session at all.
 *
 * Asked of the **Assignment**, not of the Ticket's workspace ref: a Ticket made
 * against `active` has a ref that means nothing once the screen it was made on
 * is gone (after a restart there may be no workspace on screen at all), yet its
 * session is perfectly resumable from what the Assignment recorded. A remote
 * one needs its saved workspace entry; a local one needs a directory to resume
 * in (the one recorded, or the Ticket's own local path).
 */
export function canResumeAssignment(
  ticket: Ticket,
  assignment: Assignment | null,
  remoteIds: ReadonlySet<string>,
): boolean {
  if (assignment === null || assignment.executor.sessionId === '') return false;
  const { remoteWorkspaceId, workspace } = assignment.executor;
  if (remoteWorkspaceId !== null) return remoteIds.has(remoteWorkspaceId);
  return (workspace ?? '') !== '' || ticket.workspace.kind === 'local';
}

/** Whether a status can still be given up. */
export function canDrop(status: TicketStatus): boolean {
  return status !== 'done' && status !== 'dropped';
}

/* ============================================================
   Dragging a card into another lane
   ============================================================ */

/**
 * What letting go in a lane means.
 *
 * **A drop is an intent, never a transition.** `machine.apply` is still the only
 * writer of `status`, and every kind below ends in exactly one of the commands
 * `ticketActions` already offers — so a lane can never mean something the
 * buttons on that same card cannot mean (design 7.1's "one control, two
 * entrances", applied to the board's own gestures).
 *
 * `begin` deliberately carries **no mode**. Dropping a card into Running is the
 * statement "this work should start", which is not the same statement as "send
 * it right now": the choice between starting attended (the brief waits in the
 * input box) and running unattended (autopilot on, the brief sent at once) costs
 * tokens either way, so it is asked — or remembered — rather than inferred from
 * a gesture (`rememberedStartMode`).
 */
export type TicketDrop =
  | { kind: 'begin' }
  | { kind: 'accept' }
  | { kind: 'sendBack' }
  | { kind: 'reopen' };

/**
 * Which lanes accept a card dragged out of `status`, and as what.
 *
 * **The lanes that are absent are the point**, and each one is absent for a
 * reason rather than by omission:
 *
 *   - `running → needs_you` / `review` are facts an agent reports (`reported`),
 *     or an unrequested exit. A person has no way to make either true, so a drop
 *     that did it would be inventing a transition the record has no command for.
 *   - `needs_you → running` is two different intents — "continue" (resume the
 *     same session) and "start over" (`superseded`, a fresh one) — and the
 *     continue branch does not move the status at all (invariant 7). A lane
 *     cannot be a gesture whose result is "nothing moved", so both stay buttons.
 *   - **Done is never a drop target.** Done owns both `done` and `dropped`
 *     (`columnOf`), so a drop there cannot say which one it means; and giving a
 *     Ticket up is irreversible enough to keep its own confirmation.
 *
 * Every other direction is a lane-to-lane move whose command already exists, so
 * the drag adds no vocabulary — it only adds a second way to say it.
 */
export function dropTargets(status: TicketStatus): Partial<Record<TicketColumn, TicketDrop>> {
  switch (status) {
    case 'open':
      return { running: { kind: 'begin' } };
    case 'review':
      // Review is the one lane with two meaningful moves: forward to Done, and
      // back to Running with an opinion. Both are the card's own buttons.
      return { done: { kind: 'accept' }, running: { kind: 'sendBack' } };
    case 'done':
    case 'dropped':
      return { open: { kind: 'reopen' } };
    case 'running':
    case 'needs_you':
      return {};
  }
}

/** Whether a lane would do nothing with this card — for the drop highlight. */
export function acceptsDrop(status: TicketStatus, column: TicketColumn): boolean {
  return dropTargets(status)[column] !== undefined;
}

/**
 * What the board remembers about the `begin` drop: ask every time, or take one
 * answer without asking.
 *
 * `'ask'` is the first-run value and the default, because the two answers cost
 * very differently: `run_now` sends the brief and switches autopilot on, so a
 * remembered one is only ever set by a person who ticked the box.
 */
export type TicketStartMemory = 'ask' | 'start' | 'run_now';

/** The two answers the start dialog offers, and the two a memory can hold. */
export type StartMode = 'start' | 'run_now';

/**
 * The mode a `begin` drop should use, or `null` when it has to ask.
 *
 * A function rather than an `if` at the call site so the rule can be asserted:
 * a stray edit that makes a first-run board run Tickets unattended is the one
 * mistake here that spends money before anyone reads a dialog.
 */
export function rememberedStartMode(memory: TicketStartMemory): StartMode | null {
  return memory === 'ask' ? null : memory;
}

/** The label a drop's verb is spoken and announced with. `begin` has no fixed
 *  label: which mode it becomes is only known once the memory or the dialog has
 *  answered, so the caller passes the resolved mode.
 *
 *  The two-part names are **i18n keys, not prose**: `ticket.drop.verb.begin.start`
 *  is one entry, and a `:` separator would read as a key prefix to every reader
 *  of this file while reading as a plain string to `t`. */
export type DropVerb = 'begin.start' | 'begin.run_now' | 'accept' | 'sendBack' | 'reopen';

/** The verb a drop is announced with, once `begin` has been resolved. */
export function dropVerb(drop: TicketDrop, mode: StartMode = 'run_now'): DropVerb {
  switch (drop.kind) {
    case 'begin':
      return mode === 'start' ? 'begin.start' : 'begin.run_now';
    case 'accept':
      return 'accept';
    case 'sendBack':
      return 'sendBack';
    case 'reopen':
      return 'reopen';
  }
}

/**
 * Whether acting on a Ticket leaves the board on screen.
 *
 * **The drag never leaves it**, and this exists so that stays a rule rather than
 * something each call site remembers. A person who drags a card to Running is
 * watching the board; taking them to a conversation would answer a question they
 * did not ask. The card's own Start button is the opposite: it is the "hand this
 * to me, with the brief in front of me" gesture, so it goes where the brief is —
 * unless it was Run now, which has nothing to hand over (the board stays, and the
 * card moves to Running by itself).
 */
export function staysOnBoard(source: 'card' | 'drag', runNow: boolean): boolean {
  if (source === 'drag') return true;
  return runNow;
}

/* ============================================================
   What the card says about the run it just started
   ============================================================ */

/**
 * What a `running` Ticket's session is actually doing, read off the bucket.
 *
 * **Derived, never written to the Ticket** — the same rule `selectRowStatus` and
 * `needsYouCause` follow, and for the same reason: the record's status is a
 * snapshot only `machine.apply` writes, and "the brief is sitting in the input
 * box unsent" is a fact about a session, not a state of the work.
 *
 * It exists because `start` writes `running` before anything has been sent: an
 * attended start parks the brief in the composer, so a card in Running with
 * nothing running in it is otherwise indistinguishable from a working one. That
 * is exactly the misreading design §7.3's "do not imply a channel that is not
 * there" forbids in the other direction.
 */
export type TicketRunState =
  /** Not running, or no live session to read: the card's own badges say why. */
  | 'idle'
  /** The session was opened and has not answered its handshake. */
  | 'connecting'
  /** The brief is in the composer, unsent: the work waits on the person. */
  | 'awaiting_send'
  /** Something has been said in the session, or nothing is parked. */
  | 'sent';

export function ticketRunState(input: {
  status: TicketStatus;
  /** The Assignment's child is alive (`liveKeyOfAssignment !== null`). */
  live: boolean;
  ready: boolean;
  draft: string;
  hasSpoken: boolean;
  brief: string;
}): TicketRunState {
  if (input.status !== 'running' || !input.live) return 'idle';
  if (!input.ready) return 'connecting';
  if (input.hasSpoken) return 'sent';
  const parked = input.draft.trim();
  // A brief of nothing is no evidence of a parked brief; the card is already
  // saying the Ticket cannot start.
  if (parked !== '' && parked === input.brief.trim()) return 'awaiting_send';
  return 'sent';
}

/**
 * Whether a Ticket in `review` has an agent working in its session again.
 *
 * `review` is written when the agent *reports* done, and nothing in the machine
 * moves it afterwards: the person can open the session and keep talking, the
 * agent starts a new turn, and the record still says "ready for you". The status
 * is left alone on purpose (opening a session moves nothing, invariant 7), so
 * the card says the second half out loud instead - **derived from the session,
 * never written to the Ticket**, like `ticketRunState` - and Accept waits for
 * the turn to end, so a half-finished change cannot be signed off.
 */
export function ticketAgentBusy(input: {
  status: TicketStatus;
  /** The Assignment's child is alive (`liveKeyOfAssignment !== null`). */
  live: boolean;
  /** A turn is in flight in that session. */
  turnRunning: boolean;
}): boolean {
  return input.status === 'review' && input.live && input.turnRunning;
}

/**
 * Whether "Start" / "Start over" can put this Ticket's brief on the wire.
 *
 * A `ticket_bind` carrying more than the runtime's ceilings is **refused**, and
 * the refusal is a notice in the session's transcript while the Ticket goes on
 * saying Running with no report tool — design §5.4's "do not imply a channel
 * that is not there", reached by an oversized paste. The card asks this before
 * offering the button, so the refusal never has to be explained.
 */
export function canBindBrief(ticket: Pick<Ticket, 'title' | 'brief'>): boolean {
  return unbindableField(ticket) === null;
}
