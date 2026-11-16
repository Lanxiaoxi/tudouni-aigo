/**
 * Ticket notes, the desktop half (`docs/design/ticket-notes.md` 4, 7).
 *
 * Three layers, each silent when wrong in a window:
 *
 *   - the machine: a person's `note` command and an agent's `noted` fact, the
 *     ceilings, who may touch whose note, and idempotence by op id;
 *   - the landing: `ui(ticket_note)`, and `init` folding note ops in **with**
 *     reports and turn ends by time;
 *   - the wire: every `ticket_bind` carries the canonical notes (snake_case,
 *     protocol >= 22 only), and a change to them re-binds every live present
 *     session of the worker.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createSessionBucket, useApp } from '@/state/store';
import { registerRuntime, unregisterRuntime } from '@/runtime/bus';
import { createStoreContext } from '@/state/storeContext';
import { noteToWire, rebindTicketNotes } from '@/state/ticketBind';
import { apply, currentAssignment, type TicketInput } from '@/ticket/machine';
import {
  TICKET_NOTES_MAX,
  TICKET_NOTES_TOTAL_CEILING,
  TICKET_NOTE_TEXT_CEILING,
  emptyTicket,
  isValidTicket,
  noteWriteProblem,
  type Report,
  type Ticket,
  type TicketNote,
} from '@/ticket/model';
import { parseTicketFile, resetTicketStoreForTests, serializeTickets } from '@/ticket/store';

/* ============================================================
   The host
   ============================================================ */

let nextKey = 900;
let stageCalls = 0;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'runtime_attach') return Promise.resolve(nextKey++);
      if (cmd === 'ticket_attachments_stage') {
        stageCalls += 1;
        return Promise.resolve(
          (args.names as string[]).map((name) => ({
            name,
            path: `.tudouni/ticket-attachments/${String(args.ticketId)}/${name}`,
            bytes: 10,
          })),
        );
      }
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  },
};

/* ============================================================
   Machine fixtures
   ============================================================ */

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

/** Running, with S1 on it. */
function running(): Ticket {
  const started = ok(
    { ...emptyTicket(1_000), brief: 'do it' },
    { type: 'start', at: tick(), assignmentId: 'as-1', ...fields(1) },
  );
  return ok(started, { type: 'sessionStarted', at: tick(), sessionKey: 'k1', sessionId: 'S1' });
}
/** Running with S1 and S2 on it. */
function two(): Ticket {
  const added = ok(running(), { type: 'newSession', at: tick(), ...fields(2) });
  return ok(added, { type: 'sessionStarted', at: tick(), sessionKey: 'k2', sessionId: 'S2' });
}

const addNote = (id: string, text: string, at = tick()): TicketInput => ({
  type: 'note',
  at,
  op: 'add',
  text,
  noteIdMinted: id,
});
const noted = (
  opId: string,
  op: 'add' | 'update' | 'remove',
  noteId: string,
  text: string | null,
  sessionId: string,
  at = tick(),
): TicketInput => ({ type: 'noted', at, opId, op, noteId, text, sessionId });

const lastEvent = (t: Ticket) => t.events[t.events.length - 1];

/* ============================================================
   A person's `note` command
   ============================================================ */

test('a person adds, edits and deletes a note; the event records the id and the op, never the text', () => {
  const secret = 'the-decision-text-that-must-not-be-in-the-history';
  let t = ok(running(), addNote('nt-1', `  ${secret}  `, 5_000));
  assert.equal(t.notes.length, 1);
  assert.deepEqual(t.notes[0], {
    id: 'nt-1',
    text: secret,
    author: 'person',
    createdAtMs: 5_000,
    updatedAtMs: 5_000,
  });
  assert.equal(t.status, 'running', 'a note moves no status');
  assert.deepEqual(lastEvent(t).data, { noteId: 'nt-1', op: 'add' });

  t = ok(t, { type: 'note', at: 6_000, op: 'update', noteId: 'nt-1', text: 'changed' });
  assert.equal(t.notes[0].text, 'changed');
  assert.equal(t.notes[0].createdAtMs, 5_000, 'the creation time stays: the card orders by it');
  assert.equal(t.notes[0].updatedAtMs, 6_000);
  assert.deepEqual(lastEvent(t).data, { noteId: 'nt-1', op: 'update' });

  t = ok(t, { type: 'note', at: 7_000, op: 'remove', noteId: 'nt-1' });
  assert.deepEqual(t.notes, []);
  assert.deepEqual(lastEvent(t).data, { noteId: 'nt-1', op: 'remove' });

  assert.equal(JSON.stringify(t.events).includes(secret), false, 'events are capped by count, not size');
  assert.equal(JSON.stringify(t.events).includes('changed'), false);
});

test('a note is allowed in every status, and a person may edit or delete any note', () => {
  const open = ok({ ...emptyTicket(1), brief: 'b' }, addNote('nt-o', 'on an open Ticket'));
  assert.equal(open.notes.length, 1);

  const review = ok(running(), {
    type: 'reported',
    at: tick(),
    report: { reportId: 'r', sessionId: 'S1', status: 'done', summary: 's', question: null, evidence: [], atMs: tick() } as Report,
  });
  assert.equal(review.status, 'review');
  assert.equal(ok(review, addNote('nt-r', 'in review')).notes.length, 1);

  const done = ok(review, { type: 'accept', at: tick() });
  const withNote = ok(done, addNote('nt-d', 'after the fact'));
  assert.equal(withNote.status, 'done', 'still done');
  const dropped = ok(ok(running(), { type: 'drop', at: tick() }), addNote('nt-x', 'on a dropped one'));
  assert.equal(dropped.status, 'dropped');

  // The agent's note can be rewritten and removed by the person.
  const withAgent = ok(two(), noted('op-1', 'add', 'nt-a', 'agent wrote this', 'S2'));
  const edited = ok(withAgent, { type: 'note', at: tick(), op: 'update', noteId: 'nt-a', text: 'person rewrote it' });
  assert.equal(edited.notes[0].text, 'person rewrote it');
  assert.equal(edited.notes[0].author, 'agent', 'authorship is history, not a lock');
  assert.deepEqual(ok(edited, { type: 'note', at: tick(), op: 'remove', noteId: 'nt-a' }).notes, []);
});

test('a note that is empty, malformed or names nothing is refused with a reason', () => {
  const t = ok(running(), addNote('nt-1', 'first'));
  assert.equal(refused(t, addNote('nt-2', '   ')), 'empty_note');
  assert.equal(refused(t, { type: 'note', at: tick(), op: 'add', text: 'no id' }), 'invalid_note');
  assert.equal(refused(t, addNote('nt-1', 'same id again')), 'invalid_note', 'ids are unique');
  assert.equal(refused(t, { type: 'note', at: tick(), op: 'update', noteId: 'nt-404', text: 'x' }), 'unknown_note');
  assert.equal(refused(t, { type: 'note', at: tick(), op: 'remove', noteId: 'nt-404' }), 'unknown_note');
  assert.equal(refused(t, { type: 'note', at: tick(), op: 'update', noteId: 'nt-1', text: '' }), 'empty_note');
  assert.equal(refused(t, { type: 'note', at: tick(), op: 'update', noteId: 'nt-1' }), 'invalid_note');
  assert.equal(refused(t, { type: 'note', at: tick(), op: 'nope' as never }), 'invalid_note');

  // Saving the same words again records nothing.
  const same = apply(t, { type: 'note', at: tick(), op: 'update', noteId: 'nt-1', text: ' first ' });
  assert.equal(same.ok && same.ticket === t, true);
});

test('the three ceilings are enforced, in code points like the runtime counts', () => {
  const base = ok(running(), addNote('nt-0', 'seed'));

  // One note: 4000 allowed, 4001 not.
  assert.equal(ok(base, addNote('nt-a', 'x'.repeat(TICKET_NOTE_TEXT_CEILING))).notes.length, 2);
  assert.equal(refused(base, addNote('nt-b', 'x'.repeat(TICKET_NOTE_TEXT_CEILING + 1))), 'note_too_long');
  // An emoji is two UTF-16 units and one rune: 4000 of them fit.
  assert.equal(ok(base, addNote('nt-e', '😀'.repeat(TICKET_NOTE_TEXT_CEILING))).notes.length, 2);
  assert.equal(refused(base, addNote('nt-f', '😀'.repeat(TICKET_NOTE_TEXT_CEILING + 1))), 'note_too_long');

  // The total: three full notes are exactly the ceiling, one more character is not.
  let full = running();
  for (const id of ['a', 'b', 'c']) full = ok(full, addNote(`nt-${id}`, id.repeat(TICKET_NOTE_TEXT_CEILING)));
  assert.equal(
    full.notes.reduce((n, note) => n + note.text.length, 0),
    TICKET_NOTES_TOTAL_CEILING,
  );
  assert.equal(refused(full, addNote('nt-d', 'd')), 'notes_total');
  // Rewriting a note is judged without its own old text, so it can be replaced
  // by one of the same size but not grown.
  assert.equal(ok(full, { type: 'note', at: tick(), op: 'update', noteId: 'nt-a', text: 'z'.repeat(TICKET_NOTE_TEXT_CEILING) }).notes.length, 3);
  assert.equal(
    refused(
      ok(full, { type: 'note', at: tick(), op: 'update', noteId: 'nt-a', text: 'short' }),
      { type: 'note', at: tick(), op: 'update', noteId: 'nt-a', text: 'y'.repeat(TICKET_NOTE_TEXT_CEILING + 1) },
    ),
    'note_too_long',
  );
  // Deleting makes room again.
  assert.equal(ok(ok(full, { type: 'note', at: tick(), op: 'remove', noteId: 'nt-a' }), addNote('nt-d', 'd')).notes.length, 3);

  // The count.
  let many = running();
  for (let i = 0; i < TICKET_NOTES_MAX; i += 1) many = ok(many, addNote(`nt-${i}`, 'a'));
  assert.equal(many.notes.length, TICKET_NOTES_MAX);
  assert.equal(refused(many, addNote('nt-over', 'a')), 'notes_full');
  // An edit of an existing one is not an addition.
  assert.equal(ok(many, { type: 'note', at: tick(), op: 'update', noteId: 'nt-0', text: 'b' }).notes.length, TICKET_NOTES_MAX);
  // The same function the box asks while typing.
  assert.equal(noteWriteProblem(many.notes, 'a'), 'notes_full');
  assert.equal(noteWriteProblem(many.notes, 'a', 'nt-0'), null);
});

/* ============================================================
   An agent's `noted` fact
   ============================================================ */

test('noted is accepted from any present session of the current worker and adds an agent note', () => {
  const t = ok(two(), noted('op-1', 'add', 'nt-a1', '  decided on plan B  ', 'S2', 7_000));
  assert.deepEqual(t.notes, [
    { id: 'nt-a1', text: 'decided on plan B', author: 'agent', sessionId: 'S2', createdAtMs: 7_000, updatedAtMs: 7_000 },
  ]);
  assert.deepEqual(lastEvent(t).data, { opId: 'op-1', op: 'add', noteId: 'nt-a1', applied: true });
  assert.equal(t.status, 'running', 'a note moves no status');

  // A different present session may change the agent's note (they are equals).
  const updated = ok(t, noted('op-2', 'update', 'nt-a1', 'plan C', 'S1', 8_000));
  assert.equal(updated.notes[0].text, 'plan C');
  assert.equal(updated.notes[0].sessionId, 'S2', 'the writer of record is the one who added it');
  assert.equal(updated.notes[0].updatedAtMs, 8_000);
  assert.deepEqual(ok(updated, noted('op-3', 'remove', 'nt-a1', null, 'S1')).notes, []);
});

test('noted from a session that is not on the Ticket is an event only', () => {
  const prev = two();
  const removed = ok(prev, { type: 'removeSession', at: tick(), sessionKey: 'k2', sessionId: 'S2' });

  for (const [label, ticket, who] of [
    ['a removed session', removed, 'S2'],
    ['a stranger', prev, 'S-other'],
    ['nobody', prev, ''],
  ] as const) {
    const next = ok(ticket, noted(`op-${label}`, 'add', 'nt-x', 'text', who));
    assert.equal(next.notes, ticket.notes, `${label}: the list is untouched`);
    assert.equal(lastEvent(next).type, 'noted');
    assert.equal(lastEvent(next).data?.applied, false);
    assert.equal(lastEvent(next).data?.skipped, 'foreign');
  }

  // A Ticket with no worker (done) has nobody to speak for it either.
  const review = ok(running(), {
    type: 'reported',
    at: tick(),
    report: { reportId: 'r', sessionId: 'S1', status: 'done', summary: 's', question: null, evidence: [], atMs: tick() } as Report,
  });
  const done = ok(review, { type: 'accept', at: tick() });
  assert.equal(currentAssignment(done), null);
  assert.equal(ok(done, noted('op-d', 'add', 'nt-x', 'late', 'S1')).notes.length, 0);
});

test('an agent cannot change or delete a note a person wrote', () => {
  const t = ok(two(), addNote('nt-p', 'the person\u2019s judgement'));
  for (const op of ['update', 'remove'] as const) {
    const next = ok(t, noted(`op-${op}`, op, 'nt-p', op === 'update' ? 'rewritten' : null, 'S1'));
    assert.equal(next.notes, t.notes, `${op}: untouched`);
    assert.equal(lastEvent(next).data?.applied, false);
    assert.equal(lastEvent(next).data?.skipped, 'author');
  }
  assert.equal(t.notes[0].text, 'the person\u2019s judgement');
});

test('update or remove of an id that is not there is an event, and the notes stay', () => {
  const t = ok(two(), addNote('nt-p', 'kept'));
  for (const op of ['update', 'remove'] as const) {
    const next = ok(t, noted(`op-${op}`, op, 'nt-404', op === 'update' ? 'x' : null, 'S1'));
    assert.equal(next.notes, t.notes);
    assert.equal(lastEvent(next).data?.skipped, 'missing');
  }
  // An add whose id already exists is not a second note.
  const added = ok(t, noted('op-dup', 'add', 'nt-p', 'again', 'S1'));
  assert.equal(added.notes, t.notes);
  assert.equal(lastEvent(added).data?.skipped, 'exists');
});

test('an agent write that does not fit the canonical list is recorded and not stored', () => {
  let t = two();
  for (const id of ['a', 'b', 'c']) t = ok(t, addNote(`nt-${id}`, id.repeat(TICKET_NOTE_TEXT_CEILING)));
  const next = ok(t, noted('op-big', 'add', 'nt-ag', 'one more', 'S1'));
  assert.equal(next.notes, t.notes);
  assert.equal(lastEvent(next).data?.skipped, 'limit');
});

test('noted is idempotent by op id, applied or not, and leaves no text in the history', () => {
  const first = ok(two(), noted('op-1', 'add', 'nt-a', 'agent text', 'S1'));
  const again = apply(first, noted('op-1', 'add', 'nt-a', 'agent text', 'S1'));
  assert.equal(again.ok && again.ticket === first, true, 'the same object: nothing written');

  // A removal that was applied must not be undone by a redelivered add.
  const removed = ok(first, noted('op-2', 'remove', 'nt-a', null, 'S1'));
  const redelivered = apply(removed, noted('op-1', 'add', 'nt-a', 'agent text', 'S1'));
  assert.equal(redelivered.ok && redelivered.ticket === removed, true);
  assert.deepEqual(removed.notes, []);

  // A skipped one is remembered too.
  const skipped = ok(two(), noted('op-s', 'add', 'nt-x', 't', 'S-other'));
  const skippedAgain = apply(skipped, noted('op-s', 'add', 'nt-x', 't', 'S-other'));
  assert.equal(skippedAgain.ok && skippedAgain.ticket === skipped, true);

  assert.equal(JSON.stringify(first.events).includes('agent text'), false);
});

test('a Ticket with notes passes the guard and survives a round trip through the file', () => {
  const t = ok(ok(two(), addNote('nt-p', 'person')), noted('op-1', 'add', 'nt-a', 'agent', 'S2'));
  assert.equal(isValidTicket(t), true);
  const loaded = parseTicketFile(serializeTickets([t]));
  assert.equal(loaded.tickets.length, 1);
  assert.deepEqual(loaded.tickets[0].notes, t.notes);
  assert.equal(
    isValidTicket({ ...t, events: [...t.events, { at: 1, actor: { kind: 'system' }, type: 'noted', data: { opId: 'x' } }] }),
    true,
    'the event types are in the guard',
  );
});

test('the desktop\u2019s note ceilings are the runtime\u2019s', () => {
  const source = readFileSync(resolve(process.cwd(), '..', '..', 'internal', 'state', 'ticket.go'), 'utf8');
  const value = (name: string): number => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    assert.ok(match, `${name} is not declared in internal/state/ticket.go`);
    return Number(match[1]);
  };
  assert.equal(TICKET_NOTE_TEXT_CEILING, value('TicketNoteTextCeiling'));
  assert.equal(TICKET_NOTES_MAX, value('MaxTicketNotes'));
  assert.equal(TICKET_NOTES_TOTAL_CEILING, value('TicketNotesTotalCeiling'));
});

/* ============================================================
   The store: landing, reconcile, rebind
   ============================================================ */

const ctx = createStoreContext(useApp.setState, useApp.getState);
const KEYS = ['k1', 'k2', 'k3', 'k4', 'k-new'];

function reset(): void {
  resetTicketStoreForTests();
  stageCalls = 0;
  for (const key of KEYS) unregisterRuntime(key);
  const sessions: Record<string, ReturnType<typeof createSessionBucket>> = {};
  for (const key of KEYS.slice(0, 4)) {
    sessions[key] = createSessionBucket(key, 'C:/work', { ericai: false, maxSteps: null }, null);
  }
  useApp.setState({
    sessions,
    order: Object.keys(sessions),
    activeKey: 'k1',
    modal: null,
    pendingModals: [],
    panel: null,
    board: null,
    suggestionsEnabled: true,
    startupProblem: null,
    startupNotice: null,
    workspaces: ['C:/work'],
    sshHosts: [],
    remoteWorkspaces: [],
    lastWorkspace: 'C:/work',
    tickets: [],
    ticketsLoaded: true,
    ticketsReadOnly: false,
    ticketsProblem: null,
    ticketSeed: null,
  });
}

function capture(key: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  registerRuntime({
    key,
    send: (m) => out.push(m as unknown as Record<string, unknown>),
    subscribe: () => () => undefined,
    dispose: () => undefined,
  });
  return out;
}
const binds = (out: Record<string, unknown>[]): Record<string, unknown>[] => out.filter((m) => m.t === 'ticket_bind');
const bound = (m: Record<string, unknown>): Record<string, unknown> => m.ticket as Record<string, unknown>;

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
const deliver = (key: string, msg: Record<string, unknown>): void =>
  useApp.getState().applyRuntimeMessage(key, msg as never);

/** What a runtime reports as its binding. Attachments ride along so a re-bind
 *  has something to replay. */
const binding = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'tk-1',
  title: 'T',
  brief: 'do the thing',
  reports: [],
  ...extra,
});

/** A Ticket with S1 (key k1), S2 (k2), S3 (k3) present, all named. */
function threeSessions(): Ticket {
  let t: Ticket = { ...emptyTicket(1_000), id: 'tk-1', title: 'T', brief: 'do the thing' };
  const run = (input: TicketInput): void => {
    const result = apply(t, input);
    if (!result.ok) throw new Error(`refused ${input.type}: ${result.reason}`);
    t = result.ticket;
  };
  run({ type: 'start', at: 2_000, assignmentId: 'as-1', sessionKey: 'k1', remoteWorkspaceId: null, workspace: 'C:/work' });
  run({ type: 'sessionStarted', at: 2_001, sessionKey: 'k1', sessionId: 'S1' });
  for (const [n, id] of [[2, 'S2'], [3, 'S3']] as const) {
    run({ type: 'newSession', at: 2_000 + n * 10, sessionKey: `k${n}`, remoteWorkspaceId: null, workspace: 'C:/work' });
    run({ type: 'sessionStarted', at: 2_001 + n * 10, sessionKey: `k${n}`, sessionId: id });
  }
  return t;
}

/** Open every session of the Ticket on a live child at the given protocol and
 *  forget what the handshake itself sent. */
function openSessions(protocols: Record<string, number>): Record<string, Record<string, unknown>[]> {
  const outs: Record<string, Record<string, unknown>[]> = {};
  const ids: Record<string, string> = { k1: 'S1', k2: 'S2', k3: 'S3', k4: 'S4' };
  for (const [key, protocol] of Object.entries(protocols)) {
    outs[key] = capture(key);
    deliver(
      key,
      initMsg(
        ids[key],
        protocol,
        binding(protocol >= 19 ? { attachments: [{ name: 'log.txt', path: '.tudouni/ticket-attachments/tk-1/log.txt', bytes: 10 }] } : {}),
      ),
    );
    outs[key].length = 0;
  }
  return outs;
}

const personNote = (id: string, text: string, at: number): TicketNote => ({
  id,
  text,
  author: 'person',
  createdAtMs: at,
  updatedAtMs: at,
});

test('ui(ticket_note) lands as a noted fact, once, even when init replays it', () => {
  reset();
  capture('k1');
  useApp.setState({ tickets: [threeSessions()] });
  const wire = {
    v: 1, t: 'ui', kind: 'ticket_note', ticket_id: 'tk-1', op_id: 'nop-0123456789abcdef', session_id: 'S2',
    op: 'add', note_id: 'nt-lx2k9a-abc123', text: 'use plan B', at_ms: 9_000,
  };
  deliver('k1', wire);
  const ticket = useApp.getState().tickets[0];
  assert.deepEqual(ticket.notes, [
    { id: 'nt-lx2k9a-abc123', text: 'use plan B', author: 'agent', sessionId: 'S2', createdAtMs: 9_000, updatedAtMs: 9_000 },
  ]);

  deliver('k1', wire);
  assert.equal(useApp.getState().tickets[0], ticket, 'a repeat changes nothing, not even the object');

  // A half-formed message is dropped rather than guessed at.
  deliver('k1', { ...wire, op_id: '', note_id: 'nt-other' });
  deliver('k1', { ...wire, op: 'nope', op_id: 'nop-2', note_id: 'nt-other' });
  assert.equal(useApp.getState().tickets[0], ticket);
});

test('init folds note ops in with reports and turn ends by time, not list after list', () => {
  reset();
  capture('k1');
  useApp.setState({ tickets: [threeSessions()] });

  // The update is listed before the add it depends on, and the turn end is
  // older than the report: only a merge by time gets both right.
  deliver('k1', initMsg('S1', 22, binding({
    reports: [
      { report_id: 'r1', status: 'blocked', summary: 'stuck', question: 'which db?', evidence: [], at_ms: 6_000 },
    ],
    turn_ends: [{ turn_id: 't1', at_ms: 5_000 }],
    note_ops: [
      { op_id: 'nop-2', op: 'update', note_id: 'nt-a', text: 'plan C', at_ms: 8_000 },
      { op_id: 'nop-1', op: 'add', note_id: 'nt-a', text: 'plan B', at_ms: 7_000 },
    ],
  })));

  const t = useApp.getState().tickets[0];
  assert.equal(t.status, 'review', 'the older turn end moved it to review; the blocked report then only recorded');
  assert.equal(t.lastReport?.reportId, 'r1');
  assert.deepEqual(t.notes.map((n) => [n.id, n.text, n.sessionId]), [['nt-a', 'plan C', 'S1']]);
  assert.deepEqual(
    t.events.filter((e) => ['turnEndedUnreported', 'reported', 'noted'].includes(e.type)).map((e) => e.type),
    ['turnEndedUnreported', 'reported', 'noted', 'noted'],
    'one timeline, in the order it happened',
  );

  // Opening it again changes nothing.
  const settled = useApp.getState().tickets[0];
  deliver('k1', initMsg('S1', 22, binding({
    note_ops: [
      { op_id: 'nop-1', op: 'add', note_id: 'nt-a', text: 'plan B', at_ms: 7_000 },
      { op_id: 'nop-2', op: 'update', note_id: 'nt-a', text: 'plan C', at_ms: 8_000 },
    ],
  })));
  assert.equal(useApp.getState().tickets[0], settled);
});

test('init never lets the runtime\u2019s copy of the notes overwrite the Ticket\u2019s', () => {
  reset();
  capture('k1');
  const t = { ...threeSessions(), notes: [personNote('nt-p', 'canonical', 4_000)] };
  useApp.setState({ tickets: [t] });
  deliver('k1', initMsg('S1', 22, binding({
    notes: [{ id: 'nt-stale', text: 'stale copy', author: 'person', updated_at_ms: 1 }],
  })));
  assert.deepEqual(useApp.getState().tickets[0].notes, t.notes);
});

test('init re-binds the canonical notes after the reconcile, and only to a runtime that can hold them', () => {
  reset();
  const t = { ...threeSessions(), notes: [personNote('nt-p', 'decided', 4_000)] };
  useApp.setState({ tickets: [t] });

  const seenAtSend: number[] = [];
  const out22 = capture('k1');
  const unsubscribe = useApp.subscribe((s) => {
    if (out22.some((m) => m.t === 'ticket_bind')) seenAtSend.push(s.tickets[0].notes.length);
  });
  deliver('k1', initMsg('S1', 22, binding({
    attachments: [{ name: 'log.txt', path: '.tudouni/ticket-attachments/tk-1/log.txt', bytes: 10 }],
    note_ops: [{ op_id: 'nop-1', op: 'add', note_id: 'nt-a', text: 'agent note', at_ms: 9_000 }],
  })));
  unsubscribe();
  const sent = binds(out22);
  assert.equal(sent.length, 1);
  assert.deepEqual(bound(sent[0]), {
    id: 'tk-1',
    title: 'T',
    brief: 'do the thing',
    attachments: [{ name: 'log.txt', path: '.tudouni/ticket-attachments/tk-1/log.txt', bytes: 10 }],
    notes: [
      { id: 'nt-p', text: 'decided', author: 'person', updated_at_ms: 4_000, created_at_ms: 4_000 },
      { id: 'nt-a', text: 'agent note', author: 'agent', updated_at_ms: 9_000, created_at_ms: 9_000, session_id: 'S1' },
    ],
  }, 'the runtime\u2019s own attachments are replayed: a bind is a whole replacement');

  // Protocol 21 has no notes: nothing is sent, and nothing it did not ask for.
  const out21 = capture('k2');
  deliver('k2', initMsg('S2', 21, binding()));
  assert.equal(binds(out21).length, 0);
});

test('a note command re-binds every live present session of the worker, protocol 22 and up', () => {
  reset();
  useApp.setState({ tickets: [threeSessions()] });
  const outs = openSessions({ k1: 22, k2: 23, k3: 21 });

  const r = useApp.getState().dispatchTicket('tk-1', { type: 'note', op: 'add', text: 'ship it behind a flag', noteIdMinted: 'nt-p1' });
  assert.equal(r.ok, true);
  const created = useApp.getState().tickets[0].notes[0].createdAtMs;

  const expectNotes = [{ id: 'nt-p1', text: 'ship it behind a flag', author: 'person', updated_at_ms: created, created_at_ms: created }];
  for (const key of ['k1', 'k2']) {
    assert.equal(binds(outs[key]).length, 1, `${key} is told`);
    assert.deepEqual(bound(binds(outs[key])[0]), {
      id: 'tk-1',
      title: 'T',
      brief: 'do the thing',
      attachments: [{ name: 'log.txt', path: '.tudouni/ticket-attachments/tk-1/log.txt', bytes: 10 }],
      notes: expectNotes,
    });
  }
  assert.equal(outs.k3.length, 0, 'protocol 21 would ignore the key: it is sent nothing');

  // A change that is not about notes sends nothing.
  useApp.getState().dispatchTicket('tk-1', { type: 'edit', patch: { title: 'Renamed' } });
  assert.equal(binds(outs.k1).length, 1);

  // Edit and delete go the same way, and the list is the whole list each time.
  useApp.getState().dispatchTicket('tk-1', { type: 'note', op: 'update', noteId: 'nt-p1', text: 'ship it' });
  assert.equal(((bound(binds(outs.k2)[1]).notes as Record<string, unknown>[])[0]).text, 'ship it');
  useApp.getState().dispatchTicket('tk-1', { type: 'note', op: 'remove', noteId: 'nt-p1' });
  assert.deepEqual(bound(binds(outs.k1)[2]).notes, []);
  assert.equal(binds(outs.k3).length, 0);

  // A refused command changes nothing and tells nobody.
  const before = binds(outs.k1).length;
  assert.equal(useApp.getState().dispatchTicket('tk-1', { type: 'note', op: 'add', text: '', noteIdMinted: 'nt-e' }).ok, false);
  assert.equal(binds(outs.k1).length, before);
});

test('an accepted agent fact re-binds every live session, the writer included', () => {
  reset();
  useApp.setState({ tickets: [threeSessions()] });
  const outs = openSessions({ k1: 22, k2: 22 });

  deliver('k1', {
    v: 1, t: 'ui', kind: 'ticket_note', ticket_id: 'tk-1', op_id: 'nop-1', session_id: 'S2',
    op: 'add', note_id: 'nt-ag', text: 'found the cause', at_ms: 9_000,
  });
  for (const key of ['k1', 'k2']) {
    assert.equal(binds(outs[key]).length, 1, `${key} is told`);
    const notes = bound(binds(outs[key])[0]).notes as Record<string, unknown>[];
    assert.deepEqual(notes, [
      { id: 'nt-ag', text: 'found the cause', author: 'agent', updated_at_ms: 9_000, created_at_ms: 9_000, session_id: 'S2' },
    ]);
  }

  // The replay of the same op moves nothing and sends nothing.
  deliver('k1', {
    v: 1, t: 'ui', kind: 'ticket_note', ticket_id: 'tk-1', op_id: 'nop-1', session_id: 'S2',
    op: 'add', note_id: 'nt-ag', text: 'found the cause', at_ms: 9_000,
  });
  assert.equal(binds(outs.k1).length, 1);
});

test('an agent write the canonical list cannot take still brings the runtimes back in line', () => {
  reset();
  let t = threeSessions();
  for (const id of ['a', 'b', 'c']) {
    const r = apply(t, { type: 'note', at: 3_000, op: 'add', text: id.repeat(TICKET_NOTE_TEXT_CEILING), noteIdMinted: `nt-${id}` });
    if (!r.ok) throw new Error(r.reason);
    t = r.ticket;
  }
  useApp.setState({ tickets: [t] });
  const outs = openSessions({ k1: 22, k2: 22 });

  deliver('k1', {
    v: 1, t: 'ui', kind: 'ticket_note', ticket_id: 'tk-1', op_id: 'nop-big', session_id: 'S1',
    op: 'add', note_id: 'nt-ag', text: 'one more', at_ms: 9_000,
  });
  assert.equal(useApp.getState().tickets[0].notes.length, 3, 'not stored');
  for (const key of ['k1', 'k2']) {
    const notes = bound(binds(outs[key])[0]).notes as Record<string, unknown>[];
    assert.deepEqual(notes.map((n) => n.id), ['nt-a', 'nt-b', 'nt-c'], 'the runtime\u2019s extra copy is replaced');
  }
});

test('a removed session, a closed one and one with no known binding are not re-bound', () => {
  reset();
  useApp.setState({ tickets: [threeSessions()] });
  const outs = openSessions({ k1: 22, k2: 22, k3: 22 });

  // k2 is taken off (its own unbind goes out), k3's child exits.
  useApp.getState().removeTicketSession('tk-1', { sessionKey: 'k2', sessionId: 'S2' });
  assert.equal(binds(outs.k2).length, 1);
  assert.equal(bound(binds(outs.k2)[0]), null, 'removing sends the unbind');
  useApp.setState((s) => ({ sessions: { ...s.sessions, k3: { ...s.sessions.k3, runtimeExit: { code: 1 } as never } } }));
  outs.k1.length = 0;
  outs.k2.length = 0;
  outs.k3.length = 0;

  useApp.getState().dispatchTicket('tk-1', { type: 'note', op: 'add', text: 'x', noteIdMinted: 'nt-1' });
  assert.equal(binds(outs.k1).length, 1, 'the live present one');
  assert.equal(outs.k2.length, 0, 'taken off the Ticket: it does not see its notes');
  assert.equal(outs.k3.length, 0, 'not alive');

  // A session whose binding this window never learned has nothing to replay:
  // guessing its attachments would clear them.
  useApp.setState((s) => ({ sessions: { ...s.sessions, k1: { ...s.sessions.k1, ticketSpec: undefined } } }));
  outs.k1.length = 0;
  useApp.getState().dispatchTicket('tk-1', { type: 'note', op: 'add', text: 'y', noteIdMinted: 'nt-2' });
  assert.equal(outs.k1.length, 0);
});

/* ============================================================
   What start sends is what a re-bind sends
   ============================================================ */

test('a start at protocol 22 binds with the notes, and an unchanged re-bind is the same message', async () => {
  reset();
  useApp.setState({
    sessions: {
      'k-active': Object.assign(createSessionBucket('k-active', 'C:/work', { ericai: false, maxSteps: null }, null), { ready: true }),
    },
    order: ['k-active'],
    activeKey: 'k-active',
  });
  const open: Ticket = {
    ...emptyTicket(1_000),
    id: 'tk-start',
    title: 'T',
    brief: 'do the thing',
    notes: [personNote('nt-p', 'prefer small PRs', 1_500)],
    attachments: [{ name: 'log.txt', bytes: 10, addedAtMs: 1_200 }],
  };
  useApp.setState({ tickets: [open] });

  const key = await useApp.getState().startTicket('tk-start');
  assert.ok(key);
  const out = capture(key);
  useApp.setState((s) => ({
    sessions: {
      ...s.sessions,
      [key]: { ...s.sessions[key], ready: true, sessionId: 'S-new', session: { ...(s.sessions[key].session ?? {}), protocol: 22, id: 'S-new' } as never },
    },
  }));
  const deadline = Date.now() + 5_000;
  while (binds(out).length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the bind');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(stageCalls, 1);

  const started = binds(out)[0];
  assert.deepEqual(started, {
    v: 1,
    t: 'ticket_bind',
    ticket: {
      id: 'tk-start',
      title: 'T',
      brief: 'do the thing',
      attachments: [{ name: 'log.txt', path: '.tudouni/ticket-attachments/tk-start/log.txt', bytes: 10 }],
      notes: [{ id: 'nt-p', text: 'prefer small PRs', author: 'person', updated_at_ms: 1_500, created_at_ms: 1_500 }],
    },
  });

  // Nothing changed: the runtime must see the very same message and so write nothing.
  rebindTicketNotes(ctx, useApp.getState().tickets[0]);
  assert.equal(binds(out).length, 2);
  assert.deepEqual(binds(out)[1], started);

  // After a note: the same message with only the notes different.
  useApp.getState().dispatchTicket('tk-start', { type: 'note', op: 'add', text: 'and a second', noteIdMinted: 'nt-2' });
  const third = bound(binds(out)[2]);
  const { notes, ...rest } = third;
  const { notes: startedNotes, ...startedRest } = bound(started);
  assert.deepEqual(rest, startedRest);
  assert.equal((notes as unknown[]).length, 2);
  assert.equal((startedNotes as unknown[]).length, 1);

  // A brief edited since is not pushed into a session that is already working.
  useApp.getState().updateTicketDraft('tk-start', { brief: 'a different brief' });
  useApp.getState().dispatchTicket('tk-start', { type: 'note', op: 'add', text: 'third', noteIdMinted: 'nt-3' });
  assert.equal(bound(binds(out)[3]).brief, 'do the thing');
  unregisterRuntime(key);
});

test('a start at protocol 21 binds without the notes key, and one at 18 without attachments either', async () => {
  for (const protocol of [21, 18]) {
    reset();
    useApp.setState({
      sessions: {
        'k-active': Object.assign(createSessionBucket('k-active', 'C:/work', { ericai: false, maxSteps: null }, null), { ready: true }),
      },
      order: ['k-active'],
      activeKey: 'k-active',
      tickets: [{
        ...emptyTicket(1_000),
        id: 'tk-old',
        title: 'T',
        brief: 'do the thing',
        notes: [personNote('nt-p', 'x', 1_500)],
        attachments: [{ name: 'log.txt', bytes: 10, addedAtMs: 1_200 }],
      }],
    });
    const key = await useApp.getState().startTicket('tk-old');
    assert.ok(key);
    const out = capture(key);
    useApp.setState((s) => ({
      sessions: {
        ...s.sessions,
        [key]: { ...s.sessions[key], ready: true, sessionId: 'S-old', session: { ...(s.sessions[key].session ?? {}), protocol, id: 'S-old' } as never },
      },
    }));
    const deadline = Date.now() + 5_000;
    while (binds(out).length === 0) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the bind');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sent = bound(binds(out)[0]);
    assert.equal('notes' in sent, false, `protocol ${protocol}: the key would be ignored, so it is absent`);
    assert.equal('attachments' in sent, protocol >= 19);

    // And a note changed afterwards tells this runtime nothing.
    useApp.getState().dispatchTicket('tk-old', { type: 'note', op: 'add', text: 'later', noteIdMinted: 'nt-2' });
    assert.equal(binds(out).length, 1);
    unregisterRuntime(key);
  }
});

test('the wire shape of a note is snake_case with the optional keys left out', () => {
  assert.deepEqual(noteToWire(personNote('nt-1', 'x', 5)), {
    id: 'nt-1',
    text: 'x',
    author: 'person',
    updated_at_ms: 5,
    created_at_ms: 5,
  });
  assert.deepEqual(
    noteToWire({ id: 'nt-2', text: 'y', author: 'agent', sessionId: 'S1', createdAtMs: 0, updatedAtMs: 9 }),
    { id: 'nt-2', text: 'y', author: 'agent', updated_at_ms: 9, session_id: 'S1' },
    'a zero creation time is "unknown", not the epoch',
  );
  const keys = Object.keys(noteToWire({ id: 'nt-3', text: 'z', author: 'person', createdAtMs: 1, updatedAtMs: 2 }));
  assert.equal(keys.some((k) => /[A-Z]/.test(k)), false);
});
