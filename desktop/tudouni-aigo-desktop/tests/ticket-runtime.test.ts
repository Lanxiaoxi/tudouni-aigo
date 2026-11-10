/**
 * The Ticket side of a session's life: what `init`, `ui(ticket_report)`,
 * `runtime_exited` and the person's own messages do to a Ticket, and when a
 * Ticket is worth a system notification.
 *
 * Every rule here fails silently in a window: a report that was dropped because
 * the file was still being read, a reconcile that ran twice and recorded twice,
 * an unbind that raced ahead of the reconcile and deleted the reports it was
 * about to deliver. Driven through the real `applyRuntimeMessage`, against a
 * fake Tauri host that serves a Ticket file.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp } from '@/state/store';
import { registerRuntime, unregisterRuntime } from '@/runtime/bus';
import { apply, currentAssignment, type TicketInput } from '@/ticket/machine';
import { emptyTicket, type Report, type Ticket } from '@/ticket/model';
import { serializeTickets, resetTicketStoreForTests } from '@/ticket/store';
import { selectTicketNotifyKey } from '@/state/selectors/tickets';
import {
  decodeTicketNotifySnapshot,
  encodeTicketNotifySnapshot,
  ticketNotifyContent,
  ticketNotifyPass,
  ticketNotifyReason,
} from '@/runtime/notify';
import { makeT } from '@/i18n';
import type { TicketStatus } from '@/ticket/model';

/* ============================================================
   The host: a Ticket file that can be read
   ============================================================ */

let ticketFile: string | null = null;
let ticketReads = 0;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string) {
      if (cmd === 'tickets_read') {
        ticketReads += 1;
        return Promise.resolve(ticketFile);
      }
      return Promise.resolve(null);
    },
  },
};

/* ============================================================
   Fixtures
   ============================================================ */

const KEY = 'k1';

/** Everything sent to `key`; `session_list` and friends are filtered by `sent`. */
function capture(key: string, onSend?: (m: Record<string, unknown>) => void): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  registerRuntime({
    key,
    send: (m) => {
      const msg = m as unknown as Record<string, unknown>;
      out.push(msg);
      onSend?.(msg);
    },
    subscribe: () => () => undefined,
    dispose: () => undefined,
  });
  return out;
}

const binds = (out: Record<string, unknown>[]): Record<string, unknown>[] =>
  out.filter((m) => m.t === 'ticket_bind');

function reset(): void {
  resetTicketStoreForTests();
  ticketFile = null;
  ticketReads = 0;
  for (const key of [KEY, 'k2', 'k-new']) unregisterRuntime(key);
  useApp.setState({
    sessions: { [KEY]: createSessionBucket(KEY, 'C:/work', { ericai: false, maxSteps: null }, null) },
    order: [KEY],
    activeKey: KEY,
    modal: null,
    pendingModals: [],
    panel: null,
    board: null,
    suggestionsEnabled: true,
    tickets: [],
    ticketsLoaded: true,
    ticketsReadOnly: false,
    ticketsProblem: null,
  });
}

function initMsg(sessionId: string, protocol: number, ticket?: unknown): Record<string, unknown> {
  return {
    v: 1,
    t: 'init',
    protocol,
    session_id: sessionId,
    resumed: true,
    model: 'm',
    provider: 'p',
    thinking: false,
    effort: '',
    effort_levels: [],
    model_catalog: { models: [], aliases: [] },
    workspace: 'C:/work',
    max_steps: 150,
    stream: true,
    context_tokens: null,
    tools: [],
    permissions: {},
    audit_path: '',
    notices: [],
    ...(ticket === undefined ? {} : { ticket }),
  };
}

function deliver(key: string, msg: Record<string, unknown>): void {
  useApp.getState().applyRuntimeMessage(key, msg as never);
}

const wireReport = (id: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  report_id: id,
  status: 'blocked',
  summary: 'stuck',
  question: 'which db?',
  evidence: [],
  at_ms: 5_000,
  ...patch,
});

const REPORT = (patch: Partial<Report> = {}): Report => ({
  reportId: 'r1',
  sessionId: 'S1',
  status: 'done',
  summary: 'did it',
  question: null,
  evidence: [],
  atMs: 3_000,
  ...patch,
});

/** A Ticket brought to a status through the machine only. */
function ticketAt(
  status: 'running' | 'needs_you' | 'review' | 'dropped',
  executor: { sessionId?: string; sessionKey?: string } = {},
  id = 'tk-1',
): Ticket {
  let t: Ticket = { ...emptyTicket(1_000), id, title: 'T', brief: 'do the thing' };
  const run = (input: TicketInput): void => {
    const result = apply(t, input);
    if (!result.ok) throw new Error(`refused ${input.type}: ${result.reason}`);
    t = result.ticket;
  };
  const sessionKey = executor.sessionKey ?? KEY;
  const sessionId = executor.sessionId ?? 'S1';
  run({ type: 'start', at: 2_000, assignmentId: 'as-1', sessionKey, remoteWorkspaceId: null, workspace: 'C:/work' });
  if (sessionId !== '') run({ type: 'assignmentStarted', at: 2_001, sessionKey, sessionId });
  if (status === 'review') run({ type: 'reported', at: 3_000, report: REPORT({ sessionId }) });
  if (status === 'needs_you') {
    run({ type: 'reported', at: 3_000, report: REPORT({ sessionId, status: 'blocked', question: 'q?' }) });
  }
  if (status === 'dropped') run({ type: 'drop', at: 3_000 });
  return t;
}

const install = (...tickets: Ticket[]): void => useApp.setState({ tickets });

/** The handshake has named the session in `key` (what a live child has by the
 *  time it can exit): the machine matches an exit by session id, never by a
 *  key that may be left over from an earlier run. */
function named(key: string, sessionId: string): void {
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: { ...s.sessions[key], sessionId } },
  }));
}
const first = (): Ticket => useApp.getState().tickets[0];
const reportedEvents = (t: Ticket): number => t.events.filter((e) => e.type === 'reported').length;

async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ok()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* ============================================================
   init: reconcile, idempotence, binding check
   ============================================================ */

test('init folds in the reports the window missed, and a second init adds nothing', () => {
  reset();
  const out = capture(KEY);
  install(ticketAt('running'));

  const binding = { id: 'tk-1', title: 'T', brief: 'do the thing', reports: [wireReport('r-blocked')] };
  deliver(KEY, initMsg('S1', 18, binding));

  assert.equal(first().status, 'needs_you', 'the missed blocked report moved the Ticket');
  assert.equal(first().lastReport?.reportId, 'r-blocked');
  assert.equal(first().lastReport?.sessionId, 'S1', 'init\u2019s session id fills the report in');
  assert.equal(reportedEvents(first()), 1);
  assert.deepEqual(useApp.getState().sessions[KEY].ticketBinding, { id: 'tk-1', title: 'T', brief: 'do the thing' });
  assert.equal(binds(out).length, 0, 'the binding still holds: nothing is cleared');

  const before = first();
  deliver(KEY, initMsg('S1', 18, binding));
  assert.equal(first(), before, 'a repeat changes nothing, not even the object');
  assert.equal(reportedEvents(first()), 1);
  unregisterRuntime(KEY);
});

test('a report that arrived live is not recorded again when init replays it', () => {
  reset();
  capture(KEY);
  install(ticketAt('running'));
  deliver(KEY, {
    v: 1, t: 'ui', kind: 'ticket_report', ticket_id: 'tk-1', report_id: 'r9', session_id: 'S1',
    status: 'done', summary: 'did it', question: null, evidence: ['npm test'], at_ms: 4_000,
  });
  assert.equal(first().status, 'review');
  deliver(KEY, initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [wireReport('r9', { status: 'done', question: null })] }));
  assert.equal(reportedEvents(first()), 1, 'folded once, by id');
  unregisterRuntime(KEY);
});

test('a stale binding is cleared with ticket_bind null, and only after the reports were folded in', () => {
  reset();
  // The Ticket was dropped while the session was closed; the session still
  // holds its binding and one report the window never saw.
  const seenAtSend: Array<string | undefined> = [];
  const out = capture(KEY, (m) => {
    if (m.t === 'ticket_bind') seenAtSend.push(useApp.getState().tickets[0]?.lastReport?.reportId);
  });
  install(ticketAt('dropped'));
  deliver(KEY, initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [wireReport('r-late', { status: 'done', question: null })] }));

  assert.equal(binds(out).length, 1);
  assert.equal(binds(out)[0].ticket, null);
  assert.deepEqual(seenAtSend, ['r-late'], 'the report was already in the Ticket when the unbind went out');
  assert.equal(first().status, 'dropped', 'a dropped Ticket records the report but does not move');
  unregisterRuntime(KEY);
});

test('a binding to a Ticket that is gone, or that belongs to another session, is cleared', () => {
  reset();
  const out = capture(KEY);
  install(ticketAt('running', { sessionId: 'S-other', sessionKey: 'k-x' }));

  deliver(KEY, initMsg('S1', 18, { id: 'tk-404', title: 'x', brief: 'x', reports: [] }));
  assert.equal(binds(out).length, 1, 'no such Ticket');

  deliver(KEY, initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [] }));
  assert.equal(binds(out).length, 2, 'its Assignment is another session');
  assert.equal(first().status, 'running');
  unregisterRuntime(KEY);
});

test('an unbound session is left alone, and so is one on a runtime older than protocol 18', () => {
  reset();
  const out = capture(KEY);
  install(ticketAt('running'));

  deliver(KEY, initMsg('S1', 18, null));
  deliver(KEY, initMsg('S1', 18)); // the key absent, as an old runtime sends it
  assert.equal(useApp.getState().sessions[KEY].ticketBinding, null);
  assert.equal(binds(out).length, 0);

  const before = first();
  deliver(KEY, initMsg('S1', 17, { id: 'tk-1', title: 'T', brief: 'b', reports: [wireReport('r1')] }));
  assert.equal(first(), before, 'protocol 17: nothing reconciled');
  assert.equal(binds(out).length, 0, 'and nothing sent to a runtime that would drop it');
  unregisterRuntime(KEY);
});

test('a hand-resumed session teaches the Assignment its new key; a fresh one its id', () => {
  reset();
  // /resume: the Assignment knows the id from last run, the key is new.
  useApp.setState((s) => ({
    sessions: { ...s.sessions, 'k-new': createSessionBucket('k-new', 'C:/work', { ericai: false, maxSteps: null }, null) },
    order: [...s.order, 'k-new'],
  }));
  capture('k-new');
  install(ticketAt('review', { sessionKey: 'k-gone', sessionId: 'S1' }));
  deliver('k-new', initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [] }));
  assert.equal(currentAssignment(first())?.executor.sessionKey, 'k-new');
  assert.equal(currentAssignment(first())?.executor.sessionId, 'S1');

  const settled = first();
  deliver('k-new', initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [] }));
  assert.equal(first(), settled, 'back-filling twice is a no-op');

  // A fresh start: the key is the Assignment's, the id is not known yet.
  install(ticketAt('running', { sessionId: '', sessionKey: KEY }));
  capture(KEY);
  deliver(KEY, initMsg('S-fresh', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [] }));
  assert.equal(currentAssignment(first())?.executor.sessionId, 'S-fresh');
  unregisterRuntime(KEY);
  unregisterRuntime('k-new');
});

/* ============================================================
   ui(ticket_report)
   ============================================================ */

test('ui(ticket_report) moves a running Ticket to review, and a repeat does nothing', () => {
  reset();
  capture(KEY);
  install(ticketAt('running'));
  const msg = {
    v: 1, t: 'ui', kind: 'ticket_report', ticket_id: 'tk-1', report_id: 'r7', session_id: 'S1',
    status: 'done', summary: 'shipped', question: null, evidence: ['PR #1'], at_ms: 4_000,
  };
  deliver(KEY, msg);
  assert.equal(first().status, 'review');
  assert.deepEqual(first().lastReport?.evidence, ['PR #1']);
  const settled = first();
  deliver(KEY, msg);
  assert.equal(first(), settled);
  unregisterRuntime(KEY);
});

test('a report that beats the Ticket file is held until it is read, not lost', async () => {
  reset();
  capture(KEY);
  ticketFile = serializeTickets([ticketAt('running')]);
  useApp.setState({ tickets: [], ticketsLoaded: false });

  deliver(KEY, {
    v: 1, t: 'ui', kind: 'ticket_report', ticket_id: 'tk-1', report_id: 'r8', session_id: 'S1',
    status: 'blocked', summary: 'stuck', question: 'which db?', evidence: [], at_ms: 4_000,
  });
  await until('the report to land', () => useApp.getState().tickets[0]?.status === 'needs_you');
  assert.equal(useApp.getState().ticketsLoaded, true);
  assert.equal(ticketReads, 1);
  unregisterRuntime(KEY);
});

test('an init that beats the Ticket file is held too, and then reconciles', async () => {
  reset();
  const out = capture(KEY);
  ticketFile = serializeTickets([ticketAt('running')]);
  useApp.setState({ tickets: [], ticketsLoaded: false });

  deliver(KEY, initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [wireReport('r-early')] }));
  await until('the reconcile to land', () => useApp.getState().tickets[0]?.status === 'needs_you');
  assert.equal(binds(out).length, 0, 'an unread list is never taken for "no such Ticket"');
  unregisterRuntime(KEY);
});

test('a read-only Ticket file never unbinds anything: its empty list is not the person\u2019s', () => {
  reset();
  const out = capture(KEY);
  useApp.setState({ tickets: [], ticketsLoaded: true, ticketsReadOnly: true });
  deliver(KEY, initMsg('S1', 18, { id: 'tk-1', title: 'T', brief: 'b', reports: [] }));
  assert.equal(binds(out).length, 0);
  unregisterRuntime(KEY);
});

/* ============================================================
   runtime_exited
   ============================================================ */

test('an unrequested exit from a dropped SSH link is needs_you, reason disconnected', () => {
  reset();
  capture(KEY);
  named(KEY, 'S1');
  install(ticketAt('running'));
  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'runtime_exited', code: 1, requested: false, reason: 'ssh_closed' } as never);
  assert.equal(first().status, 'needs_you');
  const exit = first().events.filter((e) => e.type === 'assignmentExited').at(-1);
  assert.equal(exit?.data?.reason, 'disconnected');
  assert.equal(currentAssignment(first())?.end, null, 'the Assignment carries on');
  unregisterRuntime(KEY);
});

test('an unrequested exit without a reason is a crash; a requested one moves nothing', () => {
  reset();
  capture(KEY);
  named(KEY, 'S1');
  install(ticketAt('running'));
  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'runtime_exited', code: 0, requested: true } as never);
  assert.equal(first().status, 'running', 'the person closed it: "not connected", not a problem');

  reset();
  capture(KEY);
  named(KEY, 'S1');
  install(ticketAt('running'));
  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'runtime_exited', code: 137, requested: false } as never);
  assert.equal(first().status, 'needs_you');
  assert.equal(first().events.filter((e) => e.type === 'assignmentExited').at(-1)?.data?.reason, 'crashed');
  unregisterRuntime(KEY);
});

test('an exit in review records the event and keeps the status (invariant 6)', () => {
  reset();
  capture(KEY);
  named(KEY, 'S1');
  install(ticketAt('review'));
  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'runtime_exited', code: 1, requested: false } as never);
  assert.equal(first().status, 'review');
  unregisterRuntime(KEY);
});

test('an exit from a child that never named its session cannot move a Ticket that knows its id', () => {
  // The key alone proves nothing: it is a per-run counter, and the Assignment
  // was written by an earlier run. Better "not connected" than a wrong move.
  reset();
  capture(KEY);
  install(ticketAt('running'));
  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'runtime_exited', code: 1, requested: false } as never);
  assert.equal(first().status, 'running');
  unregisterRuntime(KEY);
});

/* ============================================================
   personReplied
   ============================================================ */

test('the person sending a message in the blocked session puts the Ticket back to running', () => {
  reset();
  capture(KEY);
  useApp.getState().applyRuntimeMessage(KEY, initMsg('S1', 18) as never);
  useApp.setState((s) => ({ sessions: { ...s.sessions, [KEY]: { ...s.sessions[KEY], ready: true } } }));
  install(ticketAt('needs_you'));

  useApp.getState().setDraft('use postgres');
  useApp.getState().submitDraft();
  assert.equal(first().status, 'running');
  assert.equal(first().events.at(-1)?.type, 'personReplied');
  unregisterRuntime(KEY);
});

test('an exit only ever reaches the Ticket whose session identity matches', () => {
  reset();
  capture(KEY);
  named(KEY, 'S1');
  // Two live Tickets, both `running`, each with its own session. An exit from
  // S1 must not touch the other, and the caller is the one that knows which
  // session ended — the machine's `owns` still runs, but walking every open
  // Ticket to have all but one refuse is work that can be skipped.
  const mine = ticketAt('running', { sessionId: 'S1' });
  const other = ticketAt('running', { sessionId: 'S2', sessionKey: 'k-other' }, 'tk-other');
  install(mine, other);

  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'runtime_exited', code: 1, requested: false } as never);
  assert.equal(useApp.getState().tickets[0].status, 'needs_you', 'S1\u2019s Ticket moved');
  assert.equal(useApp.getState().tickets[1].status, 'running', 'S2\u2019s Ticket did not');
  assert.equal(
    useApp.getState().tickets[1].events.filter((e) => e.type === 'assignmentExited').length,
    0,
    'and no event was recorded for it either',
  );
  unregisterRuntime(KEY);
});

test('the person\u2019s reply is not lost when it beats the Ticket file', async () => {
  reset();
  capture(KEY);
  useApp.getState().applyRuntimeMessage(KEY, initMsg('S1', 18) as never);
  useApp.setState((s) => ({ sessions: { ...s.sessions, [KEY]: { ...s.sessions[KEY], ready: true } } }));

  // The file has not been read yet: this is the first second of a launch, and
  // the person is already typing into a session that is waiting on them. The
  // fact has to wait for the read rather than be dropped for it — the same rule
  // the other three landings follow.
  const blocked = ticketAt('needs_you');
  ticketFile = JSON.stringify({ schema: 1, tickets: [blocked] });
  useApp.setState({ tickets: [], ticketsLoaded: false });

  useApp.getState().setDraft('use postgres');
  useApp.getState().submitDraft();

  await until('the file read to land', () => useApp.getState().ticketsLoaded);
  await until('the reply to move the Ticket', () => first().status === 'running');
  assert.equal(first().events.at(-1)?.type, 'personReplied');
  unregisterRuntime(KEY);
});

test('a message in some other session, or in a Ticket that is not waiting, moves nothing', () => {
  reset();
  capture(KEY);
  capture('k2');
  useApp.setState((s) => ({
    sessions: { ...s.sessions, k2: { ...createSessionBucket('k2', 'C:/work', { ericai: false, maxSteps: null }, null), ready: true, sessionId: 'S2' } },
    order: [...s.order, 'k2'],
    activeKey: 'k2',
  }));
  install(ticketAt('needs_you'));
  useApp.getState().setDraft('hello');
  useApp.getState().submitDraft();
  assert.equal(first().status, 'needs_you', 'S2 is not this Ticket\u2019s session');

  // A review Ticket whose own session hears the person: not waiting, no event.
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [KEY]: { ...s.sessions[KEY], ready: true, sessionId: 'S1' } },
    activeKey: KEY,
  }));
  install(ticketAt('review'));
  const before = first();
  useApp.getState().setDraft('thanks');
  useApp.getState().submitDraft();
  assert.equal(first(), before, 'review is untouched, and no event is recorded for every message');
  unregisterRuntime(KEY);
  unregisterRuntime('k2');
});

/* ============================================================
   Notifications
   ============================================================ */

test('only entering needs_you or review is news', () => {
  const all: TicketStatus[] = ['open', 'running', 'needs_you', 'review', 'done', 'dropped'];
  assert.equal(ticketNotifyReason('running', 'needs_you'), 'needs-you');
  assert.equal(ticketNotifyReason('running', 'review'), 'review');
  assert.equal(ticketNotifyReason('needs_you', 'review'), 'review');
  assert.equal(ticketNotifyReason(undefined, 'needs_you'), null, 'first sight is not a transition');
  for (const status of all) {
    assert.equal(ticketNotifyReason(status, status), null, `${status} unchanged`);
  }
  for (const next of ['open', 'running', 'done', 'dropped'] as TicketStatus[]) {
    assert.equal(ticketNotifyReason('review', next), null, `leaving review for ${next}`);
  }
});

const row = (status: TicketStatus, key = KEY) => ({ ticketId: 'tk-1', status, key, sessionId: 'S1' });
const snap = (status: TicketStatus, activeKey = '', key = KEY) => ({ activeKey, rows: [row(status, key)] });

test('the watcher speaks once per entry, and not while the Assignment\u2019s session is being looked at', () => {
  const on = { enabled: true, windowForeground: true };
  let seen = new Map<string, TicketStatus>();

  let pass = ticketNotifyPass(seen, snap('running', 'k-other'), on);
  assert.equal(pass.say.length, 0);
  seen = pass.next;

  pass = ticketNotifyPass(seen, snap('needs_you', 'k-other'), on);
  assert.deepEqual(pass.say.map((n) => n.reason), ['needs-you'], 'entered, another session on screen');
  seen = pass.next;

  pass = ticketNotifyPass(seen, snap('needs_you', 'k-other'), on);
  assert.equal(pass.say.length, 0, 'the same state again says nothing');
  seen = pass.next;

  pass = ticketNotifyPass(seen, snap('review', KEY), on);
  assert.equal(pass.say.length, 0, 'the person is reading that very conversation');
  seen = pass.next;

  // Looking at it with the window minimized is not looking.
  pass = ticketNotifyPass(new Map([['tk-1', 'running']]), snap('review', KEY), { enabled: true, windowForeground: false });
  assert.deepEqual(pass.say.map((n) => n.reason), ['review']);

  // The board holds the column: nobody is reading the session behind it
  // (`selectTicketNotifyKey` blanks the active key then).
  pass = ticketNotifyPass(new Map([['tk-1', 'running']]), snap('review', ''), on);
  assert.deepEqual(pass.say.map((n) => n.reason), ['review']);

  // No session open at all: nothing can be "watched".
  pass = ticketNotifyPass(new Map([['tk-1', 'running']]), snap('review', KEY, ''), on);
  assert.equal(pass.say.length, 1);
});

test('switched off, the watcher still remembers, so switching on does not replay the gap', () => {
  const off = ticketNotifyPass(new Map([['tk-1', 'running']]), snap('needs_you'), { enabled: false, windowForeground: true });
  assert.equal(off.say.length, 0);
  assert.equal(off.next.get('tk-1'), 'needs_you');
  const on = ticketNotifyPass(off.next, snap('needs_you'), { enabled: true, windowForeground: true });
  assert.equal(on.say.length, 0);
});

test('the watched string reflects status and which session would show it, and round-trips', () => {
  reset();
  install(ticketAt('review'));
  // Before the handshake the bucket has no id, so the Assignment (which knows
  // S1) cannot be matched to it: no key, but the saved id still travels.
  const early = decodeTicketNotifySnapshot(selectTicketNotifyKey(useApp.getState()));
  assert.equal(early.activeKey, KEY);
  assert.deepEqual(early.rows, [{ ticketId: 'tk-1', status: 'review', key: '', sessionId: 'S1' }]);
  useApp.setState((s) => ({ sessions: { ...s.sessions, [KEY]: { ...s.sessions[KEY], sessionId: 'S1' } } }));
  const state = decodeTicketNotifySnapshot(selectTicketNotifyKey(useApp.getState()));
  assert.equal(state.activeKey, KEY);
  assert.deepEqual(state.rows, [{ ticketId: 'tk-1', status: 'review', key: KEY, sessionId: 'S1' }]);

  useApp.setState({ board: 'tickets' });
  assert.equal(decodeTicketNotifySnapshot(selectTicketNotifyKey(useApp.getState())).activeKey, '', 'a board over the column is not looking');

  // A closed session: no key, but the saved id travels for the click.
  useApp.setState({ board: null, sessions: {}, order: [], activeKey: null });
  const closed = decodeTicketNotifySnapshot(selectTicketNotifyKey(useApp.getState()));
  assert.deepEqual(closed.rows, [{ ticketId: 'tk-1', status: 'review', key: '', sessionId: 'S1' }]);

  const text = encodeTicketNotifySnapshot(closed);
  assert.deepEqual(decodeTicketNotifySnapshot(text), closed);
  assert.deepEqual(decodeTicketNotifySnapshot('garbage'), { activeKey: 'garbage', rows: [] });
});

test('the toast names the Ticket and says what is being asked', () => {
  const t = makeT();
  const blocked = ticketAt('needs_you');
  const content = ticketNotifyContent(t, 'needs-you', blocked);
  assert.equal(content.title, t('ticket.notify.needsYou'));
  assert.equal(content.body, 'T\nq?');

  const review = ticketNotifyContent(t, 'review', ticketAt('review'));
  assert.equal(review.title, t('ticket.notify.review'));
  assert.equal(review.body, 'T\ndid it');

  const lost = apply(ticketAt('running'), {
    type: 'assignmentExited', at: 4_000, sessionKey: KEY, sessionId: 'S1', requested: false, reason: 'disconnected',
  });
  assert.ok(lost.ok);
  assert.equal(ticketNotifyContent(t, 'needs-you', lost.ticket).body, `T\n${t('ticket.cause.disconnected')}`);
});

/* ============================================================
   ui(ticket_turn_end) and init.ticket.turn_ends (protocol 21, design 5.5)
   ============================================================ */

const wireTurnEnd = (id: string, atMs: number): Record<string, unknown> => ({ turn_id: id, at_ms: atMs });

test('a live ticket_turn_end moves a running Ticket to review once, by turn id', () => {
  reset();
  capture(KEY);
  install(ticketAt('running'));
  const msg = {
    v: 1, t: 'ui', kind: 'ticket_turn_end', ticket_id: 'tk-1', turn_id: 'run-1', session_id: 'S1', at_ms: 4_000,
  };
  deliver(KEY, msg);
  assert.equal(first().status, 'review');
  assert.equal(first().events.filter((e) => e.type === 'turnEndedUnreported').length, 1);
  const before = first();
  deliver(KEY, msg);
  assert.equal(first(), before, 'a redelivery changes nothing, not even the object');
  unregisterRuntime(KEY);
});

test('a ticket_turn_end from another session or for another Ticket does not move anything', () => {
  reset();
  capture(KEY);
  install(ticketAt('running'));
  const before = first();
  deliver(KEY, {
    v: 1, t: 'ui', kind: 'ticket_turn_end', ticket_id: 'tk-1', turn_id: 'run-1', session_id: 'S-other', at_ms: 4_000,
  });
  deliver(KEY, {
    v: 1, t: 'ui', kind: 'ticket_turn_end', ticket_id: 'tk-404', turn_id: 'run-2', session_id: 'S1', at_ms: 4_000,
  });
  deliver(KEY, { v: 1, t: 'ui', kind: 'ticket_turn_end', ticket_id: 'tk-1', session_id: 'S1', at_ms: 4_000 });
  assert.equal(first(), before);
  unregisterRuntime(KEY);
});

test('init folds in the turn ends and reports the window missed, merged by time', () => {
  reset();
  capture(KEY);
  install(ticketAt('running'));
  // Stopped unreported at 4_000, then a blocked report at 5_000 (arrives in review: recorded only).
  deliver(KEY, initMsg('S1', 21, {
    id: 'tk-1', title: 'T', brief: 'b',
    reports: [wireReport('r-b', { at_ms: 5_000 })],
    turn_ends: [wireTurnEnd('run-1', 4_000)],
  }));
  assert.equal(first().status, 'review');
  assert.equal(first().lastReport?.reportId, 'r-b');

  // A blocked report first, then the turn end: needs_you stays.
  reset();
  capture(KEY);
  install(ticketAt('running'));
  deliver(KEY, initMsg('S1', 21, {
    id: 'tk-1', title: 'T', brief: 'b',
    reports: [wireReport('r-b', { at_ms: 4_000 })],
    turn_ends: [wireTurnEnd('run-1', 5_000)],
  }));
  assert.equal(first().status, 'needs_you');

  // An older runtime has no turn_ends key at all.
  reset();
  capture(KEY);
  install(ticketAt('running'));
  deliver(KEY, initMsg('S1', 20, { id: 'tk-1', title: 'T', brief: 'b', reports: [] }));
  assert.equal(first().status, 'running');
  unregisterRuntime(KEY);
});

test('the review toast does not read the previous round\u2019s summary after an unreported stop', () => {
  const t = makeT();
  const sentBack = apply(ticketAt('review'), { type: 'sendBack', at: 3_500, feedback: 'again' });
  assert.ok(sentBack.ok);
  const stopped = apply(sentBack.ticket, {
    type: 'turnEnded', at: 4_000, turnEnd: { turnId: 'run-2', sessionId: 'S1', atMs: 4_000 },
  });
  assert.ok(stopped.ok);
  assert.equal(stopped.ticket.status, 'review');
  assert.equal(ticketNotifyContent(t, 'review', stopped.ticket).body, `T\n${t('ticket.cause.unreported')}`);
});
