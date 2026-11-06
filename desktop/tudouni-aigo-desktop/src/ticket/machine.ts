/**
 * The Ticket state machine: the only place a Ticket's `status` is written.
 *
 * `apply(ticket, input)` is a pure function of its arguments — no clock, no
 * random ids, no I/O — so the same function can later run on a server and so
 * every rule below can be asserted without a window (`docs/design/ticket.md`
 * §4). Anything that varies (the time, a new Assignment's id) arrives on the
 * input.
 *
 * Two kinds of input, named the way the design names them:
 *
 *   - **Commands** (`start`, `accept`, `sendBack`, `drop`, `reopen`, `edit`) are
 *     the person's. They can be **refused**, and a refusal changes nothing.
 *   - **Facts** (`assignmentStarted`, `reported`, `assignmentExited`,
 *     `assignmentRestoreFailed`, `personReplied`) are something that already
 *     happened. They are **never refused**: a fact that cannot move the status
 *     is still true, so it is recorded (or, for a fact about a session that is
 *     not this Ticket's executor, dropped as noise) and the status stays.
 *
 * What was added to the design's list, and why:
 *
 *   - `start` carries the executor (`sessionKey`, `remoteWorkspaceId`) and
 *     creates the Assignment itself. The caller opens the session first and
 *     issues `start` only once a bucket exists, so a failed open leaves the
 *     Ticket untouched ("no fake success"). `assignmentStarted` is then the
 *     fact that fills in what only the session knows: its `sessionId` from
 *     `init` (the first time), or its new `sessionKey` after a resume.
 *   - `assignmentRestoreFailed` is the fact for "I tried to reopen the original
 *     session and could not" (a sendBack whose session file is gone, a
 *     "continue" on a missing workspace). The current Assignment ends as
 *     `restore_failed` and a new one takes over; the status does not move,
 *     because the *reason* the Ticket was running/blocked/in review is still
 *     true. It is a fact rather than a command because the person did not ask
 *     for it — the world answered.
 *
 * Deliberate gaps, each with its reason:
 *
 *   - A fact that changes nothing and has nothing worth recording returns the
 *     **same object**, so a caller can skip the write with `next === prev`.
 *     That covers `personReplied` outside `needs_you` (it fires on every message
 *     the person sends, and 200 events would be gone in an afternoon), and
 *     facts about a session that is not the current executor (a superseded
 *     session exiting is expected, not news).
 *   - Report dedupe reads `events` and `lastReport`. Once an old `reported`
 *     event has been trimmed by the 200 cap, a re-delivered copy of that very
 *     report would be taken as new. The window needs 200 later events plus a
 *     re-delivery of an ancient report; accepted rather than growing a second
 *     id list in the record.
 */
import {
  LOCAL_PERSON,
  TICKET_EVENTS_MAX,
  isWorkspaceRef,
  type Actor,
  type Assignment,
  type Report,
  type Ticket,
  type TicketEvent,
  type TicketEventType,
  type TicketStatus,
} from './model';
import type { TaskWorkspaceRef } from '@/task/tasks';

/* ============================================================
   Inputs
   ============================================================ */

/** The fields a person can edit. Nothing here touches `status`. */
export interface TicketPatch {
  title?: string;
  brief?: string;
  workspace?: TaskWorkspaceRef;
  model?: string;
}

/** Why the child went away, for an exit nobody asked for. `disconnected` comes
 *  from the bridge's `reason: "ssh_closed"`, not from the workspace type.
 *
 *  `unreachable` is the one reason the front end raises itself rather than
 *  reading off a real process exit: the child never answered its handshake, so
 *  there is no session id to resume and no way to send it work. It has to look
 *  like a dead executor, because that is what a Ticket in `running` would
 *  otherwise be stuck with — a "Continue" that cannot resolve an id and no
 *  other way out (see `state/slices/ticketRuns.ts`'s `deliverStart`). */
export type ExitReason = 'crashed' | 'disconnected' | 'unreachable';

/** Which session a fact is about. Both halves because neither is enough alone:
 *  `sessionKey` is a per-app-run counter (a key from last week can name another
 *  session today), `sessionId` does not exist until `init`. */
export interface SessionRef {
  sessionKey: string;
  sessionId: string;
}

export type TicketCommand =
  | {
      type: 'start';
      at: number;
      /** Minted by the caller so this function stays pure. */
      assignmentId: string;
      sessionKey: string;
      remoteWorkspaceId: string | null;
      /** Where the opened session runs; see `Assignment.executor.workspace`. */
      workspace?: string;
    }
  | { type: 'accept'; at: number }
  | { type: 'sendBack'; at: number; feedback: string }
  | { type: 'drop'; at: number }
  | { type: 'reopen'; at: number }
  | { type: 'edit'; at: number; patch: TicketPatch };

export type TicketFact =
  | ({ type: 'assignmentStarted'; at: number } & SessionRef)
  | { type: 'reported'; at: number; report: Report }
  | ({
      type: 'assignmentExited';
      at: number;
      /** True when the front end asked the child to stop. */
      requested: boolean;
      /** Ignored when `requested`; defaults to `crashed` otherwise. */
      reason?: ExitReason;
    } & SessionRef)
  | {
      type: 'assignmentRestoreFailed';
      at: number;
      /** The replacement Assignment's id. */
      assignmentId: string;
      sessionKey: string;
      remoteWorkspaceId: string | null;
      workspace?: string;
    }
  | { type: 'personReplied'; at: number; sessionId: string };

export type TicketInput = TicketCommand | TicketFact;

/** An input as a caller writes it: the time is optional, because nearly every
 *  caller means "now" and the slice stamps it. Distributes over the union so
 *  the `type` discriminant survives the `Omit`. */
export type TicketInputDraft = TicketInput extends infer T
  ? T extends TicketInput
    ? Omit<T, 'at'> & { at?: number }
    : never
  : never;

export type TicketRefusal =
  /** The command does not apply in the Ticket's current status. */
  | 'wrong_status'
  /** `start` on a Ticket with nothing to tell the session. */
  | 'empty_brief'
  /** `sendBack` without an opinion: the feedback is the message that is sent. */
  | 'empty_feedback'
  /** `edit` with a field of the wrong shape. */
  | 'invalid_edit'
  /** Not an input this machine knows (only reachable from untyped callers). */
  | 'unknown_input';

export type ApplyResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: TicketRefusal };

/* ============================================================
   Queries
   ============================================================ */

/** The in-flight Assignment, or `null`. At most one exists (the guard checks). */
export function currentAssignment(ticket: Ticket): Assignment | null {
  for (let i = ticket.assignments.length - 1; i >= 0; i -= 1) {
    if (ticket.assignments[i].end === null) return ticket.assignments[i];
  }
  return null;
}

/** Whether a session may be bound to this Ticket: the three states in which
 *  somebody is still working on, or waiting on, it. */
export function isBindable(ticket: Ticket): boolean {
  return ticket.status === 'running' || ticket.status === 'needs_you' || ticket.status === 'review';
}

/**
 * Whether the binding a session came back with (`init.ticket`) no longer holds
 * and should be cleared (`ticket_bind null`) — design §5.1.
 *
 * Stale when the Ticket is gone, is not in a bindable state, or its current
 * Assignment is some other session. **Call it only after the Tickets have
 * loaded and after reconcile**: a missing Ticket reads as stale, so asking
 * before the file is read would unbind every session; and a report that was
 * still to be folded in could be the thing that makes the binding current.
 */
export function bindingIsStale(ticket: Ticket | null | undefined, sessionId: string): boolean {
  if (ticket === null || ticket === undefined) return true;
  if (!isBindable(ticket)) return true;
  const current = currentAssignment(ticket);
  if (current === null) return true;
  // An Assignment whose sessionId is not known yet cannot be the session that
  // is asking — it has an id, so `init` has landed and the caller should have
  // back-filled it first.
  return current.executor.sessionId === '' || current.executor.sessionId !== sessionId;
}

/** Whether a report has already been folded in. */
export function hasSeenReport(ticket: Ticket, reportId: string): boolean {
  if (ticket.lastReport?.reportId === reportId) return true;
  return ticket.events.some((event) => reportIdOf(event) === reportId);
}

function reportIdOf(event: TicketEvent): string | null {
  if (event.type !== 'reported') return null;
  const report = event.data?.report as Partial<Report> | undefined;
  return typeof report?.reportId === 'string' ? report.reportId : null;
}

/* ============================================================
   Internals
   ============================================================ */

const refuse = (reason: TicketRefusal): ApplyResult => ({ ok: false, reason });
const accept = (ticket: Ticket): ApplyResult => ({ ok: true, ticket });

/** Whether `assignment` is the executor a fact names. Once the session id is
 *  known it is the only identity (a stale `sessionKey` from an earlier app run
 *  can equal a live one); before `init` the key is all there is. */
function owns(assignment: Assignment, ref: SessionRef): boolean {
  if (assignment.executor.sessionId !== '') return ref.sessionId === assignment.executor.sessionId;
  return ref.sessionKey !== '' && assignment.executor.sessionKey === ref.sessionKey;
}

/** Keep the newest events, but never lose `created`: it is the one entry that
 *  says where the Ticket came from. */
function trimEvents(events: TicketEvent[]): TicketEvent[] {
  if (events.length <= TICKET_EVENTS_MAX) return events;
  const created = events.find((event) => event.type === 'created');
  if (created === undefined) return events.slice(events.length - TICKET_EVENTS_MAX);
  const rest = events.filter((event) => event !== created);
  return [created, ...rest.slice(rest.length - (TICKET_EVENTS_MAX - 1))];
}

/** One write path for every transition, so no branch can forget to record the
 *  event or move `updatedAtMs`. `Math.max` because reconcile replays facts with
 *  their original times, and an update must not look older than the record. */
function commit(
  ticket: Ticket,
  at: number,
  actor: Actor,
  type: TicketEventType,
  data: Record<string, unknown> | undefined,
  changes: Partial<Pick<Ticket, 'title' | 'brief' | 'workspace' | 'model' | 'status' | 'assignments' | 'lastReport'>>,
): ApplyResult {
  const event: TicketEvent = data === undefined ? { at, actor, type } : { at, actor, type, data };
  return accept({
    ...ticket,
    ...changes,
    events: trimEvents([...ticket.events, event]),
    updatedAtMs: Math.max(ticket.updatedAtMs, at),
  });
}

/** `assignments` with the in-flight one closed. */
function ending(
  ticket: Ticket,
  at: number,
  end: NonNullable<Assignment['end']>,
): Assignment[] {
  return ticket.assignments.map((a) =>
    a.end === null ? { ...a, endedAtMs: at, end } : a,
  );
}

function newAssignment(
  id: string,
  at: number,
  sessionKey: string,
  remoteWorkspaceId: string | null,
  workspace?: string,
): Assignment {
  return {
    id,
    // `sessionId` stays empty until `init` names it.
    executor: {
      kind: 'session',
      sessionKey,
      sessionId: '',
      remoteWorkspaceId,
      ...(workspace !== undefined && workspace !== '' ? { workspace } : {}),
    },
    startedAtMs: at,
    endedAtMs: null,
    end: null,
  };
}

/* ============================================================
   apply
   ============================================================ */

export function apply(ticket: Ticket, input: TicketInput): ApplyResult {
  switch (input.type) {
    /* ---------------- commands ---------------- */

    case 'start': {
      // `open` is the first start; `needs_you` is "start over with a fresh
      // session". A running or in-review Ticket already has an executor the
      // person is looking at: replacing it silently is what sendBack and
      // "open the session" are for.
      if (ticket.status !== 'open' && ticket.status !== 'needs_you') return refuse('wrong_status');
      if (ticket.brief.trim() === '') return refuse('empty_brief');
      const previous = currentAssignment(ticket);
      const assignments = [
        ...(previous === null ? ticket.assignments : ending(ticket, input.at, 'superseded')),
        newAssignment(input.assignmentId, input.at, input.sessionKey, input.remoteWorkspaceId, input.workspace),
      ];
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'start',
        { assignmentId: input.assignmentId, superseded: previous?.id ?? null },
        { status: 'running', assignments },
      );
    }

    case 'accept': {
      // Only the person sets `done` (invariant 4); an agent's "done" is a
      // report that lands in `review`.
      if (ticket.status !== 'review') return refuse('wrong_status');
      const current = currentAssignment(ticket);
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'accept',
        current === null ? undefined : { assignmentId: current.id },
        { status: 'done', assignments: ending(ticket, input.at, 'accepted') },
      );
    }

    case 'sendBack': {
      if (ticket.status !== 'review') return refuse('wrong_status');
      const feedback = input.feedback.trim();
      if (feedback === '') return refuse('empty_feedback');
      // The Assignment stays: the same session gets the opinion as a message.
      return commit(ticket, input.at, LOCAL_PERSON, 'sendBack', { feedback }, { status: 'running' });
    }

    case 'drop': {
      if (ticket.status === 'done' || ticket.status === 'dropped') return refuse('wrong_status');
      const current = currentAssignment(ticket);
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'drop',
        current === null ? undefined : { assignmentId: current.id },
        { status: 'dropped', assignments: ending(ticket, input.at, 'dropped') },
      );
    }

    case 'reopen': {
      // Deliberate and never automatic. Both terminal states have no
      // in-flight Assignment, so `open` keeps the invariant that an open
      // Ticket has no executor.
      if (ticket.status !== 'done' && ticket.status !== 'dropped') return refuse('wrong_status');
      return commit(ticket, input.at, LOCAL_PERSON, 'reopen', { from: ticket.status }, { status: 'open' });
    }

    case 'edit': {
      const { patch } = input;
      const changes: Partial<Pick<Ticket, 'title' | 'brief' | 'workspace' | 'model'>> = {};
      const fields: string[] = [];
      for (const key of ['title', 'brief', 'model'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (typeof value !== 'string') return refuse('invalid_edit');
        if (value !== ticket[key]) {
          changes[key] = value;
          fields.push(key);
        }
      }
      if (patch.workspace !== undefined) {
        if (!isWorkspaceRef(patch.workspace)) return refuse('invalid_edit');
        if (JSON.stringify(patch.workspace) !== JSON.stringify(ticket.workspace)) {
          changes.workspace = patch.workspace;
          fields.push('workspace');
        }
      }
      // Allowed in every status: re-pointing a Ticket at another workspace
      // must work on one whose workspace was deleted, and fixing a typo in a
      // finished one is harmless. Only the *names* of the fields go in the
      // event — a brief can be pages long and the history is capped by count,
      // not size.
      if (fields.length === 0) return accept(ticket);
      return commit(ticket, input.at, LOCAL_PERSON, 'edited', { fields }, changes);
    }

    /* ---------------- facts ---------------- */

    case 'assignmentStarted': {
      const current = currentAssignment(ticket);
      if (current === null || !owns(current, input)) return accept(ticket);
      const sessionId = input.sessionId !== '' ? input.sessionId : current.executor.sessionId;
      const sessionKey = input.sessionKey !== '' ? input.sessionKey : current.executor.sessionKey;
      // A re-delivered `init` says nothing new.
      if (sessionId === current.executor.sessionId && sessionKey === current.executor.sessionKey) {
        return accept(ticket);
      }
      const assignments = ticket.assignments.map((a) =>
        a === current ? { ...a, executor: { ...a.executor, sessionId, sessionKey } } : a,
      );
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'assignmentStarted',
        { assignmentId: current.id, sessionKey, sessionId },
        { assignments },
      );
    }

    case 'reported': {
      const { report } = input;
      // Idempotent by report id (design §5.3): live delivery and reconcile can
      // both bring the same report, in either order.
      if (hasSeenReport(ticket, report.reportId)) return accept(ticket);

      const current = currentAssignment(ticket);
      // Another session's report must not speak for this Ticket: a superseded
      // session can still be alive and still call the tool. An empty executor
      // id is "init has not landed yet", which cannot rule a report out; and a
      // Ticket with no executor (dropped, done) has nobody to be foreign to —
      // the report is recorded and shown as the last word.
      const foreign =
        current !== null &&
        current.executor.sessionId !== '' &&
        current.executor.sessionId !== report.sessionId;
      // Only a running Ticket moves (invariant 5). Anything else — dropped,
      // already in review, blocked — records what was said and stays.
      const moves = !foreign && current !== null && ticket.status === 'running';
      const status: TicketStatus = moves
        ? report.status === 'done'
          ? 'review'
          : 'needs_you'
        : ticket.status;
      return commit(
        ticket,
        input.at,
        { kind: 'agent', sessionId: report.sessionId },
        'reported',
        { report, applied: moves },
        { status, lastReport: foreign ? ticket.lastReport : report },
      );
    }

    case 'assignmentExited': {
      const current = currentAssignment(ticket);
      if (current === null || !owns(current, input)) return accept(ticket);
      // Only a running Ticket moves (invariant 6). A blocked or in-review
      // Ticket is still blocked or in review with nobody connected — and a
      // requested exit is a person closing a window, not a problem.
      const moves = ticket.status === 'running' && !input.requested;
      const data: Record<string, unknown> = { assignmentId: current.id, requested: input.requested };
      if (!input.requested) data.reason = input.reason ?? 'crashed';
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'assignmentExited',
        data,
        moves ? { status: 'needs_you' } : {},
      );
    }

    case 'assignmentRestoreFailed': {
      const current = currentAssignment(ticket);
      if (current === null) {
        return commit(ticket, input.at, { kind: 'system' }, 'assignmentRestoreFailed', { applied: false }, {});
      }
      // Ends the old executor and starts the replacement in one step, so the
      // "at most one in-flight Assignment" invariant never has a gap. The
      // status stays: a sendBack already made it `running`, a blocked Ticket is
      // still blocked.
      const assignments = [
        ...ending(ticket, input.at, 'restore_failed'),
        newAssignment(input.assignmentId, input.at, input.sessionKey, input.remoteWorkspaceId, input.workspace),
      ];
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'assignmentRestoreFailed',
        { applied: true, failed: current.id, assignmentId: input.assignmentId },
        { assignments },
      );
    }

    case 'personReplied': {
      const current = currentAssignment(ticket);
      // Not recorded unless it moves anything: this fires on every message the
      // person sends in a bound session (see the header).
      if (ticket.status !== 'needs_you' || current === null) return accept(ticket);
      if (current.executor.sessionId === '' || current.executor.sessionId !== input.sessionId) {
        return accept(ticket);
      }
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'personReplied',
        { assignmentId: current.id },
        { status: 'running' },
      );
    }

    default: {
      const unreachable: never = input;
      void unreachable;
      return refuse('unknown_input');
    }
  }
}
