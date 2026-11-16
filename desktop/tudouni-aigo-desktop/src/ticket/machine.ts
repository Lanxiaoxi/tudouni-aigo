/**
 * The Ticket state machine: the only place a Ticket's `status` is written.
 *
 * `apply(ticket, input)` is a pure function of its arguments - no clock, no
 * random ids, no I/O - so the same function can later run on a server and so
 * every rule below can be asserted without a window (`docs/design/ticket.md`
 * §4). Anything that varies (the time, a new Assignment's id) arrives on the
 * input.
 *
 * Two kinds of input, named the way the design names them:
 *
 *   - **Commands** (`start`, `newSession`, `restart`, `removeSession`, `accept`,
 *     `sendBack`, `drop`, `reopen`, `edit`) are the person's. They can be
 *     **refused**, and a refusal changes nothing.
 *   - **Facts** (`sessionStarted`, `reported`, `turnEnded`, `sessionExited`,
 *     `sessionRestoreFailed`, `personReplied`) are something that already
 *     happened. They are **never refused**: a fact that cannot move the status
 *     is still true, so it is recorded (or, for a fact about a session that is
 *     not on this Ticket, dropped as noise) and the status stays.
 *
 * ## Worker and sessions (`docs/design/ticket-notes.md` §3)
 *
 * An Assignment is a **worker**, and a worker owns a list of **sessions**.
 * Sessions on the Ticket ("present") are equals: a report, a turn end or a reply
 * from any of them counts. A session that was moved off ("removed") stays in the
 * list so it can be read back, but the facts it sends are history, not news.
 * What used to be "the executor changed" (`superseded`, `restore_failed`) is now
 * the worker's own business, so those endings became a session's `removed`.
 *
 * Deliberate gaps, each with its reason:
 *
 *   - A fact that changes nothing and has nothing worth recording returns the
 *     **same object**, so a caller can skip the write with `next === prev`.
 *     That covers `turnEnded` outside `running`, and facts about a session that
 *     is not on the Ticket (a removed session exiting is expected, not news).
 *     `personReplied` outside `needs_you` records no event (it fires on every
 *     message the person sends, and 200 events would be gone in an afternoon)
 *     but still advances the session's `lastActiveAtMs`, because that is what
 *     "open" and "send back" default to; it returns the same object when even
 *     that is not news.
 *   - Report dedupe reads `events` and `lastReport`. Once an old `reported`
 *     event has been trimmed by the 200 cap, a re-delivered copy of that very
 *     report would be taken as new. The window needs 200 later events plus a
 *     re-delivery of an ancient report; accepted rather than growing a second
 *     id list in the record.
 *   - The rule that sums several sessions' exits into one signal (3.4 of the
 *     design) lives in `state/ticketLanding.ts` (it reads whether a turn was in
 *     flight) and in `sessionExited` below. It is a worker-level rule; when a
 *     second kind of worker exists it is the first thing to move.
 */
import {
  LOCAL_PERSON,
  TICKET_ATTACHMENTS_MAX,
  TICKET_EVENTS_MAX,
  isReservedAttachmentName,
  isValidAttachment,
  isWorkspaceRef,
  noteWriteProblem,
  type NoteOp,
  type NoteProblem,
  type TicketAttachment,
  type TicketNote,
  type Actor,
  type Assignment,
  type Report,
  type Ticket,
  type TurnEnd,
  type TicketEvent,
  type TicketEventType,
  type TicketStatus,
  type WorkerSession,
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
  /** The whole list, replaced. The bytes are the slice's business (a file is
   *  copied before the record names it); the machine only records the change. */
  attachments?: TicketAttachment[];
}

/** Why the child went away, for an exit nobody asked for. `disconnected` comes
 *  from the bridge's `reason: "ssh_closed"`, not from the workspace type.
 *
 *  `unreachable` is the one reason the front end raises itself rather than
 *  reading off a real process exit: the child never answered its handshake, so
 *  there is no session id to resume and no way to send it work. That session is
 *  taken off the Ticket, and when it was the only one that ever could have
 *  worked, the Ticket looks like a dead executor - which is what a Ticket in
 *  `running` would otherwise be stuck with. */
export type ExitReason = 'crashed' | 'disconnected' | 'unreachable';

/** Which session a fact is about. Both halves because neither is enough alone:
 *  `sessionKey` is a per-app-run counter (a key from last week can name another
 *  session today), `sessionId` does not exist until `init`. */
export interface SessionRef {
  sessionKey: string;
  sessionId: string;
}

/** What a command or fact that adds a session carries: the child is already
 *  open, so the machine only records where it runs. */
export interface NewSessionFields {
  sessionKey: string;
  remoteWorkspaceId: string | null;
  /** Where the opened session runs; see `WorkerSession.workspace`. */
  workspace?: string;
  title?: string;
}

export type TicketCommand =
  | ({
      type: 'start';
      at: number;
      /** Minted by the caller so this function stays pure. */
      assignmentId: string;
    } & NewSessionFields)
  | ({
      type: 'newSession';
      at: number;
      /** Whether the brief was put in the new session's input. History only. */
      withBrief?: boolean;
    } & NewSessionFields)
  | ({ type: 'restart'; at: number } & NewSessionFields)
  | ({ type: 'removeSession'; at: number } & SessionRef)
  | { type: 'accept'; at: number }
  | {
      type: 'sendBack';
      at: number;
      feedback: string;
      /** The present session that receives it. Omitted = the most recently
       *  active one. */
      sessionId?: string;
    }
  | { type: 'drop'; at: number }
  | { type: 'reopen'; at: number }
  | { type: 'edit'; at: number; patch: TicketPatch }
  | {
      /** The person writes a note (`ticket-notes.md` 4.2). Allowed in every
       *  status, and on any note, whoever wrote it. */
      type: 'note';
      at: number;
      op: NoteOp;
      /** `update` / `remove`: which note. */
      noteId?: string;
      /** `add` / `update`: the new text. */
      text?: string;
      /** `add`: the id of the new note, minted by the caller (`newNoteId`) so
       *  this function stays pure. */
      noteIdMinted?: string;
    };

export type TicketFact =
  | ({ type: 'sessionStarted'; at: number } & SessionRef)
  | { type: 'reported'; at: number; report: Report }
  | { type: 'turnEnded'; at: number; turnEnd: TurnEnd }
  | ({
      type: 'sessionExited';
      at: number;
      /** True when the front end asked the child to stop. */
      requested: boolean;
      /** Whether a turn was in flight when the child went (read off the
       *  session by the caller at that moment). Only an unrequested exit in
       *  the middle of a turn can be a problem for a running Ticket. */
      midTurn: boolean;
      /** Ignored when `requested`; defaults to `crashed` otherwise. */
      reason?: ExitReason;
    } & SessionRef)
  | ({
      type: 'sessionRestoreFailed';
      at: number;
      /** The present session that could not be reopened. */
      failed: SessionRef;
    } & NewSessionFields)
  | { type: 'personReplied'; at: number; sessionId: string }
  | {
      /** An agent's `ticket_note` call, as the runtime forwarded it. The
       *  machine decides whether it changed anything: only a **present**
       *  session of the current worker counts, and only for the notes an agent
       *  wrote. Never refused (it already happened); at worst it is recorded
       *  and nothing else moves. */
      type: 'noted';
      at: number;
      /** Minted by the runtime. The key every duplicate is recognised by. */
      opId: string;
      op: NoteOp;
      noteId: string;
      /** `null` / absent for `remove`. */
      text?: string | null;
      sessionId: string;
    };

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
  /** `start` / `restart` on a Ticket with nothing to tell the session. */
  | 'empty_brief'
  /** `sendBack` without an opinion: the feedback is the message that is sent. */
  | 'empty_feedback'
  /** `edit` with a field of the wrong shape. */
  | 'invalid_edit'
  /** `removeSession` / `sendBack` naming a session that is not on the Ticket. */
  | 'unknown_session'
  /** `removeSession` of the last present session: a Running Ticket with nobody
   *  on it is a fake one. Restart it, or drop it. */
  | 'last_session'
  /** `note` whose text cannot be stored: empty, or over a ceiling. */
  | NoteProblem
  /** `note` update / remove naming a note that is not on the Ticket. */
  | 'unknown_note'
  /** `note` that is not well formed (unknown op, `add` without a fresh id). */
  | 'invalid_note'
  /** Not an input this machine knows (only reachable from untyped callers). */
  | 'unknown_input';

export type ApplyResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: TicketRefusal };

/* ============================================================
   Queries
   ============================================================ */

/** The in-flight Assignment (the current worker), or `null`. At most one exists
 *  (the guard checks). */
export function currentAssignment(ticket: Ticket): Assignment | null {
  for (let i = ticket.assignments.length - 1; i >= 0; i -= 1) {
    if (ticket.assignments[i].end === null) return ticket.assignments[i];
  }
  return null;
}

/** The sessions of a worker that are on the Ticket, in the order they joined. */
export function presentSessions(assignment: Assignment | null): WorkerSession[] {
  if (assignment === null) return [];
  return assignment.executor.sessions.filter((session) => session.removedAtMs === null);
}

/** The present session with the newest activity (ties go to the later joiner):
 *  where "open" and "send back" go by default. `null` when none is present. */
export function mostRecentSessionOf(assignment: Assignment | null): WorkerSession | null {
  let best: WorkerSession | null = null;
  for (const session of presentSessions(assignment)) {
    if (best === null || session.lastActiveAtMs >= best.lastActiveAtMs) best = session;
  }
  return best;
}

/** `mostRecentSessionOf` for a Ticket's current worker. */
export function mostRecentSession(ticket: Ticket): WorkerSession | null {
  return mostRecentSessionOf(currentAssignment(ticket));
}

/** Whether `sessionId` is a session on this Ticket's current worker. An empty
 *  id is never present: it names nothing yet. */
export function isPresentSession(ticket: Ticket, sessionId: string): boolean {
  if (sessionId === '') return false;
  return presentSessions(currentAssignment(ticket)).some((session) => session.sessionId === sessionId);
}

/** Whether `session` is the one a fact names. Once the session id is known it is
 *  the only identity (a stale `sessionKey` from an earlier app run can equal a
 *  live one); before `init` the key is all there is. */
export function sessionOwns(session: WorkerSession, ref: SessionRef): boolean {
  if (session.sessionId !== '') return ref.sessionId === session.sessionId;
  return ref.sessionKey !== '' && session.sessionKey === ref.sessionKey;
}

/** Whether a session may be bound to this Ticket: the three states in which
 *  somebody is still working on, or waiting on, it. */
export function isBindable(ticket: Ticket): boolean {
  return ticket.status === 'running' || ticket.status === 'needs_you' || ticket.status === 'review';
}

/**
 * Whether the binding a session came back with (`init.ticket`) no longer holds
 * and should be cleared (`ticket_bind null`) - design §5.1, 3.5.
 *
 * Stale when the Ticket is gone, is not in a bindable state, or the session is
 * not a **present** session of its current worker. An old session of the same
 * worker is *not* stale: opening it does not kick it off the Ticket. **Call it
 * only after the Tickets have loaded and after reconcile**: a missing Ticket
 * reads as stale, so asking before the file is read would unbind every session;
 * and a report that was still to be folded in could be the thing that makes the
 * binding current.
 */
export function bindingIsStale(ticket: Ticket | null | undefined, sessionId: string): boolean {
  if (ticket === null || ticket === undefined) return true;
  if (!isBindable(ticket)) return true;
  // A session whose id is not known yet cannot be the session that is asking:
  // it has an id, so `init` has landed and the caller should have back-filled
  // it first.
  return !isPresentSession(ticket, sessionId);
}

/** Whether a report has already been folded in. */
export function hasSeenReport(ticket: Ticket, reportId: string): boolean {
  if (ticket.lastReport?.reportId === reportId) return true;
  return ticket.events.some((event) => reportIdOf(event) === reportId);
}

/** Whether a turn end has already been recorded. Only an *applied* one leaves
 *  an event (see `turnEnded`), so a redelivery after the Ticket left `review`
 *  and came back to `running` is judged again, which is the right answer: the
 *  fact is about a turn that has already been folded in once. */
export function hasSeenTurnEnd(ticket: Ticket, turnId: string): boolean {
  return ticket.events.some(
    (event) => event.type === 'turnEndedUnreported' && event.data?.turnId === turnId,
  );
}

/** Whether a note operation has already been folded in. Every `noted` fact
 *  leaves an event carrying its op id - applied or not - so a redelivery (live,
 *  then `init`'s `note_ops`) is recognised either way. Like reports, the window
 *  closes when the 200-event cap trims the event; an `add` is additionally
 *  protected by its note id already existing. */
export function hasSeenNoteOp(ticket: Ticket, opId: string): boolean {
  return ticket.events.some((event) => event.type === 'noted' && event.data?.opId === opId);
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
  changes: Partial<Pick<Ticket, 'title' | 'brief' | 'workspace' | 'model' | 'status' | 'assignments' | 'lastReport' | 'attachments' | 'notes'>>,
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

/** `assignments` with `current`'s session list rewritten. */
function withSessions(
  ticket: Ticket,
  current: Assignment,
  rewrite: (sessions: WorkerSession[]) => WorkerSession[],
): Assignment[] {
  return ticket.assignments.map((a) =>
    a === current ? { ...a, executor: { ...a.executor, sessions: rewrite(a.executor.sessions) } } : a,
  );
}

/** The newest last-activity time among a worker's present sessions. */
function newestActivity(assignment: Assignment): number {
  return presentSessions(assignment).reduce((best, s) => Math.max(best, s.lastActiveAtMs), 0);
}

/** Advance one session's last activity (never backwards: reconcile replays old
 *  facts). */
function touched(session: WorkerSession, at: number): WorkerSession {
  return at > session.lastActiveAtMs ? { ...session, lastActiveAtMs: at } : session;
}

function newWorkerSession(fields: NewSessionFields, at: number): WorkerSession {
  return {
    sessionKey: fields.sessionKey,
    // Empty until `init` names it.
    sessionId: '',
    remoteWorkspaceId: fields.remoteWorkspaceId,
    ...(fields.workspace !== undefined && fields.workspace !== '' ? { workspace: fields.workspace } : {}),
    ...(fields.title !== undefined && fields.title !== '' ? { title: fields.title } : {}),
    joinedAtMs: at,
    lastActiveAtMs: at,
    removedAtMs: null,
  };
}

function newAssignment(id: string, at: number, session: WorkerSession): Assignment {
  return {
    id,
    executor: { kind: 'person', sessions: [session] },
    startedAtMs: at,
    endedAtMs: null,
    end: null,
  };
}

/** Where a session id sits in a worker: a present session, a removed one, or
 *  nowhere. A removed session is *known* and still not obeyed. */
function locate(
  current: Assignment,
  sessionId: string,
): { present: WorkerSession | null; removed: boolean } {
  if (sessionId === '') return { present: null, removed: false };
  const found = current.executor.sessions.find((session) => session.sessionId === sessionId);
  if (found === undefined) return { present: null, removed: false };
  return found.removedAtMs === null ? { present: found, removed: false } : { present: null, removed: true };
}

/** Whether some present session has not been named by `init` yet. Such a
 *  session cannot rule a fact out ("a report before init still counts"). */
function hasUnnamedPresent(current: Assignment): boolean {
  return current.executor.sessions.some((s) => s.removedAtMs === null && s.sessionId === '');
}

/* ============================================================
   apply
   ============================================================ */

export function apply(ticket: Ticket, input: TicketInput): ApplyResult {
  switch (input.type) {
    /* ---------------- commands ---------------- */

    case 'start': {
      // `open` is the only start. A running, blocked or in-review Ticket
      // already has a worker: another conversation is `newSession`, a fresh
      // start after trouble is `restart`.
      if (ticket.status !== 'open') return refuse('wrong_status');
      if (ticket.brief.trim() === '') return refuse('empty_brief');
      const previous = currentAssignment(ticket);
      const assignments = [
        ...(previous === null ? ticket.assignments : ending(ticket, input.at, 'superseded')),
        newAssignment(input.assignmentId, input.at, newWorkerSession(input, input.at)),
      ];
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'start',
        { assignmentId: input.assignmentId, sessionKey: input.sessionKey, superseded: previous?.id ?? null },
        { status: 'running', assignments },
      );
    }

    case 'newSession': {
      // Another conversation on the same worker. From `review` it goes back to
      // `running` on purpose: opening a session on the work is the person
      // saying "carry on".
      if (!isBindable(ticket)) return refuse('wrong_status');
      const current = currentAssignment(ticket);
      if (current === null) return refuse('wrong_status');
      const assignments = withSessions(ticket, current, (sessions) => [
        ...sessions,
        newWorkerSession(input, input.at),
      ]);
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'newSession',
        { assignmentId: current.id, sessionKey: input.sessionKey, withBrief: input.withBrief === true },
        { status: 'running', assignments },
      );
    }

    case 'restart': {
      // "Start over": a new session with the brief, and every other session
      // taken off the Ticket - the protection against a derailed conversation
      // still speaking for the work.
      if (ticket.status !== 'needs_you') return refuse('wrong_status');
      if (ticket.brief.trim() === '') return refuse('empty_brief');
      const current = currentAssignment(ticket);
      if (current === null) return refuse('wrong_status');
      const removedKeys = presentSessions(current).map((s) => s.sessionId || s.sessionKey);
      const assignments = withSessions(ticket, current, (sessions) => [
        ...sessions.map((s): WorkerSession =>
          s.removedAtMs === null ? { ...s, removedAtMs: input.at, removed: 'restart' } : s,
        ),
        newWorkerSession(input, input.at),
      ]);
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'restart',
        { assignmentId: current.id, sessionKey: input.sessionKey, removed: removedKeys },
        { status: 'running', assignments },
      );
    }

    case 'removeSession': {
      if (!isBindable(ticket)) return refuse('wrong_status');
      const current = currentAssignment(ticket);
      if (current === null) return refuse('wrong_status');
      const present = presentSessions(current);
      const target = present.find((s) => sessionOwns(s, input));
      if (target === undefined) return refuse('unknown_session');
      if (present.length <= 1) return refuse('last_session');
      const assignments = withSessions(ticket, current, (sessions) =>
        sessions.map((s): WorkerSession =>
          s === target ? { ...s, removedAtMs: input.at, removed: 'person' } : s,
        ),
      );
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'removeSession',
        { assignmentId: current.id, sessionId: target.sessionId, sessionKey: target.sessionKey },
        { assignments },
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
      const current = currentAssignment(ticket);
      let target: WorkerSession | null = null;
      if (input.sessionId !== undefined && input.sessionId !== '') {
        target = presentSessions(current).find((s) => s.sessionId === input.sessionId) ?? null;
        if (target === null) return refuse('unknown_session');
      } else {
        target = mostRecentSessionOf(current);
      }
      // The Assignment stays: one present session gets the opinion as a message.
      const chosen = target;
      const assignments =
        current !== null && chosen !== null
          ? withSessions(ticket, current, (sessions) =>
              sessions.map((s) => (s === chosen ? touched(s, input.at) : s)),
            )
          : ticket.assignments;
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'sendBack',
        { feedback, sessionId: chosen?.sessionId ?? '' },
        { status: 'running', assignments },
      );
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
      // Ticket has no worker.
      if (ticket.status !== 'done' && ticket.status !== 'dropped') return refuse('wrong_status');
      return commit(ticket, input.at, LOCAL_PERSON, 'reopen', { from: ticket.status }, { status: 'open' });
    }

    case 'edit': {
      const { patch } = input;
      const changes: Partial<Pick<Ticket, 'title' | 'brief' | 'workspace' | 'model' | 'attachments'>> = {};
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
      if (patch.attachments !== undefined) {
        const list = patch.attachments;
        const before = ticket.attachments ?? [];
        if (
          !Array.isArray(list) ||
          list.length > TICKET_ATTACHMENTS_MAX ||
          !list.every(isValidAttachment) ||
          new Set(list.map((a) => a.name)).size !== list.length ||
          // `brief.md` is the name the desktop stages the full brief under
          // (3.6). A record that already carries one is left alone (the guard
          // must not drop it), but a new one is refused.
          (list.some((a) => isReservedAttachmentName(a.name)) &&
            !before.some((a) => isReservedAttachmentName(a.name)))
        ) {
          return refuse('invalid_edit');
        }
        if (JSON.stringify(list) !== JSON.stringify(before)) {
          changes.attachments = list;
          fields.push('attachments');
        }
      }
      // Allowed in every status: re-pointing a Ticket at another workspace
      // must work on one whose workspace was deleted, and fixing a typo in a
      // finished one is harmless. Only the *names* of the fields go in the
      // event - a brief can be pages long and the history is capped by count,
      // not size.
      if (fields.length === 0) return accept(ticket);
      return commit(ticket, input.at, LOCAL_PERSON, 'edited', { fields }, changes);
    }

    case 'note': {
      // The person's write: allowed in every status (a typo in a finished
      // Ticket's note is harmless, and a decision belongs to the work, not to a
      // state) and on every note, whoever wrote it. Only `{noteId, op}` goes in
      // the event: events are capped by count, not size, and a note can be
      // pages long.
      const { op } = input;
      if (op === 'add') {
        const id = input.noteIdMinted ?? '';
        if (id === '' || ticket.notes.some((n) => n.id === id) || typeof input.text !== 'string') {
          return refuse('invalid_note');
        }
        const problem = noteWriteProblem(ticket.notes, input.text);
        if (problem !== null) return refuse(problem);
        const note: TicketNote = {
          id,
          text: input.text.trim(),
          author: 'person',
          createdAtMs: input.at,
          updatedAtMs: input.at,
        };
        return commit(ticket, input.at, LOCAL_PERSON, 'note', { noteId: id, op }, { notes: [...ticket.notes, note] });
      }
      if (op !== 'update' && op !== 'remove') return refuse('invalid_note');
      const id = input.noteId ?? '';
      const target = ticket.notes.find((n) => n.id === id);
      if (target === undefined) return refuse('unknown_note');
      if (op === 'remove') {
        return commit(
          ticket,
          input.at,
          LOCAL_PERSON,
          'note',
          { noteId: id, op },
          { notes: ticket.notes.filter((n) => n !== target) },
        );
      }
      if (typeof input.text !== 'string') return refuse('invalid_note');
      const problem = noteWriteProblem(ticket.notes, input.text, id);
      if (problem !== null) return refuse(problem);
      const text = input.text.trim();
      // Nothing to record: the same words saved again.
      if (text === target.text) return accept(ticket);
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'note',
        { noteId: id, op },
        { notes: ticket.notes.map((n) => (n === target ? { ...n, text, updatedAtMs: Math.max(n.updatedAtMs, input.at) } : n)) },
      );
    }

    /* ---------------- facts ---------------- */

    case 'noted': {
      // Idempotent by op id: the live message and `init`'s `note_ops` can both
      // bring the same call, in either order. Every `noted` that is processed
      // leaves an event (applied or not), which is what the check reads.
      if (hasSeenNoteOp(ticket, input.opId)) return accept(ticket);
      const { op, noteId } = input;
      const current = currentAssignment(ticket);
      // Why nothing changed, when nothing did. Recorded for the history; the
      // event is the fact that the agent *asked*.
      let skipped: string | null = null;
      let notes = ticket.notes;
      if (current === null || locate(current, input.sessionId).present === null) {
        // A session that is not on this Ticket must not write its notes: a
        // removed one can still be alive and still call the tool, and a Ticket
        // with no worker has nobody to speak for it.
        skipped = 'foreign';
      } else if (op === 'add') {
        if (ticket.notes.some((n) => n.id === noteId)) {
          skipped = 'exists';
        } else if (typeof input.text !== 'string') {
          skipped = 'invalid';
        } else if (noteWriteProblem(ticket.notes, input.text) !== null) {
          // The runtime's copy took it and the canonical list cannot (a person
          // wrote at the same moment). The rebind that follows replaces the
          // runtime's copy, so the two agree again.
          skipped = 'limit';
        } else {
          notes = [
            ...ticket.notes,
            {
              id: noteId,
              text: input.text.trim(),
              author: 'agent',
              sessionId: input.sessionId,
              createdAtMs: input.at,
              updatedAtMs: input.at,
            },
          ];
        }
      } else if (op === 'update' || op === 'remove') {
        const target = ticket.notes.find((n) => n.id === noteId);
        if (target === undefined) {
          skipped = 'missing';
        } else if (target.author !== 'agent') {
          // A person's judgement is the last thing to be rewritten quietly.
          skipped = 'author';
        } else if (op === 'remove') {
          notes = ticket.notes.filter((n) => n !== target);
        } else if (typeof input.text !== 'string') {
          skipped = 'invalid';
        } else if (noteWriteProblem(ticket.notes, input.text, noteId) !== null) {
          skipped = 'limit';
        } else {
          const text = input.text.trim();
          notes = ticket.notes.map((n) =>
            n === target ? { ...n, text, updatedAtMs: Math.max(n.updatedAtMs, input.at) } : n,
          );
        }
      } else {
        skipped = 'invalid';
      }
      // `lastActiveAtMs` is deliberately not touched: the design lists the
      // moments that move it (3.3) and a note is not one of them.
      return commit(
        ticket,
        input.at,
        { kind: 'agent', sessionId: input.sessionId },
        'noted',
        { opId: input.opId, op, noteId, applied: skipped === null, ...(skipped === null ? {} : { skipped }) },
        { notes },
      );
    }

    case 'sessionStarted': {
      const current = currentAssignment(ticket);
      if (current === null) return accept(ticket);
      const target = presentSessions(current).find((s) => sessionOwns(s, input));
      if (target === undefined) return accept(ticket);
      const sessionId = input.sessionId !== '' ? input.sessionId : target.sessionId;
      const sessionKey = input.sessionKey !== '' ? input.sessionKey : target.sessionKey;
      // A re-delivered `init` says nothing new.
      if (sessionId === target.sessionId && sessionKey === target.sessionKey) return accept(ticket);
      const assignments = withSessions(ticket, current, (sessions) =>
        sessions.map((s) =>
          s === target ? touched({ ...s, sessionId, sessionKey }, input.at) : s,
        ),
      );
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'sessionStarted',
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
      // A session that is not on the Ticket must not speak for it: a removed
      // one can still be alive and still call the tool. A present session that
      // `init` has not named yet cannot rule a report out; and a Ticket with no
      // worker (dropped, done) has nobody to be foreign to - the report is
      // recorded and shown as the last word.
      const where = current === null ? null : locate(current, report.sessionId);
      const foreign =
        current !== null && where?.present === null && !(!where.removed && hasUnnamedPresent(current));
      // Only a running Ticket moves (invariant 5). Anything else - dropped,
      // already in review, blocked - records what was said and stays.
      const moves = !foreign && current !== null && ticket.status === 'running';
      const status: TicketStatus = moves
        ? report.status === 'done'
          ? 'review'
          : 'needs_you'
        : ticket.status;
      const speaker = where?.present ?? null;
      const assignments =
        current !== null && speaker !== null
          ? withSessions(ticket, current, (sessions) =>
              sessions.map((s) => (s === speaker ? touched(s, input.at) : s)),
            )
          : ticket.assignments;
      return commit(
        ticket,
        input.at,
        { kind: 'agent', sessionId: report.sessionId },
        'reported',
        { report, applied: moves, ...(where?.removed === true ? { removedSession: true } : {}) },
        { status, assignments, lastReport: foreign ? ticket.lastReport : report },
      );
    }

    case 'turnEnded': {
      const { turnEnd } = input;
      if (hasSeenTurnEnd(ticket, turnEnd.turnId)) return accept(ticket);
      const current = currentAssignment(ticket);
      // Only a running Ticket has anything to correct, and the fact is not
      // recorded otherwise: in review / needs_you the person keeps chatting in
      // the session and every turn would fire one, filling the 200-event cap
      // (same rule as `personReplied`).
      if (ticket.status !== 'running' || current === null) return accept(ticket);
      // A removed session can still finish a turn; it must not move this
      // Ticket. A present session `init` has not named yet cannot rule the turn
      // out (same test as `reported`). With several present sessions a turn end
      // from any of them counts: the misfire when one session is still working
      // and the person asked another a question is accepted (design 3.3).
      const { present, removed } = locate(current, turnEnd.sessionId);
      const foreign = present === null && !(!removed && hasUnnamedPresent(current));
      if (foreign) return accept(ticket);
      const assignments = withSessions(ticket, current, (sessions) =>
        sessions.map((s) => (s === present ? touched(s, input.at) : s)),
      );
      // Deliberately leaves `lastReport` alone: the agent said nothing this
      // turn, and the card must not present the previous report as its answer.
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'turnEndedUnreported',
        { turnId: turnEnd.turnId, sessionId: turnEnd.sessionId },
        { status: 'review', assignments },
      );
    }

    case 'sessionExited': {
      const current = currentAssignment(ticket);
      if (current === null) return accept(ticket);
      const target = presentSessions(current).find((s) => sessionOwns(s, input));
      if (target === undefined) return accept(ticket);

      // The child never answered its handshake: that session is taken off the
      // Ticket. The Ticket needs the person only when no session is left that
      // ever got a session id (typically `start`'s first and only one).
      if (!input.requested && input.reason === 'unreachable') {
        const sessions = current.executor.sessions.map((s): WorkerSession =>
          s === target ? { ...s, removedAtMs: input.at, removed: 'unreachable' } : s,
        );
        const stillNamed = sessions.some((s) => s.removedAtMs === null && s.sessionId !== '');
        const moves = ticket.status === 'running' && !stillNamed;
        return commit(
          ticket,
          input.at,
          { kind: 'system' },
          'sessionExited',
          {
            assignmentId: current.id,
            sessionKey: target.sessionKey,
            requested: false,
            reason: 'unreachable',
            midTurn: input.midTurn,
            applied: moves,
          },
          {
            assignments: ticket.assignments.map((a) =>
              a === current ? { ...a, executor: { ...a.executor, sessions } } : a,
            ),
            ...(moves ? { status: 'needs_you' as const } : {}),
          },
        );
      }

      // Only a running Ticket moves (invariant 6), and only for an exit nobody
      // asked for that cut a turn short: an idle session that drops off (an
      // old tab, a closed window) is news for the list, not for the status.
      const moves = ticket.status === 'running' && !input.requested && input.midTurn;
      const data: Record<string, unknown> = {
        assignmentId: current.id,
        sessionId: target.sessionId,
        requested: input.requested,
        midTurn: input.midTurn,
        applied: moves,
      };
      if (!input.requested) data.reason = input.reason ?? 'crashed';
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'sessionExited',
        data,
        moves ? { status: 'needs_you' } : {},
      );
    }

    case 'sessionRestoreFailed': {
      const current = currentAssignment(ticket);
      if (current === null) {
        return commit(ticket, input.at, { kind: 'system' }, 'sessionRestoreFailed', { applied: false }, {});
      }
      const target = presentSessions(current).find((s) => sessionOwns(s, input.failed));
      // Takes the unreachable session off and adds its replacement in one step,
      // so the Ticket never has a moment with nobody on it. When nobody matches
      // (a review Ticket whose only session was already taken off as
      // `unreachable`) the replacement is still added: the person asked for
      // someone to answer. The status stays: a sendBack already made it
      // `running`, a blocked Ticket is still blocked.
      const assignments = withSessions(ticket, current, (sessions) => [
        ...sessions.map((s): WorkerSession =>
          s === target ? { ...s, removedAtMs: input.at, removed: 'restore_failed' } : s,
        ),
        newWorkerSession(input, input.at),
      ]);
      return commit(
        ticket,
        input.at,
        { kind: 'system' },
        'sessionRestoreFailed',
        {
          applied: true,
          failed: target === undefined ? '' : target.sessionId || target.sessionKey,
          sessionKey: input.sessionKey,
          assignmentId: current.id,
        },
        { assignments },
      );
    }

    case 'personReplied': {
      const current = currentAssignment(ticket);
      if (current === null || input.sessionId === '') return accept(ticket);
      const speaker = presentSessions(current).find((s) => s.sessionId === input.sessionId);
      // A removed or foreign session talking is not this Ticket's news.
      if (speaker === undefined) return accept(ticket);
      if (ticket.status !== 'needs_you') {
        // Not an event: this fires on every message (see the header). The
        // session's activity matters only for choosing *which* session "open"
        // and "send back" default to, so it is recorded only when this session
        // is not already that one - otherwise every message the person types
        // would rewrite the whole Ticket file for nothing.
        if (mostRecentSessionOf(current) === speaker) return accept(ticket);
        const bumped = withSessions(ticket, current, (sessions) =>
          sessions.map((s) => (s === speaker ? touched(s, Math.max(input.at, newestActivity(current) + 1)) : s)),
        );
        return accept({ ...ticket, assignments: bumped });
      }
      const assignments = withSessions(ticket, current, (sessions) =>
        sessions.map((s) => (s === speaker ? touched(s, input.at) : s)),
      );
      return commit(
        ticket,
        input.at,
        LOCAL_PERSON,
        'personReplied',
        { assignmentId: current.id, sessionId: input.sessionId },
        { status: 'running', assignments },
      );
    }

    default: {
      const unreachable: never = input;
      void unreachable;
      return refuse('unknown_input');
    }
  }
}
