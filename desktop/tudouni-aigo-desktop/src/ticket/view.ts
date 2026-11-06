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
