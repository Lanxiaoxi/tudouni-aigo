/**
 * Schema 1 -> 2 (`docs/design/ticket-notes.md` §5): "an Assignment is a session"
 * becomes "an Assignment is a worker, and a worker has sessions".
 *
 * Pure, and done **in memory**: the caller backs the file up first and writes the
 * result back through the store's ordinary atomic write. A record that does not
 * come out as a valid schema-2 Ticket is dropped whole (and counted), the same
 * rule `parseTicketFile` follows - the backup is what keeps such a record from
 * being lost for good.
 *
 * The rule for cutting the old list into workers: **an `accepted` or `dropped`
 * Assignment ends a worker.** Everything before it since the previous ending is
 * one worker's sessions (`superseded` and `restore_failed` were exactly "the
 * executor was swapped for another session", which is now a session leaving its
 * worker), and what follows a `reopen` starts a new worker, so history keeps its
 * shape.
 */
import {
  TICKET_SCHEMA,
  isValidTicket,
  type Assignment,
  type SessionRemoval,
  type Ticket,
  type WorkerSession,
} from './model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A schema-1 Assignment, as far as migration needs to read it. */
interface OldAssignment {
  id: string;
  sessionKey: string;
  sessionId: string;
  remoteWorkspaceId: string | null;
  workspace?: string;
  startedAtMs: number;
  endedAtMs: number | null;
  end: 'superseded' | 'accepted' | 'dropped' | 'restore_failed' | null;
}

function readOld(value: unknown): OldAssignment | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null;
  const ex = value.executor;
  if (!isRecord(ex) || ex.kind !== 'session') return null;
  if (typeof ex.sessionKey !== 'string' || typeof ex.sessionId !== 'string') return null;
  if (ex.remoteWorkspaceId !== null && typeof ex.remoteWorkspaceId !== 'string') return null;
  if (ex.workspace !== undefined && typeof ex.workspace !== 'string') return null;
  if (typeof value.startedAtMs !== 'number') return null;
  if (value.endedAtMs !== null && typeof value.endedAtMs !== 'number') return null;
  const end = value.end;
  if (end !== null && end !== 'superseded' && end !== 'accepted' && end !== 'dropped' && end !== 'restore_failed') {
    return null;
  }
  return {
    id: value.id,
    sessionKey: ex.sessionKey,
    sessionId: ex.sessionId,
    remoteWorkspaceId: ex.remoteWorkspaceId as string | null,
    ...(ex.workspace !== undefined ? { workspace: ex.workspace } : {}),
    startedAtMs: value.startedAtMs,
    endedAtMs: value.endedAtMs as number | null,
    end,
  };
}

function sessionOf(old: OldAssignment): WorkerSession {
  // An Assignment that was replaced is a session that was moved off; one that
  // is still in flight, or whose worker was accepted / dropped, is on it.
  const removal: SessionRemoval | null =
    old.end === 'superseded' ? 'restart' : old.end === 'restore_failed' ? 'restore_failed' : null;
  return {
    sessionKey: old.sessionKey,
    sessionId: old.sessionId,
    remoteWorkspaceId: old.remoteWorkspaceId,
    ...(old.workspace !== undefined ? { workspace: old.workspace } : {}),
    joinedAtMs: old.startedAtMs,
    // The only activity schema 1 knew about.
    lastActiveAtMs: old.startedAtMs,
    removedAtMs: removal === null ? null : (old.endedAtMs ?? old.startedAtMs),
    ...(removal !== null ? { removed: removal } : {}),
  };
}

/** Cut the old Assignments into workers. `null` when one is malformed. */
export function migrateAssignments(list: unknown): Assignment[] | null {
  if (!Array.isArray(list)) return null;
  const olds: OldAssignment[] = [];
  for (const item of list) {
    const old = readOld(item);
    if (old === null) return null;
    olds.push(old);
  }
  const workers: Assignment[] = [];
  let segment: OldAssignment[] = [];
  const close = (): void => {
    if (segment.length === 0) return;
    const first = segment[0];
    const last = segment[segment.length - 1];
    // A worker ends with the person's decision; one that merely trails off with a
    // replaced session (nothing followed it) is a worker that was handed over.
    const end: Assignment['end'] =
      last.end === 'accepted' || last.end === 'dropped'
        ? last.end
        : last.end === null
          ? null
          : 'superseded';
    workers.push({
      id: first.id,
      executor: { kind: 'person', sessions: segment.map(sessionOf) },
      startedAtMs: first.startedAtMs,
      endedAtMs: end === null ? null : (last.endedAtMs ?? last.startedAtMs),
      end,
    });
    segment = [];
  };
  for (const old of olds) {
    segment.push(old);
    if (old.end === 'accepted' || old.end === 'dropped') close();
  }
  close();
  return workers;
}

/** One schema-1 record as a schema-2 Ticket, or `null` when it does not come out
 *  valid (the caller counts it as dropped). */
export function migrateTicketV1(value: unknown): Ticket | null {
  if (!isRecord(value) || value.schema !== 1) return null;
  const assignments = migrateAssignments(value.assignments);
  if (assignments === null) return null;
  const next = { ...value, schema: TICKET_SCHEMA, assignments, notes: [] };
  return isValidTicket(next) ? next : null;
}
