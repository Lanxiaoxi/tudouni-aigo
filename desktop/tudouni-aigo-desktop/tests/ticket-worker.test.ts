/**
 * The Worker model (schema 2, `docs/design/ticket-notes.md` 3, 5): several
 * sessions on one Ticket, the rules that say which of them count, the migration
 * from schema 1, and the guards that keep an older build from writing over it.
 *
 * `ticket-baseline.test.ts` pins what did *not* change; this file pins what did.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  apply,
  bindingIsStale,
  currentAssignment,
  isPresentSession,
  mostRecentSession,
  presentSessions,
  type TicketInput,
} from '@/ticket/machine';
import {
  TICKET_TAIL_BRIEF_RUNES,
  briefExceedsTail,
  emptyTicket,
  isReservedAttachmentName,
  isValidTicket,
  type Report,
  type Ticket,
} from '@/ticket/model';
import { migrateTicketV1 } from '@/ticket/migrate';
import { parseTicketFile, serializeTickets } from '@/ticket/store';
import { asksSendBackTarget, canRemoveSession, showsSessionList } from '@/ticket/view';

let clock = 100_000;
const tick = (): number => (clock += 10);

function ok(ticket: Ticket, input: TicketInput): Ticket {
  const result = apply(ticket, input);
  assert.equal(result.ok, true, `expected ${input.type} to be accepted: ${JSON.stringify(result)}`);
  return (result as { ok: true; ticket: Ticket }).ticket;
}
function refused(ticket: Ticket, input: TicketInput): string {
  const result = apply(ticket, input);
  assert.equal(result.ok, false, `expected ${input.type} to be refused`);
  return (result as { ok: false; reason: string }).reason;
}

const fields = (n: number) => ({ sessionKey: `k${n}`, remoteWorkspaceId: null });
const named = (t: Ticket, key: string, id: string): Ticket =>
  ok(t, { type: 'sessionStarted', at: tick(), sessionKey: key, sessionId: id });

/** Running, with session S1 on it. */
function running(): Ticket {
  const t = ok({ ...emptyTicket(1_000), brief: 'do it' }, { type: 'start', at: tick(), assignmentId: 'as-1', ...fields(1) });
  return named(t, 'k1', 'S1');
}
/** Running with S1 and S2 on it. */
function two(): Ticket {
  return named(ok(running(), { type: 'newSession', at: tick(), ...fields(2) }), 'k2', 'S2');
}
const report = (id: string, status: 'done' | 'blocked', sessionId: string): Report => ({
  reportId: id,
  sessionId,
  status,
  summary: 's',
  question: status === 'blocked' ? 'q?' : null,
  evidence: [],
  atMs: tick(),
});
const reported = (r: Report): TicketInput => ({ type: 'reported', at: r.atMs, report: r });
const ids = (t: Ticket): string[] => presentSessions(currentAssignment(t)).map((s) => s.sessionId);
const exited = (id: string, o: { requested?: boolean; midTurn: boolean; reason?: 'crashed' | 'disconnected' | 'unreachable' }): TicketInput => ({
  type: 'sessionExited',
  at: tick(),
  sessionKey: '',
  sessionId: id,
  requested: o.requested ?? false,
  midTurn: o.midTurn,
  ...(o.reason !== undefined ? { reason: o.reason } : {}),
});

/* ============================================================
   newSession / restart / removeSession
   ============================================================ */

test('newSession adds a session to the same worker and keeps the old one on the Ticket', () => {
  const t = two();
  assert.equal(t.assignments.length, 1);
  assert.deepEqual(ids(t), ['S1', 'S2']);
  assert.equal(t.status, 'running');
  assert.equal(t.events.at(-2)?.type, 'newSession');
});

test('newSession works from running, needs_you and review, and review goes back to running', () => {
  const blocked = ok(running(), reported(report('r1', 'blocked', 'S1')));
  assert.equal(ok(blocked, { type: 'newSession', at: tick(), ...fields(2) }).status, 'running');
  const review = ok(running(), reported(report('r2', 'done', 'S1')));
  assert.equal(review.status, 'review');
  const again = ok(review, { type: 'newSession', at: tick(), ...fields(2) });
  assert.equal(again.status, 'running', 'opening a session on it is "carry on"');
  assert.equal(again.assignments.length, 1);
});

test('newSession is refused when nobody is working on the Ticket', () => {
  const open = { ...emptyTicket(1), brief: 'b' };
  assert.equal(refused(open, { type: 'newSession', at: tick(), ...fields(2) }), 'wrong_status');
  const done = ok(ok(running(), reported(report('r', 'done', 'S1'))), { type: 'accept', at: tick() });
  assert.equal(refused(done, { type: 'newSession', at: tick(), ...fields(2) }), 'wrong_status');
});

test('restart takes every other present session off and adds one', () => {
  const blocked = ok(two(), reported(report('rb', 'blocked', 'S2')));
  assert.equal(blocked.status, 'needs_you');
  const t = ok(blocked, { type: 'restart', at: tick(), ...fields(3) });
  const sessions = currentAssignment(t)?.executor.sessions ?? [];
  assert.deepEqual(sessions.map((s) => s.removed), ['restart', 'restart', undefined]);
  assert.equal(t.status, 'running');
  assert.equal(bindingIsStale(named(t, 'k3', 'S3'), 'S1'), true);
});

test('removeSession takes one off, and the last one is refused', () => {
  const t = ok(two(), { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  assert.deepEqual(ids(t), ['S2']);
  const s1 = currentAssignment(t)?.executor.sessions[0];
  assert.equal(s1?.removed, 'person');
  assert.notEqual(s1?.removedAtMs, null);
  assert.equal(refused(t, { type: 'removeSession', at: tick(), sessionKey: 'k2', sessionId: 'S2' }), 'last_session');
  assert.equal(refused(t, { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' }), 'unknown_session');
  assert.equal(refused(running(), { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' }), 'last_session');
});

test('removeSession is refused outside the three live states', () => {
  const done = ok(ok(two(), reported(report('r', 'done', 'S1'))), { type: 'accept', at: tick() });
  assert.equal(refused(done, { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' }), 'wrong_status');
});

test('accept and drop end the worker with all its sessions; reopen starts a new worker', () => {
  const t = ok(ok(two(), reported(report('r', 'done', 'S2'))), { type: 'accept', at: tick() });
  assert.equal(currentAssignment(t), null);
  assert.equal(t.assignments[0].end, 'accepted');
  assert.equal(bindingIsStale(t, 'S1'), true);
  assert.equal(bindingIsStale(t, 'S2'), true);
  const again = ok(ok(t, { type: 'reopen', at: tick() }), { type: 'start', at: tick(), assignmentId: 'as-2', ...fields(9) });
  assert.equal(again.assignments.length, 2, 'a new worker; the old one stays as history');
});

/* ============================================================
   Facts across several sessions
   ============================================================ */

test('a report from any present session counts, and lastReport is its report', () => {
  const t = ok(two(), reported(report('r', 'done', 'S1')));
  assert.equal(t.status, 'review');
  const u = ok(two(), reported(report('r', 'blocked', 'S2')));
  assert.equal(u.status, 'needs_you');
  assert.equal(u.lastReport?.sessionId, 'S2');
});

test('a removed session\u2019s report is recorded, and moves nothing nor becomes lastReport', () => {
  const t = ok(two(), { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  const late = ok(t, reported(report('r-removed', 'done', 'S1')));
  assert.equal(late.status, 'running');
  assert.equal(late.lastReport, null);
  assert.equal(late.events.at(-1)?.type, 'reported');
  assert.equal(late.events.at(-1)?.data?.applied, false);
});

test('turnEnded from any present session moves running to review; from a removed one it does not', () => {
  const te = (turnId: string, sessionId: string): TicketInput => ({
    type: 'turnEnded',
    at: tick(),
    turnEnd: { turnId, sessionId, atMs: tick() },
  });
  assert.equal(ok(two(), te('t1', 'S2')).status, 'review');
  const removed = ok(two(), { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  const t = removed;
  assert.equal(ok(t, te('t2', 'S1')), t, 'a removed session stopping is not news');
});

test('personReplied in any present session moves needs_you to running; a removed one does not', () => {
  const blocked = ok(two(), reported(report('rb', 'blocked', 'S1')));
  assert.equal(ok(blocked, { type: 'personReplied', at: tick(), sessionId: 'S2' }).status, 'running');
  const removed = ok(blocked, { type: 'removeSession', at: tick(), sessionKey: 'k2', sessionId: 'S2' });
  assert.equal(ok(removed, { type: 'personReplied', at: tick(), sessionId: 'S2' }), removed);
});

test('lastActiveAtMs follows reports, replies and sendBack, and picks the default session', () => {
  let t = two();
  assert.equal(mostRecentSession(t)?.sessionId, 'S2');
  t = ok(t, reported(report('r1', 'blocked', 'S1')));
  assert.equal(mostRecentSession(t)?.sessionId, 'S1', 'the one that last spoke');
  t = ok(t, { type: 'personReplied', at: tick(), sessionId: 'S2' });
  assert.equal(mostRecentSession(t)?.sessionId, 'S2');
});

test('sessionStarted back-fills the matching session and ignores the removed or unknown', () => {
  let t = ok(running(), { type: 'newSession', at: tick(), ...fields(2) });
  assert.deepEqual(ids(t), ['S1', ''], 'the second is on the Ticket but not named yet');
  t = named(t, 'k2', 'S2');
  assert.deepEqual(ids(t), ['S1', 'S2']);
  const same = ok(t, { type: 'sessionStarted', at: tick(), sessionKey: 'k2', sessionId: 'S2' });
  assert.equal(same, t, 'a repeat is a no-op');
  const removed = ok(t, { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  assert.equal(ok(removed, { type: 'sessionStarted', at: tick(), sessionKey: 'k9', sessionId: 'S1' }), removed);
});

test('sendBack goes to a chosen present session, and defaults to the most recent', () => {
  const review = ok(two(), reported(report('r', 'done', 'S1')));
  const dflt = ok(review, { type: 'sendBack', at: tick(), feedback: 'again' });
  assert.equal(dflt.events.at(-1)?.data?.sessionId, 'S1', 'S1 reported last');
  const chosen = ok(review, { type: 'sendBack', at: tick(), feedback: 'again', sessionId: 'S2' });
  assert.equal(chosen.events.at(-1)?.data?.sessionId, 'S2');
  assert.equal(mostRecentSession(chosen)?.sessionId, 'S2');
  assert.equal(refused(review, { type: 'sendBack', at: tick(), feedback: 'x', sessionId: 'S-none' }), 'unknown_session');
});

/* ============================================================
   Exits (3.4)
   ============================================================ */

test('an unrequested exit moves a running Ticket only when it cut a turn short', () => {
  const mid = ok(two(), exited('S1', { midTurn: true, reason: 'crashed' }));
  assert.equal(mid.status, 'needs_you');
  const idle = ok(two(), exited('S1', { midTurn: false, reason: 'disconnected' }));
  assert.equal(idle.status, 'running', 'an idle session dropping off is only an event');
  assert.equal(idle.events.at(-1)?.type, 'sessionExited');
  assert.equal(idle.events.at(-1)?.data?.applied, false);
  assert.equal(ok(two(), exited('S1', { midTurn: true, requested: true })).status, 'running');
});

test('unreachable removes that session; the Ticket waits only when no named session is left', () => {
  // The first and only session never answered.
  const started = ok({ ...emptyTicket(1), brief: 'b' }, { type: 'start', at: tick(), assignmentId: 'as-1', ...fields(1) });
  const stuck = ok(started, { type: 'sessionExited', at: tick(), sessionKey: 'k1', sessionId: '', requested: false, midTurn: false, reason: 'unreachable' });
  assert.equal(stuck.status, 'needs_you');
  assert.equal(currentAssignment(stuck)?.executor.sessions[0].removed, 'unreachable');
  // A second session that never answered, with a named one still on the Ticket.
  const second = ok(running(), { type: 'newSession', at: tick(), ...fields(2) });
  const fine = ok(second, { type: 'sessionExited', at: tick(), sessionKey: 'k2', sessionId: '', requested: false, midTurn: false, reason: 'unreachable' });
  assert.equal(fine.status, 'running');
  assert.deepEqual(ids(fine), ['S1']);
});

test('sessionRestoreFailed removes the target, adds a replacement, and keeps the status', () => {
  const review = ok(two(), reported(report('r', 'done', 'S1')));
  const sent = ok(review, { type: 'sendBack', at: tick(), feedback: 'f', sessionId: 'S1' });
  const t = ok(sent, {
    type: 'sessionRestoreFailed',
    at: tick(),
    failed: { sessionKey: 'k1', sessionId: 'S1' },
    ...fields(3),
  });
  assert.equal(t.status, 'running');
  const sessions = currentAssignment(t)?.executor.sessions ?? [];
  assert.equal(sessions[0].removed, 'restore_failed');
  assert.equal(sessions.length, 3);
  assert.equal(isPresentSession(t, 'S2'), true);
});

/* ============================================================
   Bindings and the card
   ============================================================ */

test('an old session of the same worker is not stale: opening it does not kick it off', () => {
  const t = two();
  assert.equal(bindingIsStale(t, 'S1'), false);
  assert.equal(bindingIsStale(t, 'S2'), false);
  assert.equal(bindingIsStale(ok(t, { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' }), 'S1'), true);
});

test('the card shows the sessions section, the target picker and remove only when they mean something', () => {
  const one = currentAssignment(running());
  assert.equal(showsSessionList(one), false);
  assert.equal(asksSendBackTarget(one), false);
  assert.equal(canRemoveSession(one, one!.executor.sessions[0]), false, 'the last session cannot be removed');
  const t = two();
  const a = currentAssignment(t);
  assert.equal(showsSessionList(a), true);
  assert.equal(asksSendBackTarget(a), true);
  assert.equal(canRemoveSession(a, a!.executor.sessions[0]), true);
  const after = currentAssignment(ok(t, { type: 'removeSession', at: tick(), sessionKey: 'k1', sessionId: 'S1' }));
  assert.equal(showsSessionList(after), true, 'the removed one stays listed');
  assert.equal(asksSendBackTarget(after), false);
  assert.equal(canRemoveSession(after, after!.executor.sessions[0]), false);
});

/* ============================================================
   The record and the guard
   ============================================================ */

test('the guard needs notes and the worker shape, and accepts a record with notes', () => {
  const good = two();
  assert.equal(isValidTicket(good), true);
  assert.deepEqual(good.notes, []);
  const note = { id: 'nt-1', text: 'x', author: 'person' as const, createdAtMs: 1, updatedAtMs: 1 };
  assert.equal(isValidTicket({ ...good, notes: [note] }), true);
  assert.equal(isValidTicket({ ...good, notes: [{ ...note, author: 'robot' }] }), false);
});

test('brief.md is reserved, the tail ceiling mirrors the Go source, and a long brief is detected', () => {
  assert.equal(isReservedAttachmentName('brief.md'), true);
  assert.equal(isReservedAttachmentName('Brief.MD'), true);
  assert.equal(isReservedAttachmentName('brief.txt'), false);
  const source = readFileSync(resolve(process.cwd(), '..', '..', 'internal', 'state', 'ticket.go'), 'utf8');
  const match = source.match(/TicketTailBriefRunes\s*=\s*(\d+)/);
  assert.ok(match, 'TicketTailBriefRunes is declared in internal/state/ticket.go');
  assert.equal(TICKET_TAIL_BRIEF_RUNES, Number(match[1]));
  assert.equal(briefExceedsTail('x'.repeat(TICKET_TAIL_BRIEF_RUNES)), false);
  assert.equal(briefExceedsTail('x'.repeat(TICKET_TAIL_BRIEF_RUNES + 1)), true);
  // Counted in code points, like the runtime's runes: astral characters are one.
  assert.equal(briefExceedsTail('\u{1F600}'.repeat(TICKET_TAIL_BRIEF_RUNES)), false);
  const t = { ...running() };
  const refusal = apply(t, {
    type: 'edit',
    at: tick(),
    patch: { attachments: [{ name: 'brief.md', bytes: 1, addedAtMs: 1 }] },
  });
  assert.equal(refusal.ok, false);
});

/* ============================================================
   Migration, schema 1 -> 2
   ============================================================ */

type OldA = {
  id: string;
  key: string;
  sid: string;
  start: number;
  end: 'superseded' | 'accepted' | 'dropped' | 'restore_failed' | null;
  endedAt?: number;
};
const oldAssignment = (a: OldA) => ({
  id: a.id,
  executor: { kind: 'session', sessionKey: a.key, sessionId: a.sid, remoteWorkspaceId: null, workspace: 'C:/w' },
  startedAtMs: a.start,
  endedAtMs: a.end === null ? null : (a.endedAt ?? a.start + 5),
  end: a.end,
});
function oldTicket(assignments: OldA[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = emptyTicket(1_000) as unknown as Record<string, unknown>;
  const { notes: _drop, ...rest } = base;
  void _drop;
  return { ...rest, schema: 1, brief: 'b', status: 'running', assignments: assignments.map(oldAssignment), ...extra };
}

test('migration cuts the old Assignments at accepted/dropped, and turns replaced ones into removed sessions', () => {
  const migrated = migrateTicketV1(
    oldTicket([
      { id: 'a1', key: 'k1', sid: 'S1', start: 10, end: 'superseded' },
      { id: 'a2', key: 'k2', sid: 'S2', start: 20, end: 'restore_failed' },
      { id: 'a3', key: 'k3', sid: 'S3', start: 30, end: 'accepted' },
      // Reopened, then a second round:
      { id: 'a4', key: 'k4', sid: 'S4', start: 40, end: 'dropped' },
      { id: 'a5', key: 'k5', sid: 'S5', start: 50, end: null },
    ]),
  );
  assert.ok(migrated);
  assert.equal(migrated.schema, 2);
  assert.deepEqual(migrated.notes, []);
  assert.equal(migrated.assignments.length, 3, 'accepted and dropped each end a worker');
  const [w1, w2, w3] = migrated.assignments;
  assert.equal(w1.end, 'accepted');
  assert.deepEqual(
    w1.executor.sessions.map((s) => [s.sessionId, s.removed ?? null, s.removedAtMs === null]),
    [
      ['S1', 'restart', false],
      ['S2', 'restore_failed', false],
      ['S3', null, true],
    ],
  );
  assert.equal(w2.end, 'dropped');
  assert.equal(w3.end, null);
  assert.deepEqual(w3.executor.sessions.map((s) => s.sessionId), ['S5']);
  assert.equal(w3.executor.sessions[0].removedAtMs, null, 'the in-flight one is on the Ticket');
  assert.equal(w3.executor.sessions[0].lastActiveAtMs, 50, 'lastActiveAtMs is the old startedAtMs');
  assert.equal(w3.executor.sessions[0].joinedAtMs, 50);
  assert.equal(w3.executor.sessions[0].workspace, 'C:/w');
  assert.equal(isValidTicket(migrated), true);
});

test('migration of a Ticket with no assignments, and of a malformed one', () => {
  const none = migrateTicketV1(oldTicket([], { status: 'open' }));
  assert.ok(none);
  assert.deepEqual(none.assignments, []);
  assert.equal(migrateTicketV1(oldTicket([], { assignments: [{ id: 'x' }] })), null);
  assert.equal(migrateTicketV1({ ...oldTicket([]), schema: 2 }), null, 'only schema 1 is migrated');
});

test('a schema-1 file loads migrated, is writable, and says it was migrated; the events stay readable', () => {
  const rec = oldTicket([{ id: 'a1', key: 'k1', sid: 'S1', start: 10, end: null }], {
    events: [
      { at: 1, actor: { kind: 'system' }, type: 'created' },
      { at: 2, actor: { kind: 'system' }, type: 'assignmentStarted', data: { sessionId: 'S1' } },
      { at: 3, actor: { kind: 'system' }, type: 'assignmentExited', data: { requested: true } },
    ],
  });
  const loaded = parseTicketFile(JSON.stringify({ schema: 1, tickets: [rec, { id: 'junk' }] }));
  assert.equal(loaded.migratedFrom, 1);
  assert.equal(loaded.readOnly, false);
  assert.equal(loaded.tickets.length, 1);
  assert.equal(loaded.dropped, 1);
  assert.equal(loaded.tickets[0].events[1].type, 'assignmentStarted');
  assert.equal(JSON.parse(serializeTickets(loaded.tickets)).schema, 2);
});

test('a file or a record newer than this build is read-only, so a filtered list is never written back', () => {
  const good = running();
  // File-level.
  assert.equal(parseTicketFile(JSON.stringify({ schema: 3, tickets: [good] })).readOnly, true);
  // Record-level: a header that lags behind its records must not make the store
  // writable, or the record this build cannot read would be dropped on the next save.
  const lagging = parseTicketFile(JSON.stringify({ schema: 2, tickets: [good, { ...good, id: 'tk-new', schema: 3 }] }));
  assert.equal(lagging.readOnly, true);
  assert.equal(lagging.tickets.length, 1);
  assert.equal(lagging.dropped, 1);
  // A current file with a bad record is still writable (the bad one is just lost).
  assert.equal(parseTicketFile(JSON.stringify({ schema: 2, tickets: [good, { id: 'junk' }] })).readOnly, false);
});
