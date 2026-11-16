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
export const TICKET_SCHEMA = 2;

/** The first protocol that understands `ticket_bind` and `ui(ticket_report)`.
 *  A session whose `init.protocol` is lower is never sent a bind (design 5.4):
 *  an older runtime would drop it silently, and the person would believe there
 *  is a report channel when there is not. */
export const TICKET_MIN_PROTOCOL = 18;

/** The first protocol whose `ticket_bind` carries `attachments`. An older
 *  runtime would ignore the key, so the paths travel in the first message
 *  instead (see `ticketRuns.ts`). */
export const TICKET_ATTACHMENTS_MIN_PROTOCOL = 19;

/** The first protocol whose `ticket_bind` carries `notes` and that has the
 *  `ticket_note` tool and `ui(ticket_note)`. An older runtime ignores the key, so
 *  it is never sent one; its sessions are marked on the card instead
 *  (`ticket-notes.md` 7). */
export const TICKET_NOTES_MIN_PROTOCOL = 22;

/** How many files one Ticket may carry. Mirrors the runtime's ceiling on
 *  `ticket_bind.ticket.attachments` and `MAX_ATTACHMENTS_PER_TICKET` in
 *  `src-tauri/src/ticket_attachments.rs`. */
export const TICKET_ATTACHMENTS_MAX = 50;

/** One file attached to a Ticket. The bytes live in
 *  `~/.tudouni/tickets/attachments/<ticketId>/<name>` (a copy taken when it was
 *  attached), so `name` is the only key a record needs. */
export interface TicketAttachment {
  name: string;
  bytes: number;
  addedAtMs: number;
}

/**
 * The name the full brief is staged under when it is too long for the runtime's
 * payload tail (`ticket-notes.md` 3.6). **Reserved**: a person's attachment
 * cannot take it, or the staged brief would overwrite their file. Mirrored by
 * `BRIEF_FILE` in `src-tauri/src/ticket_attachments.rs`.
 */
export const BRIEF_ATTACHMENT_NAME = 'brief.md';

/** Whether a name is the staged brief's. Case-insensitive, because the staging
 *  directory lives on file systems (Windows, macOS) where `Brief.md` and
 *  `brief.md` are one file. */
export function isReservedAttachmentName(name: string): boolean {
  return name.toLowerCase() === BRIEF_ATTACHMENT_NAME;
}

/** How much of the brief the runtime quotes in its payload tail, in characters.
 *  Mirrors `TicketTailBriefRunes` in `internal/state/ticket.go` (a test reads
 *  the Go source). A longer brief is cut there, so the desktop stages the whole
 *  of it as `brief.md`. Counted in code points, like the runtime's runes. */
export const TICKET_TAIL_BRIEF_RUNES = 2000;

/** Whether a brief is longer than the runtime's tail keeps. */
export function briefExceedsTail(brief: string): boolean {
  let n = 0;
  for (const _ of brief) {
    n += 1;
    if (n > TICKET_TAIL_BRIEF_RUNES) return true;
  }
  return false;
}

/** How many events a Ticket keeps. The oldest go first, `created` never does. */
export const TICKET_EVENTS_MAX = 200;

/**
 * The ceilings `ticket_bind` is validated against, mirrored from
 * `internal/state/ticket.go` (`TicketTitleCeiling` / `TicketBriefCeiling`).
 *
 * Mirrored rather than assumed, because the failure is silent in the worst
 * possible way: the runtime refuses the bind with a `warn` notice that lands in
 * the session's transcript, while the Ticket — whose status was written by
 * `start` before the bind was sent — goes on saying **Running** with no report
 * tool behind it. That is exactly the "do not imply a reporting channel that
 * does not exist" rule of design §5.4, broken by an oversized paste.
 *
 * So the desktop refuses to make an unbindable Ticket in the first place. The
 * numbers must be kept equal to the runtime's; a test asserts the two files
 * agree, since nothing at build time can (they are two languages).
 */
export const TICKET_TITLE_CEILING = 500;
export const TICKET_BRIEF_CEILING = 20000;

/**
 * The same rule for notes, mirrored from `internal/state/ticket.go`
 * (`TicketNoteTextCeiling` / `MaxTicketNotes` / `TicketNotesTotalCeiling`).
 *
 * Every note is quoted in full in the payload tail on every round, so the cost
 * is bounded at write time. A list over any of these makes the runtime refuse
 * the whole `ticket_bind` - the report tool included - which is why the machine
 * refuses the write that would cross one instead of storing it. Counted in code
 * points (the runtime counts runes). A test reads the Go source.
 */
export const TICKET_NOTE_TEXT_CEILING = 4000;
export const TICKET_NOTES_MAX = 100;
export const TICKET_NOTES_TOTAL_CEILING = 12000;

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

/** One turn the runtime saw end normally without a `ticket_report` call
 *  (`ui(ticket_turn_end)`, protocol 21). A fact about the agent *stopping*; it
 *  says nothing about whether the work is done. */
export interface TurnEnd {
  /** The turn's run id. The key every duplicate is recognised by. */
  turnId: string;
  /** The session whose turn ended. */
  sessionId: string;
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

/** Why an Assignment (a worker) ended. `superseded` is kept for "another worker
 *  took over", which no command produces today (only migrated schema-1 records
 *  carry it): swapping a *session* is the worker's own business now. A report or
 *  an exit is an event, because the same worker carries on after either. */
export type AssignmentEnd = 'superseded' | 'accepted' | 'dropped';

/** Why a session left its worker (`WorkerSession.removed`). */
export type SessionRemoval = 'restart' | 'person' | 'restore_failed' | 'unreachable';

/**
 * One conversation of a worker (`docs/design/ticket-notes.md` 3.1).
 *
 * Sessions are only ever appended; a removed one stays in the list so it can be
 * opened and read back, but it is unbound and the facts it sends no longer count.
 */
export interface WorkerSession {
  /** The bridge's child key. Only meaningful within one app run: a resumed
   *  session gets a new key, which `sessionStarted` writes back. */
  sessionKey: string;
  /** The runtime's session id, back-filled from `init`. Empty until then. */
  sessionId: string;
  /** Which saved remote workspace the session actually opened in, or `null`
   *  for a local one. Read off the opened bucket, never off the Ticket's ref
   *  (which may say `active`). */
  remoteWorkspaceId: string | null;
  /** Where the session ran: the local directory, or the path on the remote
   *  host. A later "continue" resumes a **local** session in this directory. */
  workspace?: string;
  /** The conversation's title, when the desktop knew it. For the list only. */
  title?: string;
  joinedAtMs: number;
  /** Decides which session "open" and "send back" default to (3.3). */
  lastActiveAtMs: number;
  /** `null` = on the Ticket. */
  removedAtMs: number | null;
  removed?: SessionRemoval;
}

export interface Assignment {
  id: string;
  executor: {
    /** Who drives the sessions. Only a person today; an agent worker would be
     *  a second member issuing the same commands. */
    kind: 'person';
    /** Append-only, in the order they joined. */
    sessions: WorkerSession[];
  };
  startedAtMs: number;
  endedAtMs: number | null;
  /** `null` = still the Ticket's worker (live, closed, disconnected, or
   *  blocked - all of which are events, not endings). */
  end: AssignmentEnd | null;
}

/** A person's or an agent's note on the Ticket (`ticket-notes.md` 4.1). */
export interface TicketNote {
  /** `nt-<time36>-<rand>`. */
  id: string;
  text: string;
  author: 'person' | 'agent';
  /** For `author: 'agent'`: which session wrote it. */
  sessionId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}
/** What a note write does. The agent's `ticket_note` and the person's card use
 *  the same three verbs. */
export type NoteOp = 'add' | 'update' | 'remove';

/** One `ticket_note` call, as the runtime forwarded it (`ui(ticket_note)`, or an
 *  entry of `init.ticket.note_ops`). A fact about what an agent *asked for*; the
 *  machine decides whether it changed anything. */
export interface NoteOpFact {
  /** Minted by the runtime. The key every duplicate is recognised by. */
  opId: string;
  op: NoteOp;
  noteId: string;
  /** `null` for `remove`. */
  text: string | null;
  /** The session that made the call. */
  sessionId: string;
  atMs: number;
}

/** A note's length the way the runtime counts it: code points, not UTF-16
 *  units, so an emoji is one and a note that fits there fits here. */
export function noteRunes(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** A new note id. Minted by the caller and carried on the command, so the
 *  machine stays a pure function. Same shape the runtime mints for the agent's. */
export function newNoteId(nowMs: number = Date.now()): string {
  return `nt-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Why a note's text cannot be stored. */
export type NoteProblem = 'empty_note' | 'note_too_long' | 'notes_full' | 'notes_total';

/**
 * Whether `text` can be written into `notes` - as a new note, or (with
 * `replacingId`) in place of that one - or the ceiling it would cross.
 *
 * One function for the machine (which refuses the write), the agent's fact
 * (which records that it did not fit) and the card (which says so while the
 * person types), for `unbindableField`'s reason: three callers that disagree
 * would let a note be typed that the machine then refuses. The text is judged
 * **trimmed**, because that is what is stored.
 */
export function noteWriteProblem(
  notes: readonly TicketNote[],
  text: string,
  replacingId?: string,
): NoteProblem | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty_note';
  const runes = noteRunes(trimmed);
  if (runes > TICKET_NOTE_TEXT_CEILING) return 'note_too_long';
  if (replacingId === undefined && notes.length >= TICKET_NOTES_MAX) return 'notes_full';
  let total = runes;
  for (const note of notes) {
    if (note.id !== replacingId) total += noteRunes(note.text);
  }
  return total > TICKET_NOTES_TOTAL_CEILING ? 'notes_total' : null;
}

/** The notes in the order the card (and the runtime's tail) lists them: oldest
 *  first. A stable sort, so notes written in one millisecond keep their order. */
export function notesByTime(notes: readonly TicketNote[]): TicketNote[] {
  return [...notes].sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/**
 * What the history records. Commands are imperative, facts past tense
 * (design §3). `assignmentRestoreFailed` is not in the design's list: it is the
 * fact the caller emits when a sendBack could not reopen the original session
 * (see `machine.ts`).
 */
export type TicketEventType =
  // The schema-1 names (`assignmentStarted`, `assignmentExited`,
  // `assignmentRestoreFailed`) stay readable: old events are history, never
  // replayed, and a migrated record still carries them.
  | 'created'
  | 'start'
  | 'assignmentStarted'
  | 'sessionStarted'
  | 'newSession'
  | 'restart'
  | 'removeSession'
  | 'reported'
  | 'turnEndedUnreported'
  | 'personReplied'
  | 'assignmentExited'
  | 'sessionExited'
  | 'assignmentRestoreFailed'
  | 'sessionRestoreFailed'
  | 'accept'
  | 'sendBack'
  | 'drop'
  | 'reopen'
  | 'edited'
  // A person's note command / an agent's note fact. Only `{noteId, op}` (and the
  // fact's `opId`) are recorded, never the text: the history is capped by count.
  | 'note'
  | 'noted';

export interface TicketEvent {
  at: number;
  actor: Actor;
  type: TicketEventType;
  data?: Record<string, unknown>;
}

export interface Ticket {
  schema: 2;
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
  /** Shared judgements and decisions; they outlive any worker. Empty until the
   *  Notes feature lands (docs/design/ticket-notes.md 4). */
  notes: TicketNote[];
  /**
   * Files the person attached (a log, a dump, a spec). **Optional, not a schema
   * bump**: a record from before the field existed has none, and an older build
   * reading a newer record keeps the key untouched because the store writes
   * records back whole. Bumping `TICKET_SCHEMA` would have made every older
   * build's file read-only for one optional list.
   */
  attachments?: TicketAttachment[];
  createdAtMs: number;
  updatedAtMs: number;

  // The extension points of design §9: each has one value in use today.
  //
  // `origin` gained its second member with the inbox (`docs/design/ticket.md`
  // §9): a Ticket nobody typed into a form arrived as a file. Everything else
  // still has exactly one value, and `isValidTicket` accepts only the members
  // this build knows.
  origin: TicketOrigin;
  requester: Actor;
  mandate: { basis: 'manual' };
  delivery: { kind: 'local' };
}

/** Where a Ticket came from. */
export type TicketOrigin =
  /** A person wrote it in the New Ticket dialog. */
  | { kind: 'manual' }
  /**
   * A file an outside program dropped in `~/.tudouni/tickets/inbox/`.
   *
   * `source` and `thread` are the **idempotence key**: re-dropping the same
   * issue must yield one Ticket, not one per scan. `file` is kept so a person
   * can find the original under `processed/` afterwards.
   */
  | { kind: 'source'; source: string; thread: string; file: string; url?: string };

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
    notes: [],
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    origin: { kind: 'manual' },
    requester: LOCAL_PERSON,
    mandate: { basis: 'manual' },
    delivery: { kind: 'local' },
  };
}

/* ============================================================
   What a bind can carry
   ============================================================ */

/** A field of a Ticket that would make `ticket_bind` be refused, or `null`.
 *
 *  Three callers ask with slightly different fields, and they all have to agree:
 *  the form (so the box says so while the person types), `createTicket` /
 *  `updateTicketDraft` (so nothing is ever stored), and nothing else — `start`
 *  does not re-check, because a Ticket that passed at creation cannot have
 *  grown. Keeping it one function is what stops the three drifting.
 *
 *  Only the fields the **bind** carries are checked: the id is minted here and
 *  is short by construction, and `model` / `workspace` are not sent at all. */
export function unbindableField(ticket: Pick<Ticket, 'title' | 'brief'>): 'title' | 'brief' | null {
  if (ticket.title.length > TICKET_TITLE_CEILING) return 'title';
  if (ticket.brief.length > TICKET_BRIEF_CEILING) return 'brief';
  return null;
}

/* ============================================================
   The guard
   ============================================================ */

const EVENT_TYPES: ReadonlySet<string> = new Set<TicketEventType>([
  'created',
  'start',
  'assignmentStarted',
  'sessionStarted',
  'newSession',
  'restart',
  'removeSession',
  'reported',
  'turnEndedUnreported',
  'personReplied',
  'assignmentExited',
  'sessionExited',
  'assignmentRestoreFailed',
  'sessionRestoreFailed',
  'accept',
  'sendBack',
  'drop',
  'reopen',
  'edited',
  'note',
  'noted',
]);

const ASSIGNMENT_ENDS: ReadonlySet<string> = new Set<AssignmentEnd>(['superseded', 'accepted', 'dropped']);

const SESSION_REMOVALS: ReadonlySet<string> = new Set<SessionRemoval>([
  'restart',
  'person',
  'restore_failed',
  'unreachable',
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

/** Whether `value` is an origin this build knows. An unknown kind is a record
 *  written by a newer build, which the guard drops whole. */
export function isValidOrigin(value: unknown): value is TicketOrigin {
  if (!isRecord(value)) return false;
  if (value.kind === 'manual') return true;
  if (value.kind !== 'source') return false;
  return (
    isNonEmptyString(value.source) &&
    isNonEmptyString(value.thread) &&
    typeof value.file === 'string' &&
    // Optional: records from before the field existed have none.
    (value.url === undefined || typeof value.url === 'string')
  );
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

/** The attachments of a Ticket, empty for a record that has none. */
export function attachmentsOf(ticket: Pick<Ticket, 'attachments'>): TicketAttachment[] {
  return ticket.attachments ?? [];
}

/** One attachment name as the Rust door accepts it: one path component. */
export function isAttachmentName(name: string): boolean {
  return (
    name !== '' &&
    // Reserved for the staged brief (`BRIEF_ATTACHMENT_NAME`). Not part of the
    // guard (`isValidAttachment` accepts it so a record is never dropped for it);
    // the picker and the machine's `edit` refuse a new one.
    name.length <= 255 &&
    !/[/\\\0]/.test(name) &&
    !name.startsWith('.')
  );
}

export function isValidAttachment(value: unknown): value is TicketAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    isAttachmentName(value.name) &&
    typeof value.bytes === 'number' &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.addedAtMs === 'number'
  );
}

export function isValidWorkerSession(value: unknown): value is WorkerSession {
  if (!isRecord(value)) return false;
  if (typeof value.sessionKey !== 'string' || typeof value.sessionId !== 'string') return false;
  if (value.remoteWorkspaceId !== null && typeof value.remoteWorkspaceId !== 'string') return false;
  if (value.workspace !== undefined && typeof value.workspace !== 'string') return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (typeof value.joinedAtMs !== 'number' || typeof value.lastActiveAtMs !== 'number') return false;
  if (value.removedAtMs !== null && typeof value.removedAtMs !== 'number') return false;
  // A removed session says why; an unknown reason is a newer build's record.
  if (value.removed !== undefined && !(typeof value.removed === 'string' && SESSION_REMOVALS.has(value.removed))) {
    return false;
  }
  return true;
}

function isValidNote(value: unknown): value is TicketNote {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    typeof value.text === 'string' &&
    (value.author === 'person' || value.author === 'agent') &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    typeof value.createdAtMs === 'number' &&
    typeof value.updatedAtMs === 'number'
  );
}

function isValidAssignment(value: unknown): value is Assignment {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.id)) return false;
  const ex = value.executor;
  if (!isRecord(ex) || ex.kind !== 'person') return false;
  if (!Array.isArray(ex.sessions) || !ex.sessions.every(isValidWorkerSession)) return false;
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
  if (!Array.isArray(value.notes) || !value.notes.every(isValidNote)) return false;
  if (
    value.attachments !== undefined &&
    !(
      Array.isArray(value.attachments) &&
      value.attachments.length <= TICKET_ATTACHMENTS_MAX &&
      value.attachments.every(isValidAttachment)
    )
  ) {
    return false;
  }
  if (typeof value.createdAtMs !== 'number' || typeof value.updatedAtMs !== 'number') return false;
  if (!isRecord(value.origin) || !isValidOrigin(value.origin)) return false;
  if (!isValidActor(value.requester)) return false;
  if (!isRecord(value.mandate) || value.mandate.basis !== 'manual') return false;
  return isRecord(value.delivery) && value.delivery.kind === 'local';
}
