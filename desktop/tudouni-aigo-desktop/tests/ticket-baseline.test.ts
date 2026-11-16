/**
 * Behaviour the Ticket Worker redesign must **not** change
 * (`docs/design/ticket-notes.md` §6, "照原样保留").
 *
 * Written before the model changed, and kept passing after it. Everything here
 * goes through `apply` and the handful of helpers below; the helpers are the
 * **only** place that knows how a session is spelled, so the schema-2 move
 * (Assignment -> worker -> sessions) touches them and nothing else in this file.
 * That is the whole point of the suite: a rule that only "still passes" because
 * its assertion was rewritten alongside the model is not pinned at all.
 *
 * What is deliberately not here: the rules the redesign changes on purpose
 * (a plain "new session" keeps the old one working; an idle session's
 * disconnect no longer moves a Ticket). Those live in `ticket-worker.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, bindingIsStale, currentAssignment, isBindable, mostRecentSession, type TicketInput } from '@/ticket/machine';
import {
  TICKET_EVENTS_MAX,
  emptyTicket,
  isValidTicket,
  type Report,
  type Ticket,
  type TicketStatus,
  type TurnEnd,
} from '@/ticket/model';

/* ============================================================
   The helper layer: the only code that spells a session
   ============================================================ */

const T0 = 10_000;
let clock = T0;
const tick = (): number => (clock += 10);

/** The session id of the executor the card would open. */
function sessionIdOf(t: Ticket): string {
  return mostRecentSession(t)?.sessionId ?? '';
}
/** The key of that session. */
function sessionKeyOf(t: Ticket): string {
  return mostRecentSession(t)?.sessionKey ?? '';
}

function startCmd(n = 1, key = `k${n}`): TicketInput {
  return { type: 'start', at: tick(), assignmentId: `as-${n}`, sessionKey: key, remoteWorkspaceId: null };
}
/** `init` named a session. */
function startedFact(sessionKey: string, sessionId: string): TicketInput {
  return { type: 'sessionStarted', at: tick(), sessionKey, sessionId };
}
/** A child ended. `midTurn` is true: the schema-1 rule moved a running Ticket on
 *  any unrequested exit, and "it was in the middle of a turn" is the case where
 *  the worker rule says the same thing. */
function exitedFact(opts: {
  key?: string;
  id?: string;
  requested: boolean;
  reason?: 'crashed' | 'disconnected' | 'unreachable';
}): TicketInput {
  return {
    type: 'sessionExited',
    midTurn: true,
    at: tick(),
    requested: opts.requested,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    sessionKey: opts.key ?? 'k1',
    sessionId: opts.id ?? 'S1',
  } as TicketInput;
}
/** "Start over" on a blocked Ticket: a fresh session, the old one no longer the
 *  Ticket's. */
function restartCmd(_n: number, key: string): TicketInput {
  return { type: 'restart', at: tick(), sessionKey: key, remoteWorkspaceId: null };
}
/** The original session could not be reopened; a replacement takes over. */
function restoreFailedFact(_n: number, key: string): TicketInput {
  return {
    type: 'sessionRestoreFailed',
    at: tick(),
    failed: { sessionKey: 'k1', sessionId: 'S1' },
    sessionKey: key,
    remoteWorkspaceId: null,
  };
}
/** The person talks in a session. */
const repliedFact = (sessionId = 'S1'): TicketInput => ({ type: 'personReplied', at: tick(), sessionId });

/* ============================================================
   Builders (through the machine, never by writing fields)
   ============================================================ */

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

const open = (): Ticket => ({ ...emptyTicket(T0), brief: 'fix the login redirect' });
const running = (): Ticket => ok(ok(open(), startCmd(1)), startedFact('k1', 'S1'));

const report = (id: string, status: 'done' | 'blocked', sessionId = 'S1'): Report => ({
  reportId: id,
  sessionId,
  status,
  summary: `${status} summary`,
  question: status === 'blocked' ? 'which branch?' : null,
  evidence: [],
  atMs: tick(),
});
const reportedFact = (r: Report): TicketInput => ({ type: 'reported', at: r.atMs, report: r });
const turnEnd = (turnId: string, sessionId = 'S1'): TurnEnd => ({ turnId, sessionId, atMs: tick() });
const endedFact = (te: TurnEnd): TicketInput => ({ type: 'turnEnded', at: te.atMs, turnEnd: te });

const inReview = (): Ticket => ok(running(), reportedFact(report('r-done', 'done')));
const needsYou = (): Ticket => ok(running(), reportedFact(report('r-blocked', 'blocked')));
const done = (): Ticket => ok(inReview(), { type: 'accept', at: tick() });
const dropped = (): Ticket => ok(running(), { type: 'drop', at: tick() });

const BY_STATUS: Record<TicketStatus, () => Ticket> = {
  open,
  running,
  needs_you: needsYou,
  review: inReview,
  done,
  dropped,
};
const STATUSES = Object.keys(BY_STATUS) as TicketStatus[];
const eventTypes = (t: Ticket): string[] => t.events.map((e) => e.type);

/* ============================================================
   Start, runNow
   ============================================================ */

test('start: open -> running, with an executor whose id arrives with init', () => {
  const t = ok(open(), startCmd(1));
  assert.equal(t.status, 'running');
  assert.notEqual(currentAssignment(t), null);
  assert.equal(sessionKeyOf(t), 'k1');
  assert.equal(sessionIdOf(t), '', 'the id is not known before init');
  assert.deepEqual(eventTypes(t), ['created', 'start']);
  const named = ok(t, startedFact('k1', 'S1'));
  assert.equal(sessionIdOf(named), 'S1');
  assert.equal(named.status, 'running', 'naming the session moves nothing');
});

test('start records the machine the session opened on', () => {
  const t = ok(open(), { ...(startCmd(1) as object), remoteWorkspaceId: 'rw-9' } as TicketInput);
  assert.equal(JSON.stringify(t.assignments).includes('"remoteWorkspaceId":"rw-9"'), true);
});

test('start is refused outside open, and without a brief', () => {
  for (const status of ['running', 'review', 'done', 'dropped'] as const) {
    assert.equal(refused(BY_STATUS[status](), startCmd(9)), 'wrong_status', status);
  }
  assert.equal(refused({ ...open(), brief: '  \n ' }, startCmd(1)), 'empty_brief');
});

test('a session id is written back once; a repeat of the same init is a no-op', () => {
  const t = ok(open(), startCmd(1));
  const named = ok(t, startedFact('k1', 'S1'));
  assert.equal(ok(named, startedFact('k1', 'S1')), named);
});

test('resuming a session by hand (new key, same id) writes the key back and moves nothing', () => {
  const blocked = needsYou();
  const t = ok(blocked, startedFact('k7', 'S1'));
  assert.equal(t.status, 'needs_you');
  assert.equal(sessionKeyOf(t), 'k7');
});

test('a session that is not the executor cannot be named into it', () => {
  const t = running();
  assert.equal(ok(t, startedFact('k1', 'S-other')), t);
});

/* ============================================================
   Accept, drop, reopen, send back
   ============================================================ */

test('accept: review -> done, the executor is gone; nowhere else', () => {
  const t = ok(inReview(), { type: 'accept', at: tick() });
  assert.equal(t.status, 'done');
  assert.equal(currentAssignment(t), null);
  assert.equal(t.events.at(-1)?.type, 'accept');
  for (const status of ['open', 'running', 'needs_you', 'done', 'dropped'] as const) {
    assert.equal(refused(BY_STATUS[status](), { type: 'accept', at: tick() }), 'wrong_status', status);
  }
});

test('drop: every non-terminal status -> dropped, nothing is current any more; terminal refused', () => {
  for (const status of ['open', 'running', 'needs_you', 'review'] as const) {
    const t = ok(BY_STATUS[status](), { type: 'drop', at: tick() });
    assert.equal(t.status, 'dropped', status);
    assert.equal(currentAssignment(t), null, `${status}: unbound`);
  }
  assert.equal(refused(done(), { type: 'drop', at: tick() }), 'wrong_status');
  assert.equal(refused(dropped(), { type: 'drop', at: tick() }), 'wrong_status');
});

test('reopen: done / dropped -> open, history stays, and a later start works', () => {
  for (const make of [done, dropped]) {
    const before = make();
    const t = ok(before, { type: 'reopen', at: tick() });
    assert.equal(t.status, 'open');
    assert.equal(currentAssignment(t), null);
    assert.equal(t.assignments.length, before.assignments.length, 'history stays');
    const again = ok(t, startCmd(2));
    assert.equal(again.status, 'running');
    assert.equal(again.assignments.length, before.assignments.length + 1, 'Assignments only grow');
  }
  for (const status of ['open', 'running', 'needs_you', 'review'] as const) {
    assert.equal(refused(BY_STATUS[status](), { type: 'reopen', at: tick() }), 'wrong_status', status);
  }
});

test('sendBack: review -> running with the trimmed feedback; refused elsewhere and when empty', () => {
  const review = inReview();
  const t = ok(review, { type: 'sendBack', at: tick(), feedback: '  tests are missing  ' });
  assert.equal(t.status, 'running');
  assert.equal(t.events.at(-1)?.type, 'sendBack');
  assert.equal(t.events.at(-1)?.data?.feedback, 'tests are missing');
  assert.equal(sessionIdOf(t), sessionIdOf(review), 'the same executor gets the opinion');
  for (const status of ['open', 'running', 'needs_you', 'done', 'dropped'] as const) {
    assert.equal(refused(BY_STATUS[status](), { type: 'sendBack', at: tick(), feedback: 'x' }), 'wrong_status', status);
  }
  assert.equal(refused(review, { type: 'sendBack', at: tick(), feedback: '   ' }), 'empty_feedback');
});

test('start over on a blocked Ticket: running again, the old session no longer speaks for it', () => {
  const t0 = needsYou();
  const t = ok(ok(t0, restartCmd(2, 'k2')), startedFact('k2', 'S2'));
  assert.equal(t.status, 'running');
  assert.equal(bindingIsStale(t, 'S1'), true, 'the old session is unbound when opened');
  assert.equal(bindingIsStale(t, 'S2'), false);
  // And what the old session reports is recorded, not obeyed.
  const late = ok(t, reportedFact(report('r-old', 'done', 'S1')));
  assert.equal(late.status, 'running');
  // The card's last word is whatever it was before; the stale report never
  // replaces it (the blocked report that sent the Ticket here is still it).
  assert.equal(late.lastReport, t.lastReport);
  assert.notEqual(late.lastReport?.reportId, 'r-old');
});

test('a replacement after a failed restore takes over without moving the status', () => {
  const sentBack = ok(inReview(), { type: 'sendBack', at: tick(), feedback: 'again' });
  const t = ok(sentBack, restoreFailedFact(2, 'k2'));
  assert.equal(t.status, 'running', 'the reason it was running is still true');
  assert.equal(sessionKeyOf(t), 'k2');
  assert.equal(
    ['assignmentRestoreFailed', 'sessionRestoreFailed'].includes(t.events.at(-1)?.type ?? ''),
    true,
  );
  // Without an executor there is nothing to replace.
  const none = ok(open(), restoreFailedFact(3, 'kx'));
  assert.equal(currentAssignment(none), null);
  assert.equal(none.status, 'open');
});

/* ============================================================
   Edit
   ============================================================ */

test('edit changes fields in every status, records which, and never moves the status', () => {
  for (const status of STATUSES) {
    const before = BY_STATUS[status]();
    const t = ok(before, {
      type: 'edit',
      at: tick(),
      patch: { title: 'New', brief: 'new brief', model: 'm', workspace: { kind: 'remote', id: 'rw-2' } },
    });
    assert.equal(t.status, status, `${status}: edit is not a transition`);
    assert.equal(t.title, 'New');
    assert.equal(t.brief, 'new brief');
    assert.deepEqual(t.events.at(-1)?.data?.fields, ['title', 'brief', 'model', 'workspace']);
    assert.deepEqual(t.assignments, before.assignments, 'a workspace change does not rewrite history');
  }
});

test('edit that changes nothing is the same object; a bad shape is refused', () => {
  const t = running();
  assert.equal(ok(t, { type: 'edit', at: tick(), patch: { title: t.title, workspace: t.workspace } }), t);
  assert.equal(
    refused(t, { type: 'edit', at: tick(), patch: { workspace: { kind: 'local', path: '' } } }),
    'invalid_edit',
  );
  assert.equal(refused(t, { type: 'edit', at: tick(), patch: { title: 5 as unknown as string } }), 'invalid_edit');
});

test('attachments are replaced whole, by name, and a bad list is refused', () => {
  const att = (name: string) => ({ name, bytes: 10, addedAtMs: T0 });
  const t = ok(open(), { type: 'edit', at: tick(), patch: { attachments: [att('server.log')] } });
  assert.deepEqual(t.attachments, [att('server.log')]);
  assert.deepEqual(t.events.at(-1)?.data, { fields: ['attachments'] });
  assert.equal(ok(t, { type: 'edit', at: tick(), patch: { attachments: [att('server.log')] } }), t);
  for (const list of [[att('a/b')], [att('.env')], [att('x.log'), att('x.log')]]) {
    assert.equal(refused(open(), { type: 'edit', at: tick(), patch: { attachments: list } }), 'invalid_edit');
  }
});

/* ============================================================
   Reports drive the status
   ============================================================ */

test('reported: done -> review, blocked -> needs_you, and lastReport is the report', () => {
  const r = report('r1', 'done');
  const review = ok(running(), reportedFact(r));
  assert.equal(review.status, 'review');
  assert.deepEqual(review.lastReport, r);
  const blocked = ok(running(), reportedFact(report('r2', 'blocked')));
  assert.equal(blocked.status, 'needs_you');
  assert.equal(blocked.lastReport?.question, 'which branch?');
});

test('a report outside running is recorded, not applied', () => {
  for (const status of ['open', 'needs_you', 'review', 'done', 'dropped'] as const) {
    const t = ok(BY_STATUS[status](), reportedFact(report(`r-late-${status}`, 'done')));
    assert.equal(t.status, status, `${status}: not moved`);
    assert.equal(t.events.at(-1)?.type, 'reported');
    assert.equal(t.events.at(-1)?.data?.applied, false);
  }
});

test('a report is idempotent by id, even after a later report replaced lastReport', () => {
  const first = report('r-a', 'blocked');
  let t = ok(running(), reportedFact(first));
  assert.equal(ok(t, reportedFact(first)), t, 'the very same object');
  t = ok(t, repliedFact());
  t = ok(t, reportedFact(report('r-b', 'done')));
  assert.equal(t.lastReport?.reportId, 'r-b');
  assert.equal(ok(t, reportedFact(first)), t, 'found in the events, not only in lastReport');
});

test('a report from a session that is not the executor is recorded, never obeyed', () => {
  const t = ok(running(), reportedFact(report('r-stale', 'done', 'S-old')));
  assert.equal(t.status, 'running');
  assert.equal(t.lastReport, null, 'it does not become the card\u2019s last word');
  assert.equal(t.events.at(-1)?.type, 'reported');
});

test('a report before init has named the session still counts', () => {
  const started = ok(open(), startCmd(1));
  assert.equal(ok(started, reportedFact(report('r-early', 'done', 'S1'))).status, 'review');
});

/* ============================================================
   A turn that ends without a report
   ============================================================ */

test('turnEnded moves only a running Ticket, to review, and leaves lastReport alone', () => {
  const out = ok(running(), endedFact(turnEnd('run-1')));
  assert.equal(out.status, 'review');
  assert.equal(out.events.at(-1)?.type, 'turnEndedUnreported');
  assert.equal(out.lastReport, null);
  for (const status of ['open', 'needs_you', 'review', 'done', 'dropped'] as const) {
    const before = BY_STATUS[status]();
    assert.equal(ok(before, endedFact(turnEnd(`run-${status}`))), before, `${status}: the very same object`);
  }
});

test('turnEnded is idempotent by turn id, ignores a foreign session, and counts before init', () => {
  const te = turnEnd('run-1');
  const once = ok(running(), endedFact(te));
  assert.equal(ok(once, endedFact(te)), once);
  const before = running();
  assert.equal(ok(before, endedFact(turnEnd('run-2', 'S-other'))), before);
  assert.equal(ok(ok(open(), startCmd(1)), endedFact(turnEnd('run-3'))).status, 'review');
});

test('after a send-back the previous report is not mistaken for the new turn\u2019s answer', () => {
  const sentBack = ok(inReview(), { type: 'sendBack', at: tick(), feedback: 'fix it' });
  const out = ok(sentBack, endedFact(turnEnd('run-2')));
  assert.equal(out.status, 'review');
  assert.equal(out.lastReport?.reportId, 'r-done');
});

/* ============================================================
   Exits and the person's reply
   ============================================================ */

test('an unrequested exit on a running Ticket needs the person, and records why', () => {
  for (const reason of ['crashed', 'disconnected'] as const) {
    const t = ok(running(), exitedFact({ requested: false, reason }));
    assert.equal(t.status, 'needs_you', reason);
    assert.equal(t.events.at(-1)?.data?.reason, reason);
    assert.equal(t.events.at(-1)?.data?.requested, false);
  }
  assert.equal(ok(running(), exitedFact({ requested: false })).events.at(-1)?.data?.reason, 'crashed');
});

test('a requested exit moves nothing and carries no reason', () => {
  const t = ok(running(), exitedFact({ requested: true }));
  assert.equal(t.status, 'running');
  assert.equal(t.events.at(-1)?.data?.requested, true);
  assert.equal('reason' in (t.events.at(-1)?.data ?? {}), false);
});

test('invariant 6: an exit under needs_you or review is recorded and moves nothing', () => {
  for (const status of ['needs_you', 'review'] as const) {
    for (const requested of [true, false]) {
      const before = BY_STATUS[status]();
      const t = ok(before, exitedFact({ requested, reason: 'disconnected' }));
      assert.equal(t.status, status, `${status}/requested=${requested}`);
      assert.equal(t.events.length, before.events.length + 1);
    }
  }
});

test('an exit in a terminal state, or from a session that is not the executor, is a no-op', () => {
  for (const status of ['open', 'done', 'dropped'] as const) {
    const t = BY_STATUS[status]();
    assert.equal(ok(t, exitedFact({ requested: false })), t, status);
  }
  const t = running();
  assert.equal(ok(t, exitedFact({ requested: false, id: 'S-old' })), t);
  // Keys are a per-run counter: last week's `k1` can name another session today.
  assert.equal(ok(t, exitedFact({ requested: false, key: 'k1', id: 'S-someone-else' })), t);
});

test('personReplied: needs_you -> running, only from the executor; anything else changes nothing', () => {
  const blocked = needsYou();
  const t = ok(blocked, repliedFact());
  assert.equal(t.status, 'running');
  assert.equal(eventTypes(t).at(-1), 'personReplied');
  assert.equal(ok(blocked, repliedFact('S-other')), blocked);
  for (const status of ['open', 'running', 'review', 'done', 'dropped'] as const) {
    const before = BY_STATUS[status]();
    const after = ok(before, repliedFact());
    // Never an event and never a move: this fires on every message the person
    // sends, and 200 events would be gone in an afternoon. The one thing that
    // may change is the session's last-activity time (design 3.3: it decides
    // which session "open" defaults to), which is neither status nor history.
    assert.equal(after.status, before.status, `${status}: not moved`);
    assert.equal(after.events.length, before.events.length, `${status}: no event`);
    assert.deepEqual(stripActivity(after), stripActivity(before), `${status}: nothing else changed`);
  }
});

/** A Ticket with the sessions' last-activity times blanked, for "nothing but
 *  activity changed" comparisons. */
function stripActivity(t: Ticket): unknown {
  return JSON.parse(JSON.stringify(t), (key, value) => (key === 'lastActiveAtMs' ? 0 : value));
}

/* ============================================================
   Bindings (design 5.1)
   ============================================================ */

test('isBindable is exactly running / needs_you / review', () => {
  const expected: Record<TicketStatus, boolean> = {
    open: false,
    running: true,
    needs_you: true,
    review: true,
    done: false,
    dropped: false,
  };
  for (const status of STATUSES) assert.equal(isBindable(BY_STATUS[status]()), expected[status], status);
});

test('a binding is stale once the Ticket is accepted, dropped, missing or never ran', () => {
  for (const status of ['running', 'needs_you', 'review'] as const) {
    assert.equal(bindingIsStale(BY_STATUS[status](), 'S1'), false, status);
  }
  assert.equal(bindingIsStale(done(), 'S1'), true, 'accepted: unbound when the session is next opened');
  assert.equal(bindingIsStale(dropped(), 'S1'), true, 'dropped: unbound when the session is next opened');
  assert.equal(bindingIsStale(null, 'S1'), true);
  assert.equal(bindingIsStale(open(), 'S1'), true);
  assert.equal(bindingIsStale(running(), 'S-other'), true, 'some other session');
  assert.equal(bindingIsStale(ok(open(), startCmd(1)), 'S1'), true, 'a session with no id yet never matches');
  assert.equal(bindingIsStale(running(), ''), true);
});

/* ============================================================
   The record
   ============================================================ */

test('everything the machine produces is a valid record, also after the file', () => {
  for (const status of STATUSES) {
    assert.equal(isValidTicket(BY_STATUS[status]()), true, status);
    assert.equal(isValidTicket(JSON.parse(JSON.stringify(BY_STATUS[status]()))), true, `${status} via JSON`);
  }
});

test('a refusal never mutates its input, and updatedAtMs never goes backwards on a replay', () => {
  const t = running();
  const snapshot = JSON.stringify(t);
  apply(t, { type: 'accept', at: tick() });
  ok(t, { type: 'drop', at: tick() });
  assert.equal(JSON.stringify(t), snapshot);
  const next = ok(t, reportedFact({ ...report('r-old', 'done'), atMs: 1 }));
  assert.ok(next.updatedAtMs >= t.updatedAtMs);
});

test('events are capped at 200: the oldest go, created never does', () => {
  let t = open();
  for (let i = 0; i < TICKET_EVENTS_MAX + 20; i += 1) {
    t = ok(t, { type: 'edit', at: tick(), patch: { title: `t${i}` } });
  }
  assert.equal(t.events.length, TICKET_EVENTS_MAX);
  assert.equal(t.events[0].type, 'created');
  assert.equal(t.title, `t${TICKET_EVENTS_MAX + 19}`);
});
