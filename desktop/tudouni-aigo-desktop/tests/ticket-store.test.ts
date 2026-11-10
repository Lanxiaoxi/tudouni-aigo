/**
 * The Ticket file and the slice that holds it in memory.
 *
 * Three rules are asserted, each invisible when wrong:
 *
 *   - **A file this build cannot fully understand is never written over.** A
 *     newer schema (or text that is not JSON, or a read that failed) loads
 *     read-only; the write that would replace the person's Tickets with this
 *     window's empty list simply must not happen.
 *   - **Reconcile is idempotent.** It runs on every open of a bound session, so
 *     running it twice has to be the same as running it once — in the Ticket and
 *     in the file.
 *   - **Nothing mutates before the file has been read.** An action on an
 *     unloaded list would write a list this window never saw.
 *
 * Driven against a fake Tauri host that keeps the file in a variable, the same
 * way `desktop-data.test.ts` does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppStore } from '@/state/store';
import { apply } from '@/ticket/machine';
import { emptyTicket, type Report, type Ticket, type TurnEnd } from '@/ticket/model';
import {
  loadTickets,
  parseTicketFile,
  reconcile,
  resetTicketStoreForTests,
  saveTickets,
  serializeTickets,
  ticketWritesSettled,
} from '@/ticket/store';

/* ============================================================
   The host: the file in a variable
   ============================================================ */

let fileText: string | null = null;
let writes: string[] = [];
let refuseWrite = false;
let failRead = false;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args?: Record<string, unknown>) {
      if (cmd === 'tickets_read') {
        return failRead ? Promise.reject(new Error('access denied')) : Promise.resolve(fileText);
      }
      if (cmd === 'tickets_write') {
        if (refuseWrite) return Promise.reject(new Error('disk is full'));
        fileText = args?.text as string;
        writes.push(fileText);
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    },
  },
};

function reset(): void {
  resetTicketStoreForTests();
  fileText = null;
  writes = [];
  refuseWrite = false;
  failRead = false;
  console.warn = () => undefined;
  console.error = () => undefined;
}

const T0 = 5_000;
let clock = T0;
const tick = (): number => (clock += 10);

function runningTicket(): Ticket {
  let t: Ticket = { ...emptyTicket(T0), brief: 'do the thing' };
  const r1 = apply(t, {
    type: 'start',
    at: tick(),
    assignmentId: 'as-1',
    sessionKey: 'k1',
    remoteWorkspaceId: null,
  });
  assert.ok(r1.ok);
  t = r1.ticket;
  const r2 = apply(t, { type: 'assignmentStarted', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
  assert.ok(r2.ok);
  return r2.ticket;
}

const rep = (id: string, status: 'done' | 'blocked' = 'done', sessionId = 'S1'): Report => ({
  reportId: id,
  sessionId,
  status,
  summary: 's',
  question: status === 'blocked' ? 'q?' : null,
  evidence: ['npm test'],
  atMs: tick(),
});

/* ============================================================
   The file's text
   ============================================================ */

test('no file is an empty, writable list', () => {
  assert.deepEqual(parseTicketFile(null), { tickets: [], readOnly: false, problem: null, dropped: 0 });
});

test('a round trip through the file keeps every Ticket and the schema', () => {
  const tickets = [runningTicket(), { ...emptyTicket(T0 + 1), brief: 'b' }];
  const text = serializeTickets(tickets);
  assert.equal(JSON.parse(text).schema, 1);
  const loaded = parseTicketFile(text);
  assert.equal(loaded.readOnly, false);
  assert.deepEqual(loaded.tickets, tickets);
});

test('a malformed record is dropped whole; the good ones load', () => {
  const good = runningTicket();
  const text = JSON.stringify({
    schema: 1,
    tickets: [good, { id: 'tk-bad', status: 'running' }, null, 'x', { ...good, status: 'paused', id: 'tk-2' }],
  });
  const loaded = parseTicketFile(text);
  assert.deepEqual(loaded.tickets, [good]);
  assert.equal(loaded.dropped, 4);
  assert.equal(loaded.readOnly, false, 'a few bad records are not a reason to refuse writes');
});

test('a duplicated id keeps the first', () => {
  const a = runningTicket();
  const b = { ...a, title: 'second' };
  const loaded = parseTicketFile(JSON.stringify({ schema: 1, tickets: [a, b] }));
  assert.equal(loaded.tickets.length, 1);
  assert.equal(loaded.tickets[0].title, '');
  assert.equal(loaded.dropped, 1);
});

test('a newer schema loads what it can and is read-only', () => {
  const good = runningTicket();
  const loaded = parseTicketFile(JSON.stringify({ schema: 2, tickets: [good], extra: true }));
  assert.equal(loaded.readOnly, true);
  assert.match(loaded.problem ?? '', /newer version/);
  assert.equal(loaded.tickets.length, 1, 'still shown, never written');
});

test('text that is not a Ticket file is read-only, not an empty shelf', () => {
  for (const text of ['{ nope', '[]', '"x"', '{"tickets": []}', '{"schema": "1", "tickets": []}', '{"schema": 0}']) {
    const loaded = parseTicketFile(text);
    assert.equal(loaded.readOnly, true, text);
    assert.deepEqual(loaded.tickets, [], text);
    assert.notEqual(loaded.problem, null, text);
  }
});

/* ============================================================
   Reconcile
   ============================================================ */

test('reconcile folds in reports the Ticket has not seen, in order', () => {
  const t = runningTicket();
  const blocked = rep('r1', 'blocked');
  const done = rep('r2', 'done');
  const out = reconcile(t, [blocked, done]);
  // r1 blocked the running Ticket; r2 arrives under needs_you, so it is
  // recorded but does not move it again (invariant 5).
  assert.equal(out.status, 'needs_you');
  assert.equal(out.events.filter((e) => e.type === 'reported').length, 2);
  assert.equal(out.lastReport?.reportId, 'r2');
});

test('reconcile is idempotent: a second run returns the very same object', () => {
  const t = runningTicket();
  const reports = [rep('r1', 'done')];
  const once = reconcile(t, reports);
  assert.equal(once.status, 'review');
  const twice = reconcile(once, reports);
  assert.equal(twice, once);
  assert.equal(reconcile(once, []), once, 'nothing to fold is nothing done');
});

test('reconcile skips what live delivery already brought', () => {
  const t = runningTicket();
  const r = rep('r1', 'done');
  const live = apply(t, { type: 'reported', at: r.atMs, report: r });
  assert.ok(live.ok);
  const out = reconcile(live.ticket, [r, rep('r2', 'done')]);
  assert.equal(out.events.filter((e) => e.type === 'reported').length, 2, 'r1 once, r2 once');
});

const te = (turnId: string, atMs: number, sessionId = 'S1'): TurnEnd => ({ turnId, sessionId, atMs });
const repAt = (id: string, status: 'done' | 'blocked', atMs: number): Report => ({ ...rep(id, status), atMs });

test('reconcile merges turn ends and reports by time: a turn end, then a later report', () => {
  const out = reconcile(runningTicket(), [repAt('r1', 'done', 2)], [te('t1', 1)]);
  // t1@1 moved running -> review; r1@2 arrives in review: recorded, not applied.
  assert.equal(out.status, 'review');
  assert.equal(out.lastReport?.reportId, 'r1', 'the report is the last word');
  assert.deepEqual(
    out.events.filter((e) => e.type === 'turnEndedUnreported' || e.type === 'reported').map((e) => e.type),
    ['turnEndedUnreported', 'reported'],
  );
});

test('reconcile merges by time: a blocked report, then a later turn end', () => {
  const out = reconcile(runningTicket(), [repAt('r1', 'blocked', 1)], [te('t1', 2)]);
  assert.equal(out.status, 'needs_you', 'the turn end after a block changes nothing');
  assert.ok(!out.events.some((e) => e.type === 'turnEndedUnreported'));
});

test('reconcile puts a report before a turn end at the same instant', () => {
  const out = reconcile(runningTicket(), [repAt('r1', 'blocked', 5)], [te('t1', 5)]);
  assert.equal(out.status, 'needs_you');
});

test('reconcile with turn ends is idempotent and skips one already seen live', () => {
  const live = apply(runningTicket(), { type: 'turnEnded', at: 1, turnEnd: te('t1', 1) });
  assert.ok(live.ok);
  const out = reconcile(live.ticket, [], [te('t1', 1)]);
  assert.equal(out, live.ticket);
  assert.equal(reconcile(out, [], [te('t1', 1)]), out);
});

/* ============================================================
   The disk
   ============================================================ */

test('loadTickets reads through the host and saveTickets writes the whole list', async () => {
  reset();
  const t = runningTicket();
  fileText = serializeTickets([t]);
  const loaded = await loadTickets();
  assert.deepEqual(loaded.tickets, [t]);
  assert.equal(await saveTickets([t, { ...emptyTicket(T0 + 2), brief: 'x' }]), true);
  assert.equal(JSON.parse(fileText as string).tickets.length, 2);
});

test('a read-only file is never written', async () => {
  reset();
  fileText = JSON.stringify({ schema: 2, tickets: [] });
  const loaded = await loadTickets();
  assert.equal(loaded.readOnly, true);
  assert.equal(await saveTickets([]), false);
  assert.equal(writes.length, 0);
  assert.equal(fileText, JSON.stringify({ schema: 2, tickets: [] }), 'the file is exactly as it was');
});

test('a failed read is read-only too: an unreadable file is not an empty one', async () => {
  reset();
  failRead = true;
  const loaded = await loadTickets();
  assert.equal(loaded.readOnly, true);
  assert.match(loaded.problem ?? '', /could not be read/);
  assert.equal(await saveTickets([]), false);
  assert.equal(writes.length, 0);
});

test('writes land in the order they were made', async () => {
  reset();
  const base = { ...emptyTicket(T0), brief: 'x' };
  const results = await Promise.all(
    [1, 2, 3, 4].map((n) => saveTickets(Array.from({ length: n }, (_, i) => ({ ...base, id: `tk-${i}` })))),
  );
  assert.deepEqual(results, [true, true, true, true]);
  assert.deepEqual(writes.map((w) => JSON.parse(w).tickets.length), [1, 2, 3, 4]);
});

test('a refused write reports false and does not throw', async () => {
  reset();
  refuseWrite = true;
  assert.equal(await saveTickets([]), false);
});

/* ============================================================
   The slice
   ============================================================ */

async function loadedStore(initial: Ticket[] = []) {
  reset();
  fileText = initial.length === 0 ? null : serializeTickets(initial);
  const store = createAppStore();
  await store.getState().loadTickets();
  return store;
}

test('before the file is read every mutation is refused and nothing is written', async () => {
  reset();
  const s = createAppStore().getState();
  assert.equal(s.ticketsLoaded, false);
  assert.equal(s.createTicket({ brief: 'x' }), null);
  assert.deepEqual(s.dispatchTicket('tk-1', { type: 'drop' }), { ok: false, reason: 'not_loaded' });
  assert.equal(s.deleteTicket('tk-1'), false);
  assert.equal(s.clearFinishedTickets(), 0);
  await ticketWritesSettled();
  assert.equal(writes.length, 0);
});

test('loadTickets fills the list once and shares a concurrent read', async () => {
  reset();
  const t = runningTicket();
  fileText = serializeTickets([t]);
  const store = createAppStore();
  await Promise.all([store.getState().loadTickets(), store.getState().loadTickets()]);
  const s = store.getState();
  assert.equal(s.ticketsLoaded, true);
  assert.equal(s.ticketsReadOnly, false);
  assert.deepEqual(s.tickets, [t]);
  fileText = serializeTickets([]);
  await s.loadTickets();
  assert.deepEqual(store.getState().tickets, [t], 'a second load does not re-read under a running window');
});

test('a read-only file loads as read-only, and every mutation is refused', async () => {
  reset();
  const t = runningTicket();
  fileText = JSON.stringify({ schema: 9, tickets: [t] });
  const store = createAppStore();
  await store.getState().loadTickets();
  const s = store.getState();
  assert.equal(s.ticketsReadOnly, true);
  assert.deepEqual(s.tickets, [t], 'still shown');
  assert.equal(s.createTicket({ brief: 'x' }), null);
  assert.deepEqual(s.dispatchTicket(t.id, { type: 'drop' }), { ok: false, reason: 'read_only' });
  assert.equal(s.deleteTicket(t.id), false);
  assert.equal(s.clearFinishedTickets(), 0);
  await ticketWritesSettled();
  assert.equal(writes.length, 0);
});

test('createTicket makes an open Ticket and persists it', async () => {
  const store = await loadedStore();
  const id = store.getState().createTicket({ brief: 'fix it', title: 'Fix', model: 'm' });
  assert.ok(id);
  const t = store.getState().tickets[0];
  assert.equal(t.id, id);
  assert.equal(t.status, 'open');
  assert.equal(t.title, 'Fix');
  assert.deepEqual(t.workspace, { kind: 'active' });
  assert.deepEqual(t.events.map((e) => e.type), ['created']);
  await ticketWritesSettled();
  assert.equal(JSON.parse(fileText as string).tickets[0].id, id);
});

test('dispatchTicket runs the machine, persists on success, and returns a refusal as a reason', async () => {
  const store = await loadedStore();
  const id = store.getState().createTicket({ brief: 'go' }) as string;
  await ticketWritesSettled();
  writes = [];

  // A refused command changes and writes nothing.
  assert.deepEqual(store.getState().dispatchTicket(id, { type: 'accept' }), { ok: false, reason: 'wrong_status' });
  assert.equal(store.getState().tickets[0].status, 'open');
  await ticketWritesSettled();
  assert.equal(writes.length, 0);

  const started = store.getState().dispatchTicket(id, {
    type: 'start',
    assignmentId: 'as-1',
    sessionKey: 'k1',
    remoteWorkspaceId: null,
  });
  assert.equal(started.ok, true);
  assert.equal(store.getState().tickets[0].status, 'running');
  await ticketWritesSettled();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(fileText as string).tickets[0].status, 'running');

  assert.deepEqual(store.getState().dispatchTicket('tk-missing', { type: 'drop' }), { ok: false, reason: 'not_found' });
});

test('a fact with nothing to record writes nothing', async () => {
  const store = await loadedStore();
  const id = store.getState().createTicket({ brief: 'go' }) as string;
  store.getState().dispatchTicket(id, { type: 'start', assignmentId: 'as-1', sessionKey: 'k1', remoteWorkspaceId: null });
  store.getState().dispatchTicket(id, { type: 'assignmentStarted', sessionKey: 'k1', sessionId: 'S1' });
  await ticketWritesSettled();
  writes = [];
  // The person speaks in a session whose Ticket is not waiting.
  const r = store.getState().dispatchTicket(id, { type: 'personReplied', sessionId: 'S1' });
  assert.equal(r.ok, true);
  await ticketWritesSettled();
  assert.equal(writes.length, 0);
});

test('updateTicketDraft goes through the edit command and never writes status', async () => {
  const store = await loadedStore();
  const id = store.getState().createTicket({ brief: 'a' }) as string;
  const r = store.getState().updateTicketDraft(id, { brief: 'b', title: 'T' });
  assert.equal(r.ok, true);
  const t = store.getState().tickets[0];
  assert.equal(t.brief, 'b');
  assert.equal(t.status, 'open');
  assert.equal(t.events.at(-1)?.type, 'edited');
  assert.deepEqual(store.getState().updateTicketDraft(id, { workspace: { kind: 'remote', id: '' } }), {
    ok: false,
    reason: 'invalid_edit',
  });
});

test('ingestTicketReport is idempotent by report id', async () => {
  const store = await loadedStore([runningTicket()]);
  const id = store.getState().tickets[0].id;
  const r = rep('r1', 'done');
  assert.equal(store.getState().ingestTicketReport(id, r).ok, true);
  assert.equal(store.getState().tickets[0].status, 'review');
  await ticketWritesSettled();
  writes = [];
  const before = store.getState().tickets[0];
  assert.equal(store.getState().ingestTicketReport(id, r).ok, true);
  assert.equal(store.getState().tickets[0], before, 'same object');
  await ticketWritesSettled();
  assert.equal(writes.length, 0, 'a duplicate costs no write');
});

test('reconcileTicket folds in the missing reports, once', async () => {
  const store = await loadedStore([runningTicket()]);
  const id = store.getState().tickets[0].id;
  const reports = [rep('r1', 'done')];
  store.getState().reconcileTicket(id, reports);
  assert.equal(store.getState().tickets[0].status, 'review');
  await ticketWritesSettled();
  writes = [];
  store.getState().reconcileTicket(id, reports);
  await ticketWritesSettled();
  assert.equal(writes.length, 0, 'the second reconcile writes nothing');
  assert.equal(store.getState().tickets[0].events.filter((e) => e.type === 'reported').length, 1);
  assert.deepEqual(store.getState().reconcileTicket('tk-missing', reports), { ok: false, reason: 'not_found' });
});

test('deleteTicket removes one; clearFinishedTickets removes done and dropped only', async () => {
  const store = await loadedStore();
  const s = () => store.getState();
  const a = s().createTicket({ brief: 'a' }) as string;
  const b = s().createTicket({ brief: 'b' }) as string;
  const c = s().createTicket({ brief: 'c' }) as string;
  const d = s().createTicket({ brief: 'd' }) as string;
  s().dispatchTicket(b, { type: 'drop' });
  // c: running -> review -> done.
  s().dispatchTicket(c, { type: 'start', assignmentId: 'as-c', sessionKey: 'kc', remoteWorkspaceId: null });
  s().dispatchTicket(c, { type: 'assignmentStarted', sessionKey: 'kc', sessionId: 'SC' });
  s().ingestTicketReport(c, { ...rep('rc', 'done', 'SC') });
  s().dispatchTicket(c, { type: 'accept' });
  assert.deepEqual(s().tickets.map((t) => t.status), ['open', 'dropped', 'done', 'open']);

  assert.equal(s().clearFinishedTickets(), 2);
  assert.deepEqual(s().tickets.map((t) => t.id), [a, d]);
  assert.equal(s().clearFinishedTickets(), 0);

  assert.equal(s().deleteTicket(a), true);
  assert.equal(s().deleteTicket(a), false);
  assert.deepEqual(s().tickets.map((t) => t.id), [d]);
  await ticketWritesSettled();
  assert.deepEqual(JSON.parse(fileText as string).tickets.map((t: Ticket) => t.id), [d]);
});
