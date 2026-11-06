/**
 * The Ticket state machine and its entity (`docs/design/ticket.md` §4, §6.1).
 *
 * What is asserted is the table and the seven invariants, one test per row or
 * rule, because every failure here is silent in a window: a Ticket that moved
 * when it should not have looks like a Ticket that moved correctly, and the
 * person finds out when the card says "Review" over work nobody finished.
 *
 * `apply` is pure, so nothing here needs a store, a clock or a window.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apply,
  bindingIsStale,
  currentAssignment,
  hasSeenReport,
  isBindable,
  type TicketInput,
} from '@/ticket/machine';
import {
  TICKET_EVENTS_MAX,
  emptyTicket,
  isValidTicket,
  newTicketId,
  ticketTitle,
  type Report,
  type Ticket,
  type TicketStatus,
} from '@/ticket/model';

/* ============================================================
   Builders
   ============================================================ */

const T0 = 1_000;
let clock = T0;
/** Strictly increasing, so "updatedAtMs moved" is observable. */
const tick = (): number => (clock += 10);

/** Apply an input that must be accepted; return the new Ticket. */
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

function open(): Ticket {
  return { ...emptyTicket(T0), brief: 'fix the login redirect' };
}

const startInput = (n = 1, key = `k${n}`): TicketInput => ({
  type: 'start',
  at: tick(),
  assignmentId: `as-${n}`,
  sessionKey: key,
  remoteWorkspaceId: null,
});

/** Running, with session `S1` known (`init` has landed). */
function running(): Ticket {
  const started = ok(open(), startInput(1));
  return ok(started, { type: 'assignmentStarted', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
}

const report = (id: string, status: 'done' | 'blocked', sessionId = 'S1'): Report => ({
  reportId: id,
  sessionId,
  status,
  summary: `${status} summary`,
  question: status === 'blocked' ? 'which branch?' : null,
  evidence: [],
  atMs: tick(),
});

const reported = (r: Report): TicketInput => ({ type: 'reported', at: r.atMs, report: r });

function inReview(): Ticket {
  return ok(running(), reported(report('r-done', 'done')));
}
function needsYou(): Ticket {
  return ok(running(), reported(report('r-blocked', 'blocked')));
}
function done(): Ticket {
  return ok(inReview(), { type: 'accept', at: tick() });
}
function dropped(): Ticket {
  return ok(running(), { type: 'drop', at: tick() });
}

const eventTypes = (t: Ticket): string[] => t.events.map((e) => e.type);

/** Every status, built by the machine itself rather than hand-written. */
const BY_STATUS: Record<TicketStatus, () => Ticket> = {
  open,
  running,
  needs_you: needsYou,
  review: inReview,
  done,
  dropped,
};

/* ============================================================
   Entity helpers
   ============================================================ */

test('a new id is tk-<time36>-<rand> and embeds nothing else', () => {
  const id = newTicketId(1_700_000_000_000);
  assert.match(id, /^tk-[0-9a-z]+-[0-9a-z]{1,6}$/);
  assert.ok(id.startsWith(`tk-${(1_700_000_000_000).toString(36)}-`));
  assert.notEqual(newTicketId(5), newTicketId(5), 'two ids in one millisecond differ');
});

test('the title is the name, else the first non-empty line of the brief, cut at 80', () => {
  const t = (title: string, brief: string) => ticketTitle({ title, brief });
  assert.equal(t('  Ship it ', 'whatever'), 'Ship it');
  assert.equal(t('', '\n  \n  first line  \nsecond'), 'first line');
  assert.equal(t('   ', 'a\r\nb'), 'a');
  assert.equal(t('', ''), '');
  const long = 'x'.repeat(120);
  const cut = t('', long);
  assert.equal(cut.length, 80);
  assert.ok(cut.endsWith('…'));
  assert.equal(t('', 'y'.repeat(80)), 'y'.repeat(80), 'exactly 80 is not cut');
});

test('a fresh Ticket is open, unassigned, and carries its created event', () => {
  const t = emptyTicket(T0);
  assert.equal(t.status, 'open');
  assert.deepEqual(t.assignments, []);
  assert.deepEqual(eventTypes(t), ['created']);
  assert.equal(t.lastReport, null);
  assert.equal(t.createdAtMs, T0);
  assert.deepEqual(t.requester, { kind: 'person', id: 'local' });
  assert.deepEqual(t.origin, { kind: 'manual' });
  assert.equal(isValidTicket(t), true);
});

/* ============================================================
   Commands: every transition
   ============================================================ */

test('start: open -> running, with a new in-flight Assignment', () => {
  const t = ok(open(), startInput(1));
  assert.equal(t.status, 'running');
  assert.equal(t.assignments.length, 1);
  const a = currentAssignment(t);
  assert.equal(a?.id, 'as-1');
  assert.equal(a?.end, null);
  assert.equal(a?.executor.sessionKey, 'k1');
  assert.equal(a?.executor.sessionId, '', 'the id arrives with init');
  assert.deepEqual(eventTypes(t), ['created', 'start']);
});

test('start records the machine the session actually opened on', () => {
  const t = ok(open(), { ...(startInput(1) as object), remoteWorkspaceId: 'rw-9' } as TicketInput);
  assert.equal(currentAssignment(t)?.executor.remoteWorkspaceId, 'rw-9');
});

test('start: needs_you -> running, the old Assignment is superseded and a new one opens', () => {
  const blocked = needsYou();
  const t = ok(blocked, startInput(2));
  assert.equal(t.status, 'running');
  assert.equal(t.assignments.length, 2);
  assert.equal(t.assignments[0].end, 'superseded');
  assert.notEqual(t.assignments[0].endedAtMs, null);
  assert.equal(t.assignments[1].end, null);
  assert.equal(t.assignments.filter((a) => a.end === null).length, 1, 'never two in flight');
});

test('start with a still-live predecessor (needs_you by exit) supersedes it too', () => {
  const crashed = ok(running(), {
    type: 'assignmentExited',
    at: tick(),
    requested: false,
    reason: 'crashed',
    sessionKey: 'k1',
    sessionId: 'S1',
  });
  assert.equal(crashed.status, 'needs_you');
  assert.equal(currentAssignment(crashed)?.end, null, 'a crash does not end the Assignment');
  const t = ok(crashed, startInput(2));
  assert.equal(t.assignments[0].end, 'superseded');
});

test('start is refused outside open / needs_you, and without a brief', () => {
  for (const status of ['running', 'review', 'done', 'dropped'] as const) {
    assert.equal(refused(BY_STATUS[status](), startInput(9)), 'wrong_status', status);
  }
  assert.equal(refused({ ...open(), brief: '  \n ' }, startInput(1)), 'empty_brief');
});

test('reported(done): running -> review; reported(blocked): running -> needs_you', () => {
  const r = report('r1', 'done');
  const review = ok(running(), reported(r));
  assert.equal(review.status, 'review');
  assert.deepEqual(review.lastReport, r);

  const b = report('r2', 'blocked');
  const blocked = ok(running(), reported(b));
  assert.equal(blocked.status, 'needs_you');
  assert.equal(blocked.lastReport?.question, 'which branch?');
});

test('personReplied: needs_you -> running, only for the current Assignment session', () => {
  const blocked = needsYou();
  const t = ok(blocked, { type: 'personReplied', at: tick(), sessionId: 'S1' });
  assert.equal(t.status, 'running');
  assert.equal(currentAssignment(t)?.id, currentAssignment(blocked)?.id, 'same Assignment, not a new one');
  assert.equal(eventTypes(t).at(-1), 'personReplied');
});

test('personReplied from another session, or outside needs_you, changes and records nothing', () => {
  const blocked = needsYou();
  const other = apply(blocked, { type: 'personReplied', at: tick(), sessionId: 'S-other' });
  assert.equal(other.ok && other.ticket, blocked, 'a superseded session is not the executor');

  for (const status of ['open', 'running', 'review', 'done', 'dropped'] as const) {
    const t = BY_STATUS[status]();
    const result = apply(t, { type: 'personReplied', at: tick(), sessionId: 'S1' });
    assert.equal(result.ok && result.ticket, t, `${status}: same object, no event`);
  }
});

test('accept: review -> done, the Assignment ends as accepted', () => {
  const t = ok(inReview(), { type: 'accept', at: tick() });
  assert.equal(t.status, 'done');
  assert.equal(t.assignments[0].end, 'accepted');
  assert.notEqual(t.assignments[0].endedAtMs, null);
  assert.equal(currentAssignment(t), null);
  assert.equal(eventTypes(t).at(-1), 'accept');
});

test('accept is refused everywhere but review: only a person finishes, and only what was reported', () => {
  for (const status of ['open', 'running', 'needs_you', 'done', 'dropped'] as const) {
    assert.equal(refused(BY_STATUS[status](), { type: 'accept', at: tick() }), 'wrong_status', status);
  }
});

test('sendBack: review -> running on the same Assignment, with the feedback on the event', () => {
  const review = inReview();
  const t = ok(review, { type: 'sendBack', at: tick(), feedback: '  tests are missing  ' });
  assert.equal(t.status, 'running');
  assert.equal(currentAssignment(t)?.id, currentAssignment(review)?.id);
  assert.equal(t.events.at(-1)?.type, 'sendBack');
  assert.equal(t.events.at(-1)?.data?.feedback, 'tests are missing');
});

test('sendBack is refused outside review, and without an opinion', () => {
  for (const status of ['open', 'running', 'needs_you', 'done', 'dropped'] as const) {
    assert.equal(refused(BY_STATUS[status](), { type: 'sendBack', at: tick(), feedback: 'x' }), 'wrong_status', status);
  }
  assert.equal(refused(inReview(), { type: 'sendBack', at: tick(), feedback: '   ' }), 'empty_feedback');
});

test('drop: any non-terminal status -> dropped, the in-flight Assignment ends as dropped', () => {
  for (const status of ['open', 'running', 'needs_you', 'review'] as const) {
    const before = BY_STATUS[status]();
    const t = ok(before, { type: 'drop', at: tick() });
    assert.equal(t.status, 'dropped', status);
    assert.equal(currentAssignment(t), null, `${status}: unbound`);
    if (before.assignments.length > 0) assert.equal(t.assignments[0].end, 'dropped', status);
  }
});

test('drop is refused on done and dropped', () => {
  assert.equal(refused(done(), { type: 'drop', at: tick() }), 'wrong_status');
  assert.equal(refused(dropped(), { type: 'drop', at: tick() }), 'wrong_status');
});

test('reopen: done / dropped -> open; Assignments are kept and a later start adds one', () => {
  for (const make of [done, dropped]) {
    const before = make();
    const t = ok(before, { type: 'reopen', at: tick() });
    assert.equal(t.status, 'open');
    assert.equal(t.assignments.length, 1, 'history stays');
    assert.equal(currentAssignment(t), null);
    const again = ok(t, startInput(2));
    assert.equal(again.assignments.length, 2, 'Assignments only grow');
    assert.equal(again.status, 'running');
  }
});

test('reopen is refused unless done or dropped', () => {
  for (const status of ['open', 'running', 'needs_you', 'review'] as const) {
    assert.equal(refused(BY_STATUS[status](), { type: 'reopen', at: tick() }), 'wrong_status', status);
  }
});

test('edit changes fields in every status, records which, and never touches status', () => {
  for (const status of Object.keys(BY_STATUS) as TicketStatus[]) {
    const before = BY_STATUS[status]();
    const t = ok(before, {
      type: 'edit',
      at: tick(),
      patch: { title: 'New', brief: 'new brief', model: 'm', workspace: { kind: 'remote', id: 'rw-2' } },
    });
    assert.equal(t.status, status, `${status}: edit is not a transition`);
    assert.equal(t.title, 'New');
    assert.equal(t.brief, 'new brief');
    assert.equal(t.model, 'm');
    assert.deepEqual(t.workspace, { kind: 'remote', id: 'rw-2' });
    assert.deepEqual(t.events.at(-1)?.data?.fields, ['title', 'brief', 'model', 'workspace']);
    // Existing Assignments are not rewritten by a workspace change.
    assert.deepEqual(t.assignments, before.assignments);
  }
});

test('edit that changes nothing returns the same object; a bad shape is refused', () => {
  const t = running();
  const same = apply(t, { type: 'edit', at: tick(), patch: { title: t.title, workspace: t.workspace } });
  assert.equal(same.ok && same.ticket, t);
  assert.equal(
    refused(t, { type: 'edit', at: tick(), patch: { workspace: { kind: 'local', path: '' } } }),
    'invalid_edit',
  );
  assert.equal(
    refused(t, { type: 'edit', at: tick(), patch: { title: 5 as unknown as string } }),
    'invalid_edit',
  );
});

test('a refusal changes nothing: the input Ticket is never mutated', () => {
  const t = running();
  const snapshot = JSON.stringify(t);
  apply(t, { type: 'accept', at: tick() });
  ok(t, { type: 'drop', at: tick() });
  assert.equal(JSON.stringify(t), snapshot);
});

/* ============================================================
   Facts: reports
   ============================================================ */

test('a report is idempotent by report id: no second event, same object', () => {
  const r = report('r-dup', 'blocked');
  const once = ok(running(), reported(r));
  const twice = apply(once, reported(r));
  assert.equal(twice.ok && twice.ticket, once, 'the very same object, so a caller can skip the write');
  assert.equal(eventTypes(once).filter((t) => t === 'reported').length, 1);
  assert.equal(hasSeenReport(once, 'r-dup'), true);
  assert.equal(hasSeenReport(once, 'r-other'), false);
});

test('a duplicate is recognised after a later report replaced lastReport', () => {
  const first = report('r-a', 'blocked');
  let t = ok(running(), reported(first));
  t = ok(t, { type: 'personReplied', at: tick(), sessionId: 'S1' });
  t = ok(t, reported(report('r-b', 'done')));
  assert.equal(t.lastReport?.reportId, 'r-b');
  const again = apply(t, reported(first));
  assert.equal(again.ok && again.ticket, t, 'found in the events, not only in lastReport');
});

test('invariant 5: a report outside running is recorded but does not migrate', () => {
  for (const status of ['open', 'needs_you', 'review', 'done', 'dropped'] as const) {
    const before = BY_STATUS[status]();
    const r = report(`r-late-${status}`, 'done');
    const t = ok(before, reported(r));
    assert.equal(t.status, status, `${status}: not moved`);
    assert.equal(eventTypes(t).at(-1), 'reported', `${status}: still recorded`);
    assert.equal(t.events.at(-1)?.data?.applied, false);
  }
});

test('a report from a session that is not the current executor is recorded, not obeyed', () => {
  const t0 = running();
  const t = ok(t0, reported(report('r-stale', 'done', 'S-old')));
  assert.equal(t.status, 'running');
  assert.equal(t.lastReport, null, 'it does not become the card\'s last word');
  assert.equal(eventTypes(t).at(-1), 'reported');
});

test('a report before init has named the session is accepted for the Assignment', () => {
  const started = ok(open(), startInput(1));
  assert.equal(currentAssignment(started)?.executor.sessionId, '');
  const t = ok(started, reported(report('r-early', 'done', 'S1')));
  assert.equal(t.status, 'review');
});

/* ============================================================
   Facts: exits
   ============================================================ */

test('assignmentExited(requested=false) on running -> needs_you; the Assignment stays open', () => {
  for (const reason of ['crashed', 'disconnected'] as const) {
    const t = ok(running(), {
      type: 'assignmentExited',
      at: tick(),
      requested: false,
      reason,
      sessionKey: 'k1',
      sessionId: 'S1',
    });
    assert.equal(t.status, 'needs_you', reason);
    assert.equal(currentAssignment(t)?.end, null, `${reason}: Assignment not ended`);
    assert.equal(t.events.at(-1)?.type, 'assignmentExited');
    assert.equal(t.events.at(-1)?.data?.reason, reason);
    assert.equal(t.events.at(-1)?.data?.requested, false);
  }
});

test('an unrequested exit with no stated reason is a crash', () => {
  const t = ok(running(), {
    type: 'assignmentExited',
    at: tick(),
    requested: false,
    sessionKey: 'k1',
    sessionId: 'S1',
  });
  assert.equal(t.events.at(-1)?.data?.reason, 'crashed');
});

test('assignmentExited(requested=true) on running: still running, event recorded', () => {
  const t = ok(running(), {
    type: 'assignmentExited',
    at: tick(),
    requested: true,
    sessionKey: 'k1',
    sessionId: 'S1',
  });
  assert.equal(t.status, 'running');
  assert.equal(t.events.at(-1)?.type, 'assignmentExited');
  assert.equal(t.events.at(-1)?.data?.requested, true);
  assert.equal('reason' in (t.events.at(-1)?.data ?? {}), false, 'a person closing a window has no reason');
});

test('invariant 6: an exit under needs_you or review is recorded but does not migrate', () => {
  for (const status of ['needs_you', 'review'] as const) {
    for (const requested of [true, false]) {
      const before = BY_STATUS[status]();
      const t = ok(before, {
        type: 'assignmentExited',
        at: tick(),
        requested,
        reason: 'disconnected',
        sessionKey: 'k1',
        sessionId: 'S1',
      });
      assert.equal(t.status, status, `${status}/requested=${requested}`);
      assert.equal(t.events.length, before.events.length + 1);
      assert.equal(currentAssignment(t)?.end, null);
    }
  }
});

test('an exit in a terminal state, or of a session that is not the executor, is a no-op', () => {
  for (const status of ['open', 'done', 'dropped'] as const) {
    const t = BY_STATUS[status]();
    const result = apply(t, {
      type: 'assignmentExited',
      at: tick(),
      requested: false,
      sessionKey: 'k1',
      sessionId: 'S1',
    });
    assert.equal(result.ok && result.ticket, t, status);
  }
  const t = running();
  const old = apply(t, {
    type: 'assignmentExited',
    at: tick(),
    requested: false,
    sessionKey: 'k1',
    sessionId: 'S-old',
  });
  assert.equal(old.ok && old.ticket, t, 'a superseded session dying is not news');
});

test('a stale sessionKey cannot claim an exit once the session id is known', () => {
  // Keys are a per-run counter: last week's `k1` can name another session today.
  const t = running();
  const result = apply(t, {
    type: 'assignmentExited',
    at: tick(),
    requested: false,
    sessionKey: 'k1',
    sessionId: 'S-someone-else',
  });
  assert.equal(result.ok && result.ticket, t);
});

/* ============================================================
   Facts: assignmentStarted, resume, restore
   ============================================================ */

test('assignmentStarted back-fills the session id once, and a repeat is a no-op', () => {
  const started = ok(open(), startInput(1));
  const t = ok(started, { type: 'assignmentStarted', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  assert.equal(currentAssignment(t)?.executor.sessionId, 'S1');
  const again = apply(t, { type: 'assignmentStarted', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  assert.equal(again.ok && again.ticket, t);
});

test('invariant 7: resuming the session (a new key, same id) does not migrate needs_you', () => {
  const blocked = needsYou();
  const t = ok(blocked, { type: 'assignmentStarted', at: tick(), sessionKey: 'k7', sessionId: 'S1' });
  assert.equal(t.status, 'needs_you', 'no event, no transition');
  assert.equal(currentAssignment(t)?.executor.sessionKey, 'k7', 'the new key is written back');
  assert.equal(currentAssignment(t)?.id, currentAssignment(blocked)?.id, 'same Assignment');
  // Only the person speaking moves it.
  const spoken = ok(t, { type: 'personReplied', at: tick(), sessionId: 'S1' });
  assert.equal(spoken.status, 'running');
});

test('assignmentStarted for another session changes nothing', () => {
  const t = running();
  const result = apply(t, { type: 'assignmentStarted', at: tick(), sessionKey: 'k1', sessionId: 'S-other' });
  assert.equal(result.ok && result.ticket, t);
});

test('assignmentRestoreFailed: the old Assignment ends as restore_failed and a new one takes over', () => {
  // sendBack found the original session gone.
  const sentBack = ok(inReview(), { type: 'sendBack', at: tick(), feedback: 'again' });
  const t = ok(sentBack, {
    type: 'assignmentRestoreFailed',
    at: tick(),
    assignmentId: 'as-2',
    sessionKey: 'k2',
    remoteWorkspaceId: null,
  });
  assert.equal(t.status, 'running', 'the reason it was running is still true');
  assert.equal(t.assignments.length, 2);
  assert.equal(t.assignments[0].end, 'restore_failed');
  assert.equal(t.assignments[1].end, null);
  assert.equal(t.assignments[1].id, 'as-2');
  assert.equal(t.assignments.filter((a) => a.end === null).length, 1);
  assert.equal(t.events.at(-1)?.type, 'assignmentRestoreFailed');
});

test('assignmentRestoreFailed without an executor is recorded and opens nothing', () => {
  const t = ok(open(), {
    type: 'assignmentRestoreFailed',
    at: tick(),
    assignmentId: 'as-x',
    sessionKey: 'kx',
    remoteWorkspaceId: null,
  });
  assert.equal(t.assignments.length, 0);
  assert.equal(t.status, 'open');
});

/* ============================================================
   Bookkeeping: updatedAt, the event cap
   ============================================================ */

test('every recorded change moves updatedAtMs; a no-op does not', () => {
  const t = running();
  const later = ok(t, { type: 'edit', at: t.updatedAtMs + 500, patch: { title: 'x' } });
  assert.equal(later.updatedAtMs, t.updatedAtMs + 500);
  const noop = apply(later, { type: 'personReplied', at: later.updatedAtMs + 900, sessionId: 'S1' });
  assert.equal(noop.ok && noop.ticket.updatedAtMs, later.updatedAtMs);
});

test('a replayed (older) fact never makes updatedAtMs go backwards', () => {
  const t = running();
  const old = { ...report('r-old', 'done'), atMs: 1 };
  const next = ok(t, reported(old));
  assert.ok(next.updatedAtMs >= t.updatedAtMs);
});

test('events are capped at 200: the oldest go, created never does', () => {
  let t = open();
  for (let i = 0; i < TICKET_EVENTS_MAX + 60; i += 1) {
    t = ok(t, { type: 'edit', at: tick(), patch: { title: `t${i}` } });
  }
  assert.equal(t.events.length, TICKET_EVENTS_MAX);
  assert.equal(t.events[0].type, 'created');
  assert.equal(t.events.at(-1)?.type, 'edited');
  assert.equal(t.title, `t${TICKET_EVENTS_MAX + 59}`, 'the newest survived');
  // Exactly one created, and the second entry is not the very first edit.
  assert.equal(t.events.filter((e) => e.type === 'created').length, 1);
  assert.ok(t.events[1].at > t.events[0].at + 10 * 2, 'the oldest edits were dropped');
});

test('below the cap nothing is trimmed', () => {
  let t = open();
  for (let i = 0; i < 20; i += 1) t = ok(t, { type: 'edit', at: tick(), patch: { title: `t${i}` } });
  assert.equal(t.events.length, 21);
});

/* ============================================================
   Queries: bindable, stale binding (§5.1)
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
  for (const status of Object.keys(expected) as TicketStatus[]) {
    assert.equal(isBindable(BY_STATUS[status]()), expected[status], status);
  }
});

test('bindingIsStale: a live binding on the current Assignment is not stale', () => {
  for (const status of ['running', 'needs_you', 'review'] as const) {
    assert.equal(bindingIsStale(BY_STATUS[status](), 'S1'), false, status);
  }
});

test('bindingIsStale: a missing Ticket, or one outside the three states, is stale', () => {
  assert.equal(bindingIsStale(null, 'S1'), true);
  assert.equal(bindingIsStale(undefined, 'S1'), true);
  for (const status of ['open', 'done', 'dropped'] as const) {
    assert.equal(bindingIsStale(BY_STATUS[status](), 'S1'), true, status);
  }
});

test('bindingIsStale: a session that is no longer the current Assignment is stale', () => {
  assert.equal(bindingIsStale(running(), 'S-other'), true);
  // After "start over", the previous session is stale and the new one is not.
  let t = needsYou();
  t = ok(t, startInput(2, 'k2'));
  t = ok(t, { type: 'assignmentStarted', at: tick(), sessionKey: 'k2', sessionId: 'S2' });
  assert.equal(bindingIsStale(t, 'S1'), true);
  assert.equal(bindingIsStale(t, 'S2'), false);
});

test('bindingIsStale: an Assignment whose session id is unknown never matches', () => {
  const t = ok(open(), startInput(1));
  assert.equal(bindingIsStale(t, 'S1'), true);
  assert.equal(bindingIsStale(t, ''), true);
});

/* ============================================================
   The guard
   ============================================================ */

test('isValidTicket accepts every Ticket the machine can produce', () => {
  for (const status of Object.keys(BY_STATUS) as TicketStatus[]) {
    assert.equal(isValidTicket(BY_STATUS[status]()), true, status);
    // And it survives the file: JSON is the only form it is ever read in.
    assert.equal(isValidTicket(JSON.parse(JSON.stringify(BY_STATUS[status]()))), true, `${status} via JSON`);
  }
});

test('isValidTicket drops a malformed record whole', () => {
  const good = running();
  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['an array', []],
    ['no id', { ...good, id: '' }],
    ['a future schema', { ...good, schema: 2 }],
    ['an unknown status', { ...good, status: 'paused' }],
    ['a bad workspace', { ...good, workspace: { kind: 'local', path: '' } }],
    ['an unknown workspace kind', { ...good, workspace: { kind: 'cloud' } }],
    ['a non-string brief', { ...good, brief: 4 }],
    ['assignments not an array', { ...good, assignments: {} }],
    ['an assignment with a bad end', { ...good, assignments: [{ ...good.assignments[0], end: 'finished' }] }],
    ['an assignment without a session', { ...good, assignments: [{ ...good.assignments[0], executor: { kind: 'worker' } }] }],
    ['two in-flight assignments', { ...good, assignments: [good.assignments[0], { ...good.assignments[0], id: 'as-2' }] }],
    ['an unknown event type', { ...good, events: [{ at: 1, actor: { kind: 'system' }, type: 'exploded' }] }],
    ['an event with a bad actor', { ...good, events: [{ at: 1, actor: { kind: 'robot' }, type: 'created' }] }],
    ['a malformed lastReport', { ...good, lastReport: { reportId: 'x' } }],
    ['a report with a bad status', { ...good, lastReport: { ...report('r', 'done'), status: 'ready' } }],
    ['no timestamps', { ...good, createdAtMs: 'yesterday' }],
    ['a foreign origin', { ...good, origin: { kind: 'github' } }],
  ];
  for (const [name, value] of bad) assert.equal(isValidTicket(value), false, name);
});

test('isValidTicket keeps a record whose status disagrees with its Assignments', () => {
  // The status is a snapshot the machine wrote; the guard does not second-guess
  // it, because dropping a readable Ticket for an unrepairable disagreement
  // would lose more than it saves.
  assert.equal(isValidTicket({ ...running(), status: 'open' }), true);
});
