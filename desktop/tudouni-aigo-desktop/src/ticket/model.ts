/**
 * The Ticket entity: types, the id, the title rule, and the guard.
 *
 * A Ticket is a piece of work that outlives any session (`docs/design/ticket.md`).
 * Everything here is data and pure helpers; the only code that may change a
 * Ticket's `status` is `machine.ts`, and the only code that reads or writes the
 * file is `store.ts`.
 *
 * **The record outlives every build**, so `isValidTicket` drops a malformed
 * record whole instead of letting a field through as `undefined` — the same
 * rule `isValidTask` follows for a template.
 */
import type { TaskWorkspaceRef } from '@/task/tasks';

/** The file's schema number. Only ever grows; a file with a larger one was
 *  written by a newer build and is read-only here (`store.ts`). */
export const TICKET_SCHEMA = 1;

/** The first protocol that understands `ticket_bind` and `ui(ticket_report)`.
 *  A session whose `init.protocol` is lower is never sent a bind (design 5.4):
 *  an older runtime would drop it silently, and the person would believe there
 *  is a report channel when there is not. */
export const TICKET_MIN_PROTOCOL = 18;

/** How many events a Ticket keeps. The oldest go first, `created` never does. */
export const TICKET_EVENTS_MAX = 200;

export const TICKET_STATUSES = [
  'open',
  'running',
  'needs_you',
  'review',
  'done',
  'dropped',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type ReportStatus = 'done' | 'blocked';

/** One `ticket_report` call, as the runtime forwarded it. A fact about what an
 *  agent *said*; it is never the Ticket's state. */
export interface Report {
  /** Minted by the runtime. The key every duplicate is recognised by. */
  reportId: string;
  /** The session that made the call. */
  sessionId: string;
  status: ReportStatus;
  summary: string;
  /** The one concrete question a `blocked` report asks; `null` for `done`. */
  question: string | null;
  evidence: string[];
  atMs: number;
}

/** Who did a thing. Today a Ticket has one person and some sessions; the
 *  union is the shape a team needs, with one member in use (design §9). */
export type Actor =
  | { kind: 'person'; id: string }
  | { kind: 'agent'; sessionId: string }
  | { kind: 'system' };

/** The only requester today. Not a hard-coded check anywhere — a value. */
export const LOCAL_PERSON: Actor = { kind: 'person', id: 'local' };

/** Why an Assignment ended. Only these four: a report or an exit is an event,
 *  because the same Assignment carries on after either. */
export type AssignmentEnd = 'superseded' | 'accepted' | 'dropped' | 'restore_failed';

export interface Assignment {
  id: string;
  executor: {
    kind: 'session';
    /** The bridge's child key. Only meaningful within one app run: a resumed
     *  session gets a new key, which `assignmentStarted` writes back. */
    sessionKey: string;
    /** The runtime's session id, back-filled from `init`. Empty until then. */
    sessionId: string;
    /** Which saved remote workspace the session actually opened in, or `null`
     *  for a local one. Read off the opened bucket, never off the Ticket's ref
     *  (which may say `active`). */
    remoteWorkspaceId: string | null;
    /** Where the session ran: the local directory, or the path on the remote
     *  host. Optional (records written before it existed lack it). A later
     *  "continue" resumes a **local** session in this directory: the Ticket's
     *  own ref may say `active`, and the screen it started from is long gone. */
    workspace?: string;
  };
  startedAtMs: number;
  endedAtMs: number | null;
  /** `null` = still the Ticket's executor (live, closed, disconnected, or
   *  blocked — all of which are events, not endings). */
  end: AssignmentEnd | null;
}

/**
 * What the history records. Commands are imperative, facts past tense
 * (design §3). `assignmentRestoreFailed` is not in the design's list: it is the
 * fact the caller emits when a sendBack could not reopen the original session
 * (see `machine.ts`).
 */
export type TicketEventType =
  | 'created'
  | 'start'
  | 'assignmentStarted'
  | 'reported'
  | 'personReplied'
  | 'assignmentExited'
  | 'assignmentRestoreFailed'
  | 'accept'
  | 'sendBack'
  | 'drop'
  | 'reopen'
  | 'edited';

export interface TicketEvent {
  at: number;
  actor: Actor;
  type: TicketEventType;
  data?: Record<string, unknown>;
}

export interface Ticket {
  schema: 1;
  /** `tk-<time36>-<rand>`. Embeds nothing about this machine. */
  id: string;
  /** May be empty; `ticketTitle` falls back to the brief's first line. */
  title: string;
  /** The work, and the first message the session is given. */
  brief: string;
  workspace: TaskWorkspaceRef;
  /** Empty = whatever the workspace's current model is. */
  model: string;
  status: TicketStatus;
  /** Append-only. At most one has `end === null`. */
  assignments: Assignment[];
  /** Append-only, capped at `TICKET_EVENTS_MAX`. History, not a log to replay:
   *  the status next to it is a snapshot written in the same record. */
  events: TicketEvent[];
  /** The newest new report from the current Assignment's session, for the
   *  card. Set whatever the status was when it arrived (a report that could
   *  not move the status is still what the agent last said), but never from
   *  a session that is not the current executor. */
  lastReport: Report | null;
  createdAtMs: number;
  updatedAtMs: number;

  // The extension points of design §9: each has exactly one value today.
  origin: { kind: 'manual' };
  requester: Actor;
  mandate: { basis: 'manual' };
  delivery: { kind: 'local' };
}

/* ============================================================
   Id, title, blank
   ============================================================ */

/** A new id. The time prefix keeps ids roughly sortable; the random suffix
 *  keeps two made in one millisecond apart. */
export function newTicketId(nowMs: number = Date.now()): string {
  return `tk-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A new Assignment id. Minted by the caller and carried on the event, so the
 *  state machine stays a pure function of its inputs. */
export function newAssignmentId(nowMs: number = Date.now()): string {
  return `as-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The line a Ticket is listed under: its title when it has one, otherwise the
 * brief's first non-empty line, cut at 80 characters. The same rule `taskTitle`
 * applies to a todo — the description of the work *is* the Ticket, and asking
 * for a second title is friction at the moment somebody wanted to park it.
 */
export function ticketTitle(ticket: Pick<Ticket, 'title' | 'brief'>): string {
  const title = ticket.title.trim();
  if (title !== '') return title;
  const first = ticket.brief.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const line = first.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** A fresh, open Ticket with its `created` event. Nothing is inferred from the
 *  clock beyond `nowMs`, so a test can pin it. */
export function emptyTicket(nowMs: number): Ticket {
  return {
    schema: TICKET_SCHEMA,
    id: newTicketId(nowMs),
    title: '',
    brief: '',
    workspace: { kind: 'active' },
    model: '',
    status: 'open',
    assignments: [],
    events: [{ at: nowMs, actor: LOCAL_PERSON, type: 'created' }],
    lastReport: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    origin: { kind: 'manual' },
    requester: LOCAL_PERSON,
    mandate: { basis: 'manual' },
    delivery: { kind: 'local' },
  };
}

/* ============================================================
   The guard
   ============================================================ */

const EVENT_TYPES: ReadonlySet<string> = new Set<TicketEventType>([
  'created',
  'start',
  'assignmentStarted',
  'reported',
  'personReplied',
  'assignmentExited',
  'assignmentRestoreFailed',
  'accept',
  'sendBack',
  'drop',
  'reopen',
  'edited',
]);

const ASSIGNMENT_ENDS: ReadonlySet<string> = new Set<AssignmentEnd>([
  'superseded',
  'accepted',
  'dropped',
  'restore_failed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function isWorkspaceRef(value: unknown): value is TaskWorkspaceRef {
  if (!isRecord(value)) return false;
  if (value.kind === 'active') return true;
  if (value.kind === 'local') return isNonEmptyString(value.path);
  if (value.kind === 'remote') return isNonEmptyString(value.id);
  return false;
}

export function isValidActor(value: unknown): value is Actor {
  if (!isRecord(value)) return false;
  if (value.kind === 'person') return isNonEmptyString(value.id);
  if (value.kind === 'agent') return typeof value.sessionId === 'string';
  return value.kind === 'system';
}

export function isValidReport(value: unknown): value is Report {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.reportId) &&
    typeof value.sessionId === 'string' &&
    (value.status === 'done' || value.status === 'blocked') &&
    typeof value.summary === 'string' &&
    (value.question === null || typeof value.question === 'string') &&
    Array.isArray(value.evidence) &&
    value.evidence.every((item) => typeof item === 'string') &&
    typeof value.atMs === 'number'
  );
}

function isValidAssignment(value: unknown): value is Assignment {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  const ex = value.executor;
  if (!isRecord(ex) || ex.kind !== 'session') return false;
  if (typeof ex.sessionKey !== 'string' || typeof ex.sessionId !== 'string') return false;
  if (ex.remoteWorkspaceId !== null && typeof ex.remoteWorkspaceId !== 'string') return false;
  if (ex.workspace !== undefined && typeof ex.workspace !== 'string') return false;
  if (typeof value.startedAtMs !== 'number') return false;
  if (value.endedAtMs !== null && typeof value.endedAtMs !== 'number') return false;
  return value.end === null || (typeof value.end === 'string' && ASSIGNMENT_ENDS.has(value.end));
}

function isValidEvent(value: unknown): value is TicketEvent {
  if (!isRecord(value)) return false;
  if (typeof value.at !== 'number') return false;
  if (!isValidActor(value.actor)) return false;
  if (typeof value.type !== 'string' || !EVENT_TYPES.has(value.type)) return false;
  return value.data === undefined || isRecord(value.data);
}

/**
 * Guard one parsed record from `tickets.json` before it is trusted.
 *
 * Not checked on purpose: that `status` agrees with the assignments, or that
 * the events add up to the status. The status is a snapshot the machine wrote;
 * second-guessing it here would drop a Ticket somebody can still read for a
 * disagreement no one can repair. The one structural rule that *is* checked is
 * the headline invariant — at most one in-flight Assignment — because code that
 * calls `currentAssignment` assumes it.
 */
export function isValidTicket(value: unknown): value is Ticket {
  if (!isRecord(value)) return false;
  if (value.schema !== TICKET_SCHEMA) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (typeof value.title !== 'string' || typeof value.brief !== 'string') return false;
  if (!isWorkspaceRef(value.workspace)) return false;
  if (typeof value.model !== 'string') return false;
  if (!(TICKET_STATUSES as readonly string[]).includes(value.status as string)) return false;
  if (!Array.isArray(value.assignments) || !value.assignments.every(isValidAssignment)) return false;
  if (value.assignments.filter((a: Assignment) => a.end === null).length > 1) return false;
  if (!Array.isArray(value.events) || !value.events.every(isValidEvent)) return false;
  if (value.lastReport !== null && !isValidReport(value.lastReport)) return false;
  if (typeof value.createdAtMs !== 'number' || typeof value.updatedAtMs !== 'number') return false;
  if (!isRecord(value.origin) || value.origin.kind !== 'manual') return false;
  if (!isValidActor(value.requester)) return false;
  if (!isRecord(value.mandate) || value.mandate.basis !== 'manual') return false;
  return isRecord(value.delivery) && value.delivery.kind === 'local';
}
