/**
 * The Ticket board's rules: which board is on screen, what the board derives
 * from a Ticket, and what a Ticket's session actions put on the wire.
 *
 * Three halves, for the three ways this feature can go quietly wrong:
 *
 *   - **Boards are exclusive** and the Ticket board is a conversation-column
 *     occupant like the session board (composer withdrawn, terminal outranks).
 *   - **The card is a pure reading of the record** (`ticket/view.ts`): column,
 *     cause, buttons, whether "Continue" can reach anything. A wrong branch
 *     throws nothing and draws something plausible.
 *   - **The session actions' order is the contract**: `ticket_bind` only to a
 *     protocol-18 runtime and before `set_model`; `set_autopilot` before the
 *     first message; a default start only pre-fills; a failed open changes
 *     nothing; resume goes to the machine the session ran on.
 *
 * Driven against the same fake Tauri host `task.test.ts` uses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { conversationView, showsComposer, type ConversationViewInput } from '@/conversationView';
import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';
import { registerRuntime, unregisterRuntime } from '@/runtime/bus';
import { landTicketUnreachable } from '@/state/ticketLanding';
import { apply, currentAssignment, type TicketInput } from '@/ticket/machine';
import {
  TICKET_BRIEF_CEILING,
  TICKET_TITLE_CEILING,
  emptyTicket,
  unbindableField,
  type Report,
  type Ticket,
} from '@/ticket/model';
import {
  acceptsDrop,
  canBindBrief,
  canDrop,
  canResumeAssignment,
  columnOf,
  dropTargets,
  dropVerb,
  groupTickets,
  needsYouCause,
  rememberedStartMode,
  staysOnBoard,
  ticketActions,
  ticketRunState,
} from '@/ticket/view';
import { en } from '@/i18n';
import { liveKeyOfAssignment, selectTicketAttention } from '@/state/selectors/tickets';

/* ============================================================
   The host
   ============================================================ */

let localCalls: Record<string, unknown>[] = [];
let remoteCalls: Record<string, unknown>[] = [];
let nextKey = 500;
let refuseLocal: string | null = null;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'runtime_attach') {
        if (refuseLocal !== null) return Promise.reject(new Error(refuseLocal));
        localCalls.push((args.options ?? {}) as Record<string, unknown>);
        return Promise.resolve(nextKey++);
      }
      if (cmd === 'runtime_attach_remote') {
        remoteCalls.push((args.options ?? {}) as Record<string, unknown>);
        return Promise.resolve(nextKey++);
      }
      if (cmd === 'check_remote_config') {
        return Promise.resolve({ status: 'valid', fingerprint: 'fp-1', error: null });
      }
      if (cmd === 'read_local_config_text') return Promise.resolve({ text: '{}', fingerprint: 'fp-1' });
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  },
};

const HOST = {
  id: 'ssh-1',
  label: 'rvv',
  host: '10.2.0.4',
  port: 22,
  user: 'tudouni',
  identityFiles: [],
  configPolicy: 'use-remote' as const,
  configBaselineFingerprint: 'fp-1',
};
const ENTRY = {
  id: 'rw-1',
  hostId: HOST.id,
  remotePath: '/repo/rvv-project',
  remoteBinary: '/home/tudouni/.tudouni/runtime/current/tudouni-aigo',
  label: 'rvv:rvv-project',
};

function liveBucket(key: string, workspace: string, protocol: number, sessionId: string): SessionRuntime {
  const bucket = createSessionBucket(key, workspace, { ericai: false, maxSteps: null }, null);
  bucket.ready = true;
  bucket.sessionId = sessionId;
  bucket.session = {
    ...(bucket.session ?? ({} as NonNullable<SessionRuntime['session']>)),
    resumed: true,
    id: sessionId,
    workspace,
    protocol,
  } as never;
  return bucket;
}

/** A ready local session on screen, and a clean Ticket list. */
function screen(protocol = 18, sessionId = 'S1'): void {
  useApp.setState({
    sessions: { 'k-active': liveBucket('k-active', 'C:/work', protocol, sessionId) },
    order: ['k-active'],
    activeKey: 'k-active',
    modal: null,
    pendingModals: [],
    panel: null,
    board: null,
    startupProblem: null,
    startupNotice: null,
    workspaces: ['C:/work'],
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: 'C:/work',
    tickets: [],
    ticketsLoaded: true,
    ticketsReadOnly: false,
    ticketsProblem: null,
    ticketSeed: null,
  });
  localCalls = [];
  remoteCalls = [];
  refuseLocal = null;
}

/** Everything sent to `key`, in order. */
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

async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ok()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The child answered its handshake: ready, with a runtime protocol and id. */
function handshake(key: string, protocol: number, sessionId: string): void {
  useApp.setState((s) => ({
    sessions: {
      ...s.sessions,
      [key]: {
        ...s.sessions[key],
        ready: true,
        sessionId,
        session: { ...(s.sessions[key].session ?? {}), protocol, id: sessionId } as never,
      },
    },
  }));
}

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

/** A Ticket brought to `status` through the machine, never by writing fields. */
function ticketAt(
  status: 'open' | 'running' | 'needs_you' | 'review',
  patch: Partial<Ticket> = {},
  executor: { remoteWorkspaceId?: string | null; sessionId?: string; sessionKey?: string } = {},
): Ticket {
  let t: Ticket = { ...emptyTicket(1_000), title: 'T', brief: 'do the thing', ...patch };
  const run = (input: TicketInput): void => {
    const result = apply(t, input);
    if (!result.ok) throw new Error(`refused ${input.type}: ${result.reason}`);
    t = result.ticket;
  };
  if (status === 'open') return t;
  run({
    type: 'start',
    at: 2_000,
    assignmentId: 'as-1',
    sessionKey: executor.sessionKey ?? 'k-active',
    remoteWorkspaceId: executor.remoteWorkspaceId ?? null,
    workspace: executor.remoteWorkspaceId ? ENTRY.remotePath : 'C:/work',
  });
  const sid = executor.sessionId ?? 'S1';
  if (sid !== '') run({ type: 'assignmentStarted', at: 2_001, sessionKey: executor.sessionKey ?? 'k-active', sessionId: sid });
  if (status === 'review') run({ type: 'reported', at: 3_000, report: REPORT({ sessionId: sid }) });
  if (status === 'needs_you') {
    run({
      type: 'reported',
      at: 3_000,
      report: REPORT({ sessionId: sid, status: 'blocked', question: 'which db?' }),
    });
  }
  return t;
}

function install(...tickets: Ticket[]): void {
  useApp.setState({ tickets });
}

/* ============================================================
   Boards: exclusive, and one column occupant each
   ============================================================ */

test('opening one board puts the other away, and null closes whichever is up', () => {
  screen();
  useApp.getState().setBoard('sessions');
  assert.equal(useApp.getState().board, 'sessions');
  useApp.getState().setBoard('tickets');
  assert.equal(useApp.getState().board, 'tickets', 'the ticket board replaced the session board');
  useApp.getState().setBoard('sessions');
  assert.equal(useApp.getState().board, 'sessions', 'and back: one field, so no stacking');
  useApp.getState().setBoard(null);
  assert.equal(useApp.getState().board, null);
});

test('toggleBoard closes the board that is up and switches rather than stacks', () => {
  screen();
  useApp.getState().toggleBoard('tickets');
  assert.equal(useApp.getState().board, 'tickets');
  useApp.getState().toggleBoard('sessions');
  assert.equal(useApp.getState().board, 'sessions', 'pressing the other board\u2019s button switches');
  useApp.getState().toggleBoard('sessions');
  assert.equal(useApp.getState().board, null, 'pressing the open board\u2019s own button closes it');
});

test('opening a board closes a panel, and the Esc rung (`board !== null`) covers both', () => {
  screen();
  useApp.setState({ panel: 'tasks' });
  useApp.getState().setBoard('tickets');
  assert.equal(useApp.getState().panel, null, 'a panel stacked over a view would hide it');
  // `useGlobalKeys` closes "whichever board" with `s.board !== null` then
  // `setBoard(null)`; that rung is the same for both values.
  for (const kind of ['sessions', 'tickets'] as const) {
    useApp.getState().setBoard(kind);
    const s = useApp.getState();
    if (s.board !== null) s.setBoard(null);
    assert.equal(useApp.getState().board, null);
  }
});

function healthy(overrides: Partial<ConversationViewInput> = {}): ConversationViewInput {
  return {
    startupProblem: false,
    sessionProblem: false,
    attachedTerminalId: null,
    board: null,
    hasSession: true,
    ready: true,
    hasConversation: true,
    ...overrides,
  };
}

test('the ticket board is a column occupant: above the first screen, below a terminal, no composer', () => {
  assert.equal(conversationView(healthy({ board: 'tickets' })), 'tickets');
  assert.equal(conversationView(healthy({ board: 'tickets', hasConversation: false })), 'tickets', 'covers the greeting');
  assert.equal(conversationView(healthy({ board: 'tickets', hasSession: false })), 'tickets', 'reachable with no session at all');
  assert.equal(conversationView(healthy({ board: 'tickets', ready: false })), 'tickets');
  assert.equal(
    conversationView(healthy({ board: 'tickets', attachedTerminalId: 'term-01' })),
    'terminal',
    'nothing may cover the shell\u2019s way out',
  );
  assert.equal(conversationView(healthy({ board: 'tickets', sessionProblem: true })), 'session-problem');
  assert.equal(showsComposer('tickets'), false, 'a message typed there would have no addressee');
  assert.equal(conversationView(healthy({ board: 'sessions' })), 'board', 'the session board is unchanged');
});

test('the Ticket board needs no live session to open, and opening it does not touch the sessions', () => {
  screen();
  const before = useApp.getState().order;
  useApp.getState().setBoard('tickets');
  assert.equal(useApp.getState().order, before);
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  useApp.getState().setBoard('tickets');
  assert.equal(useApp.getState().board, 'tickets');
});

/* ============================================================
   What the card reads from the record
   ============================================================ */

test('dropped has no column of its own: it folds into Done', () => {
  assert.equal(columnOf('dropped'), 'done');
  assert.equal(columnOf('needs_you'), 'needs_you');
  const done = { ...ticketAt('review'), status: 'done' as const };
  const dropped = { ...emptyTicket(1), status: 'dropped' as const };
  const groups = groupTickets([ticketAt('open'), ticketAt('running'), done, dropped, ticketAt('review')]);
  assert.deepEqual(
    [groups.open.length, groups.running.length, groups.needs_you.length, groups.review.length, groups.done.length, groups.dropped.length],
    [1, 1, 0, 1, 1, 1],
  );
});

test('the buttons follow the status, and "Continue" is only the wording of "Open session"', () => {
  assert.deepEqual(ticketActions('open', false), ['start', 'runNow']);
  assert.deepEqual(ticketActions('running', true), ['open']);
  assert.deepEqual(ticketActions('running', false), ['continue'], 'running but not connected');
  assert.deepEqual(ticketActions('needs_you', true), ['open', 'restart']);
  assert.deepEqual(ticketActions('needs_you', false), ['continue', 'restart']);
  assert.deepEqual(ticketActions('review', false), ['open', 'accept', 'sendBack']);
  assert.deepEqual(ticketActions('done', false), ['reopen']);
  assert.deepEqual(ticketActions('dropped', false), ['reopen']);
  assert.equal(canDrop('open') && canDrop('running') && canDrop('needs_you') && canDrop('review'), true);
  assert.equal(canDrop('done') || canDrop('dropped'), false);
});

test('a lost connection reads as "disconnected", a blocked report as a question, a crash as a crash', () => {
  const started = ticketAt('running');
  const exit = (reason: 'disconnected' | 'crashed'): Ticket => {
    const r = apply(started, { type: 'assignmentExited', at: 4_000, sessionKey: 'k-active', sessionId: 'S1', requested: false, reason });
    if (!r.ok) throw new Error(r.reason);
    return r.ticket;
  };
  assert.equal(needsYouCause(exit('disconnected')), 'disconnected');
  assert.equal(needsYouCause(exit('crashed')), 'crashed');
  assert.equal(needsYouCause(ticketAt('needs_you')), 'blocked');
  assert.equal(needsYouCause(started), null, 'only needs_you has a cause');
});

test('"Continue" is judged from the Assignment, not from the Ticket\u2019s workspace ref', () => {
  const remote = new Set(['rw-1']);
  // A Ticket made against "the workspace on screen" has a ref that means
  // nothing after a restart; its Assignment still knows where it ran.
  const local = ticketAt('running');
  assert.equal(local.workspace.kind, 'active');
  assert.equal(canResumeAssignment(local, currentAssignment(local), remote), true);
  const viaRemote = ticketAt('running', {}, { remoteWorkspaceId: 'rw-1' });
  assert.equal(canResumeAssignment(viaRemote, currentAssignment(viaRemote), remote), true);
  assert.equal(canResumeAssignment(viaRemote, currentAssignment(viaRemote), new Set()), false, 'its saved workspace was deleted');
  const noId = ticketAt('running', {}, { sessionId: '' });
  assert.equal(canResumeAssignment(noId, currentAssignment(noId), remote), false, 'no saved session id to resume');
  assert.equal(canResumeAssignment(local, null, remote), false);
});

test('a session is "live" only while its child is: an exited or failed bucket is not', () => {
  screen();
  const t = ticketAt('running');
  const assignment = currentAssignment(t);
  assert.equal(liveKeyOfAssignment(useApp.getState(), assignment), 'k-active');
  useApp.setState((s) => ({
    sessions: { 'k-active': { ...s.sessions['k-active'], runtimeExit: { code: 1, requested: false } } },
  }));
  assert.equal(liveKeyOfAssignment(useApp.getState(), assignment), null, 'the bucket stays but nothing can hear us');
  assert.equal(liveKeyOfAssignment(useApp.getState(), null), null);
});

test('the workbench badge counts the two states only a person can move', () => {
  screen();
  install(ticketAt('open'), ticketAt('running'), ticketAt('needs_you'), ticketAt('review'));
  assert.equal(selectTicketAttention(useApp.getState()), 2);
});

/* ============================================================
   startTicket: the order on the wire
   ============================================================ */

test('a default start opens a new session, binds it before the model, and only pre-fills the brief', async () => {
  screen();
  const t = { ...ticketAt('open'), model: 'prov/m1' };
  install(t);

  const key = await useApp.getState().startTicket(t.id);
  assert.ok(key, 'a start that opened a session returns its key');
  assert.equal(localCalls.length, 1, 'the local spawn is the open path');
  assert.notEqual(key, 'k-active', 'a new bucket, never the one already on screen');

  let ticket = useApp.getState().tickets[0];
  assert.equal(ticket.status, 'running');
  assert.equal(currentAssignment(ticket)?.executor.sessionKey, key);
  assert.equal(currentAssignment(ticket)?.executor.workspace, 'C:/work', 'where it ran is recorded for Continue');
  assert.equal(currentAssignment(ticket)?.executor.remoteWorkspaceId, null);

  const out = capture(key);
  handshake(key, 18, 'S-new');
  await until('the brief to be pre-filled', () => useApp.getState().sessions[key]?.draft === 'do the thing');

  assert.deepEqual(
    out.map((m) => m.t),
    ['ticket_bind', 'set_model'],
    'bind first (it registers the report tool), then the model; nothing is sent',
  );
  assert.deepEqual(out[0].ticket, { id: t.id, title: 'T', brief: 'do the thing' });
  assert.equal(out[1].model, 'prov/m1');
  assert.equal(useApp.getState().sessions[key]?.hasSpoken, false);

  ticket = useApp.getState().tickets[0];
  assert.equal(currentAssignment(ticket)?.executor.sessionId, 'S-new', 'init\u2019s id is written back');
  unregisterRuntime(key);
});

test('"run now" turns autopilot on before the first message, which is the brief', async () => {
  screen();
  const t = { ...ticketAt('open'), model: 'prov/m1' };
  install(t);
  const key = await useApp.getState().startTicket(t.id, { runNow: true });
  assert.ok(key);
  const out = capture(key);
  handshake(key, 18, 'S-new');
  await until('the brief to be sent', () => out.some((m) => m.t === 'user_message'));

  assert.deepEqual(out.map((m) => m.t), ['ticket_bind', 'set_model', 'set_autopilot', 'user_message']);
  assert.equal(out[2].on, true);
  assert.equal(out[3].text, 'do the thing');
  assert.equal(useApp.getState().sessions[key]?.draft, '', 'sent, not parked');
  unregisterRuntime(key);
});

test('a runtime older than protocol 18 is never sent ticket_bind', async () => {
  screen();
  const t = ticketAt('open');
  install(t);
  const key = await useApp.getState().startTicket(t.id, { runNow: true });
  assert.ok(key);
  const out = capture(key);
  handshake(key, 17, 'S-old');
  await until('the brief to be sent', () => out.some((m) => m.t === 'user_message'));
  assert.equal(out.some((m) => m.t === 'ticket_bind'), false, 'an old runtime would drop it and the card would lie');
  assert.equal(useApp.getState().tickets[0].status, 'running', 'the Ticket still starts');
  unregisterRuntime(key);
});

test('a start whose open fails or names a missing workspace leaves the Ticket untouched', async () => {
  screen();
  const t = ticketAt('open');
  install(t, { ...t, id: 'tk-remote', workspace: { kind: 'remote', id: 'rw-404' } });

  refuseLocal = 'the workspace C:/refused is not a directory';
  assert.equal(await useApp.getState().startTicket(t.id), null, 'a refused open is not a start');
  refuseLocal = null;
  assert.equal(await useApp.getState().startTicket('tk-remote'), null, 'an unknown remote workspace starts nothing');

  for (const row of useApp.getState().tickets) {
    assert.equal(row.status, 'open');
    assert.equal(row.assignments.length, 0, 'no Assignment without a session');
  }
});

test('a start is refused before opening anything when the Ticket cannot start', async () => {
  screen();
  const empty = { ...ticketAt('open'), brief: '   ' };
  const running = ticketAt('running');
  install(empty, { ...running, id: 'tk-running' });
  assert.equal(await useApp.getState().startTicket(empty.id), null);
  assert.equal(await useApp.getState().startTicket('tk-running'), null);
  assert.equal(localCalls.length, 0, 'no session was left behind by a refused command');
});

test('a double press opens one session, not two', async () => {
  screen();
  const t = ticketAt('open');
  install(t);
  const [a, b] = await Promise.all([useApp.getState().startTicket(t.id), useApp.getState().startTicket(t.id)]);
  assert.equal([a, b].filter((k) => k !== null).length, 1);
  assert.equal(localCalls.length, 1);
});

test('starting over a blocked Ticket supersedes the old Assignment and unbinds its live session', async () => {
  screen(18, 'S1');
  const old = capture('k-active');
  const t = ticketAt('needs_you');
  install(t);

  const key = await useApp.getState().restartTicket(t.id);
  assert.ok(key);
  const ticket = useApp.getState().tickets[0];
  assert.equal(ticket.status, 'running');
  assert.equal(ticket.assignments.length, 2);
  assert.equal(ticket.assignments[0].end, 'superseded');
  assert.deepEqual(old.map((m) => m.t), ['ticket_bind']);
  assert.equal(old[0].ticket, null, 'the old session no longer reports to this Ticket');
  unregisterRuntime('k-active');
  unregisterRuntime(key);
});

/* ============================================================
   accept / drop / send back / continue
   ============================================================ */

test('accept and drop unbind a session that is still attached, and say nothing to a closed one', () => {
  screen(18, 'S1');
  const out = capture('k-active');
  const review = ticketAt('review');
  const running = { ...ticketAt('running'), id: 'tk-2' };
  install(review, running);

  assert.equal(useApp.getState().acceptTicket(review.id).ok, true);
  assert.equal(useApp.getState().tickets[0].status, 'done');
  assert.deepEqual(out.map((m) => m.t), ['ticket_bind']);
  assert.equal(out[0].ticket, null);

  assert.equal(useApp.getState().dropTicket('tk-2').ok, true);
  assert.equal(useApp.getState().tickets[1].status, 'dropped');
  assert.equal(out.length, 2, 'a second unbind for the second Ticket');

  // A closed session cannot hear it: nothing is sent, nothing throws.
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  const gone = { ...ticketAt('running'), id: 'tk-3' };
  install(gone);
  assert.equal(useApp.getState().dropTicket('tk-3').ok, true);
  assert.equal(out.length, 2);
  unregisterRuntime('k-active');
});

test('accept is refused outside review, and nothing is unbound for a refusal', () => {
  screen(18, 'S1');
  const out = capture('k-active');
  const t = ticketAt('running');
  install(t);
  const result = useApp.getState().acceptTicket(t.id);
  assert.equal(result.ok, false);
  assert.equal(out.length, 0);
  unregisterRuntime('k-active');
});

test('send back to a live session sends the feedback as a user message and moves to running', async () => {
  screen(18, 'S1');
  const out = capture('k-active');
  const t = ticketAt('review');
  install(t);

  const result = await useApp.getState().sendBackTicket(t.id, '  also cover the error path  ');
  assert.equal(result.ok, true);
  assert.equal(useApp.getState().tickets[0].status, 'running');
  assert.equal(useApp.getState().tickets[0].assignments.length, 1, 'same executor: no new Assignment');
  assert.deepEqual(out.map((m) => m.t), ['user_message']);
  assert.equal(out[0].text, 'also cover the error path');
  assert.equal(localCalls.length, 0, 'nothing was opened');
  unregisterRuntime('k-active');
});

test('send back with empty feedback is refused and sends nothing', async () => {
  screen(18, 'S1');
  const out = capture('k-active');
  const t = ticketAt('review');
  install(t);
  const result = await useApp.getState().sendBackTicket(t.id, '   ');
  assert.deepEqual(result, { ok: false, reason: 'empty_feedback' });
  assert.equal(out.length, 0);
  assert.equal(useApp.getState().tickets[0].status, 'review');
  unregisterRuntime('k-active');
});

test('send back to a closed local session resumes that session where it ran, then speaks into it', async () => {
  screen(18, 'S-other');
  const t = ticketAt('review'); // its session S1 has no live bucket
  install(t);

  const pending = useApp.getState().sendBackTicket(t.id, 'tighten the tests');
  await until('the resume to be opened', () => localCalls.length === 1);
  assert.equal(localCalls[0].sessionId, 'S1', 'the original session is reopened, not a new one');
  assert.equal(localCalls[0].workspace, 'C:/work', 'in the directory it ran in, not the screen\u2019s');

  const result = await pending;
  assert.equal(result.ok, true);
  const ticket = useApp.getState().tickets[0];
  assert.equal(ticket.status, 'running');
  assert.equal(ticket.assignments.length, 1, 'a resume is not a new Assignment');

  const key = useApp.getState().activeKey as string;
  const out = capture(key);
  handshake(key, 18, 'S1');
  await until('the feedback to be sent', () => out.some((m) => m.t === 'user_message'));
  assert.equal(out.find((m) => m.t === 'user_message')?.text, 'tighten the tests');
  assert.equal(out.some((m) => m.t === 'ticket_bind'), false, 'the binding comes back with the session\u2019s own metadata');
  unregisterRuntime(key);
});

test('send back whose session cannot be resumed starts a replacement and pre-fills brief and feedback', async () => {
  screen(18, 'S-other');
  const t = ticketAt('review', {}, { sessionId: '', sessionKey: 'k-gone' }); // never named: nothing to resume
  install(t);

  const result = await useApp.getState().sendBackTicket(t.id, 'fix the typo');
  assert.equal(result.ok, true);
  const ticket = useApp.getState().tickets[0];
  assert.equal(ticket.status, 'running');
  assert.equal(ticket.assignments.length, 2);
  assert.equal(ticket.assignments[0].end, 'restore_failed');
  assert.equal(ticket.assignments[1].end, null);

  const key = useApp.getState().activeKey as string;
  const out = capture(key);
  handshake(key, 18, 'S-new');
  await until('the replacement to be pre-filled', () => (useApp.getState().sessions[key]?.draft ?? '') !== '');
  assert.equal(useApp.getState().sessions[key]?.draft, 'do the thing\n\nfix the typo');
  assert.deepEqual(out.map((m) => m.t), ['ticket_bind'], 'bound, but nothing is sent on the person\u2019s behalf');
  unregisterRuntime(key);
});

test('send back that can neither resume nor open leaves the Ticket in review', async () => {
  screen(18, 'S-other');
  const t = ticketAt('review', {}, { sessionId: '', sessionKey: 'k-gone' });
  install(t);
  refuseLocal = 'no';
  const result = await useApp.getState().sendBackTicket(t.id, 'please redo');
  assert.deepEqual(result, { ok: false, reason: 'session_unavailable' });
  assert.equal(useApp.getState().tickets[0].status, 'review', 'not "running" with nobody listening');
  assert.equal(useApp.getState().tickets[0].assignments.length, 1);
});

test('"continue" focuses a live session and otherwise resumes it on the machine it ran on', async () => {
  screen(18, 'S1');
  useApp.setState((s) => ({
    sessions: { ...s.sessions, 'k-other': liveBucket('k-other', 'C:/elsewhere', 18, 'S-x') },
    order: [...s.order, 'k-other'],
    activeKey: 'k-other',
  }));
  const t = ticketAt('running');
  install(t);
  assert.equal(await useApp.getState().openTicketSession(t.id), 'k-active');
  assert.equal(useApp.getState().activeKey, 'k-active', 'the live session is focused, nothing is reopened');
  assert.equal(localCalls.length, 0);

  // Now a remote Assignment whose session is closed, from a *local* screen:
  // the resume goes to the remote workspace, not to where the screen is.
  const remote = { ...ticketAt('running', {}, { remoteWorkspaceId: 'rw-1', sessionId: 'S-remote', sessionKey: 'k-gone' }), id: 'tk-remote' };
  install(remote);
  const key = await useApp.getState().openTicketSession('tk-remote');
  assert.ok(key);
  assert.equal(localCalls.length, 0, 'never the local spawn');
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].remoteWorkspace, ENTRY.remotePath);
  assert.equal(remoteCalls[0].sessionId, 'S-remote');
  assert.equal(useApp.getState().tickets[0].status, 'running', 'resuming moves no status');
});

test('"continue" on a needs_you Ticket resumes the session and stays needs_you', async () => {
  screen(18, 'S-other');
  const t = ticketAt('needs_you');
  install(t);
  const key = await useApp.getState().openTicketSession(t.id);
  assert.ok(key);
  assert.equal(localCalls[0].sessionId, 'S1');
  assert.equal(useApp.getState().tickets[0].status, 'needs_you', 'only the person replying moves it (invariant 7)');
});

test('removing a Ticket unbinds the session it had', () => {
  screen(18, 'S1');
  const out = capture('k-active');
  const t = ticketAt('running');
  install(t);
  assert.equal(useApp.getState().removeTicket(t.id), true);
  assert.equal(useApp.getState().tickets.length, 0);
  assert.equal(out[0]?.ticket, null);
  unregisterRuntime('k-active');
});

/* ============================================================
   A start whose session never came up
   ============================================================ */

test('a start whose session never handshakes moves the Ticket to needs_you with "Start over"', async () => {
  screen();
  const t = ticketAt('open');
  install(t);

  // The child is opened and `start` writes `running` before anything waits on
  // it. No `init` ever lands, so the Assignment has no session id — which makes
  // "Continue" (`canResumeAssignment`) false and leaves `running` with no way
  // out at all. `gone` is that branch: the bucket went away while the start was
  // still waiting for its handshake.
  const key = await useApp.getState().startTicket(t.id);
  assert.ok(key);
  assert.equal(useApp.getState().tickets[0].status, 'running');
  const out = capture(key);

  await useApp.getState().detachSession(key);

  await until('the Ticket to move', () => useApp.getState().tickets[0].status === 'needs_you');
  const after = useApp.getState().tickets[0];
  assert.equal(currentAssignment(after)?.executor.sessionId, '', 'nothing taught it an id');
  assert.deepEqual(ticketActions(after.status, false), ['continue', 'restart'], 'Start over is offered');
  assert.equal(needsYouCause(after), 'unreachable', 'and the card says why, not "crashed"');
  assert.equal(after.assignments.length, 1, 'the Assignment is not ended: a report or a close is an event');
  assert.equal(out.length, 0, 'nothing was sent to a child that never answered');
  unregisterRuntime(key);
});

test('the unreachable landing says nothing about a Ticket that has moved on', () => {
  screen();
  const t = ticketAt('running');
  install(t);
  // The Ticket was dropped while the handshake was being waited on. The fact is
  // still true about the session, but it is not this Ticket's news any more —
  // and an unrequested exit on a dropped Ticket must not resurrect it.
  useApp.getState().dropTicket(t.id);
  const dropped = useApp.getState().tickets[0];
  assert.equal(dropped.status, 'dropped');
  landTicketUnreachable(
    { get: useApp.getState, patchWith: () => undefined, patch: () => undefined, set: useApp.setState } as never,
    'k-gone',
    t.id,
  );
  assert.equal(useApp.getState().tickets[0], dropped, 'the same object: nothing was written');
});

/* ============================================================
   The ceilings a bind is validated against
   ============================================================ */

test('the desktop\u2019s ceilings are the runtime\u2019s, which is the only way this stays true', () => {
  // Two languages and one rule: the runtime refuses an oversized `ticket_bind`
  // and the desktop must refuse to make such a Ticket, or the card says Running
  // with no report tool behind it. Nothing at build time can compare the two
  // constants, so this reads them.
  const source = readFileSync(
    resolve(process.cwd(), '..', '..', 'internal', 'state', 'ticket.go'),
    'utf8',
  );
  const value = (name: string): number => {
    const match = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    assert.ok(match, `${name} is not declared in internal/state/ticket.go`);
    return Number(match[1]);
  };
  assert.equal(TICKET_TITLE_CEILING, value('TicketTitleCeiling'));
  assert.equal(TICKET_BRIEF_CEILING, value('TicketBriefCeiling'));
});

test('a Ticket whose bind would be refused cannot be created or edited into one', () => {
  screen();
  const tooLong = 'x'.repeat(TICKET_BRIEF_CEILING + 1);
  assert.equal(useApp.getState().createTicket({ brief: tooLong }), null, 'not stored at all');
  assert.equal(useApp.getState().tickets.length, 0);
  assert.equal(unbindableField({ title: '', brief: tooLong }), 'brief');
  assert.equal(unbindableField({ title: 'x'.repeat(TICKET_TITLE_CEILING + 1), brief: 'b' }), 'title');
  assert.equal(unbindableField({ title: 'ok', brief: tooLong.slice(1) }), null, 'the ceiling itself is allowed');

  // The same rule from the other end: an edit that would grow past it is a
  // refusal with a reason, not a stored record that fails at Start.
  const id = useApp.getState().createTicket({ brief: 'fine' });
  assert.ok(id);
  const result = useApp.getState().updateTicketDraft(id, { brief: tooLong });
  assert.equal(result.ok, false);
  assert.equal(useApp.getState().tickets[0].brief, 'fine', 'the record is untouched by a refused edit');
  assert.equal(canBindBrief({ title: '', brief: tooLong }), false);
  assert.equal(canBindBrief({ title: '', brief: 'fine' }), true);
});

/* ============================================================
   Dragging a card into another lane
   ============================================================ */

/**
 * **The table is the contract.**
 *
 * A lane's meaning has to be one of the card's own buttons — that is what stops
 * the drag from becoming a second state machine. So the assertions come in
 * pairs: the lanes that light up, and (the half that decays silently) the lanes
 * that must never light up.
 */
test('a lane means exactly what one of the card\u2019s own buttons means', () => {
  // open → Running is `start` (or `runNow`, decided by the dialog or the memory).
  assert.deepEqual(dropTargets('open'), { running: { kind: 'begin' } });
  // review → Done is `accept`; review → Running is `sendBack` (with an opinion).
  assert.deepEqual(dropTargets('review'), {
    done: { kind: 'accept' },
    running: { kind: 'sendBack' },
  });
  // Finished → Open is `reopen`.
  assert.deepEqual(dropTargets('done'), { open: { kind: 'reopen' } });
  assert.deepEqual(dropTargets('dropped'), { open: { kind: 'reopen' } });
});

test('no lane can do what only an agent or the person\u2019s own buttons can', () => {
  // `running → needs_you` / `review` are `reported` facts. A person has no
  // command for either, so no lane may offer one.
  assert.deepEqual(dropTargets('running'), {});
  // `needs_you → running` is two intents (continue does not even move the
  // status — invariant 7), so both stay buttons.
  assert.deepEqual(dropTargets('needs_you'), {});
  // **Done is never a drop target for a live card**: it owns `done` *and*
  // `dropped`, so a drop there could not say which it meant.
  assert.equal(dropTargets('open').done, undefined);
  assert.equal(dropTargets('running').done, undefined);
  assert.equal(dropTargets('needs_you').done, undefined);
  // Open is not a target for a live card either: nothing `open → open` means.
  assert.equal(dropTargets('open').open, undefined);
  assert.equal(dropTargets('review').open, undefined);
});

test('a lane that would do nothing raises no highlight, and one that would is named', () => {
  assert.equal(acceptsDrop('open', 'running'), true);
  assert.equal(acceptsDrop('open', 'review'), false);
  assert.equal(acceptsDrop('running', 'needs_you'), false);
  assert.equal(acceptsDrop('running', 'done'), false, 'Done must not promise a move it cannot mean');
  assert.equal(acceptsDrop('review', 'done'), true);
  assert.equal(acceptsDrop('review', 'running'), true, 'a review can go back to work');
  assert.equal(acceptsDrop('done', 'open'), true);
});

test('the drop is announced in the words the buttons use', () => {
  assert.equal(dropVerb({ kind: 'begin' }, 'run_now'), 'begin.run_now');
  assert.equal(dropVerb({ kind: 'begin' }, 'start'), 'begin.start');
  assert.equal(dropVerb({ kind: 'accept' }), 'accept');
  assert.equal(dropVerb({ kind: 'sendBack' }), 'sendBack');
  assert.equal(dropVerb({ kind: 'reopen' }), 'reopen');
  // Every verb has words, or the announcement would be a missing key.
  for (const verb of ['begin.start', 'begin.run_now', 'accept', 'sendBack', 'reopen'] as const) {
    assert.ok(en[`ticket.drop.verb.${verb}`], `no copy for ticket.drop.verb.${verb}`);
    assert.ok(en[`ticket.drop.announce.${verb}`], `no copy for ticket.drop.announce.${verb}`);
  }
});

test('a drag never leaves the board, and a card\u2019s Start button still does', () => {
  // The whole point of the feature: a drop is watched on the board.
  assert.equal(staysOnBoard('drag', false), true, 'an attended drag must not open the conversation');
  assert.equal(staysOnBoard('drag', true), true);
  // The card's own Start hands the brief over, so it goes where the brief is.
  assert.equal(staysOnBoard('card', false), false);
  // Run now has nothing to hand over: the card moves to Running by itself.
  assert.equal(staysOnBoard('card', true), true);

  // Both entry points ask the rule; neither decides it locally. The drag's
  // branch never fires (the function answers `true` for `'drag'`), and it is
  // written out so a third entry point has something to copy.
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  const drag = src.slice(src.indexOf('const beginFromDrop'), src.indexOf('const applyDrop'));
  assert.match(drag, /staysOnBoard\('drag'/, 'the drop path no longer asks the rule');
  const card = src.slice(src.indexOf('const act = {'), src.indexOf("type: 'accept'"));
  assert.match(card, /staysOnBoard\('card'/, 'the card\u2019s Start no longer asks the rule');
});

test('a first-run board asks how to start, and only a stored answer skips the dialog', () => {
  // The one mistake here that spends money before anyone reads a dialog.
  assert.equal(rememberedStartMode('ask'), null, 'the default must ask');
  assert.equal(rememberedStartMode('start'), 'start');
  assert.equal(rememberedStartMode('run_now'), 'run_now');
});

test('a running card that has not sent its brief says so, and stays in Running', () => {
  const base = { status: 'running' as const, live: true, ready: true, draft: 'do the thing', hasSpoken: false, brief: 'do the thing' };
  // The attended start: brief parked in the input box, nothing sent.
  assert.equal(ticketRunState(base), 'awaiting_send');
  // Sent (or any turn in flight): ordinary working.
  assert.equal(ticketRunState({ ...base, hasSpoken: true }), 'sent');
  // A draft that is not the brief is the person's own typing, not a parked one.
  assert.equal(ticketRunState({ ...base, draft: 'something else' }), 'sent');
  assert.equal(ticketRunState({ ...base, draft: '' }), 'sent');
  // Handshake not landed.
  assert.equal(ticketRunState({ ...base, ready: false }), 'connecting');
  // No live session, or not running at all: the card's own badges explain it.
  assert.equal(ticketRunState({ ...base, live: false }), 'idle');
  assert.equal(ticketRunState({ ...base, status: 'review' }), 'idle');
});

test('the start memory is a window preference: it defaults to asking, and a corrupt record asks too', () => {
  // Read the module as text: `prefs.ts` touches `localStorage` at import time,
  // which this suite's Node host does not have. The rules asserted are the two
  // that matter — the default, and that nothing is coerced into `run_now`.
  const src = readFileSync(resolve(process.cwd(), 'src/state/prefs.ts'), 'utf8');
  assert.match(src, /ticketStartMode: 'ask',/, 'a first launch must ask');
  assert.match(
    src,
    /parsed\.ticketStartMode === 'start' \|\| parsed\.ticketStartMode === 'run_now'[\s\S]*?: 'ask',/,
    'a corrupted record must fall back to asking, never to running unattended',
  );
});

test('the board draws the drag, and the card never swallows a press on a control', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  // The drag is a pointer gesture, not HTML5 drag-and-drop: a WebView shares
  // `dragstart` with the OS file-drop channel and it has no touch support.
  assert.equal(src.includes('draggable='), false, 'the card must not be HTML5-draggable');
  assert.match(src, /onPointerDown/, 'the card has no pointer-down handler: nothing can be dragged');
  assert.match(
    src,
    /closest\('button, a, input, textarea, select, \[role="menu"\]'\)/,
    'a press on a control inside the card must stay that control\u2019s press',
  );
  // The lane head states the verb before the release, and the ghost does too.
  assert.match(src, /tkb-lane-verb/);
  assert.match(src, /tkb-drag-ghost/);
  // Escape cancels in flight, in capture, before the window's own Esc closes
  // the board.
  assert.match(src, /window\.addEventListener\('keydown', key, true\)/);
});

test('the menu offers every move a drop could make \u2014 the drag is never the only way', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  // Both the lane and the menu read `dropTargets`; a hand-written second list
  // is what would let them drift.
  const drops = [...src.matchAll(/dropTargets\(/g)];
  assert.ok(drops.length >= 3, 'the drop table is no longer the one source for lanes and menu items');
  assert.match(src, /moveEntries\.map/, 'the menu no longer lists the moves');
});

test('the release decides the drop before React is asked to re-render', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  const up = src.slice(src.indexOf('function up('), src.indexOf('function cancel('));
  // Running the command inside a `setDrag` updater would put it in the render
  // phase, where React may invoke the updater more than once — and `start`
  // twice means two sessions for one Ticket. The card in flight is read off
  // the ref the render is drawing instead.
  assert.equal(
    /setDrag\(\(current\)[\s\S]*?onDrop\(/.test(up),
    false,
    'the drop command runs inside a state updater: it can fire more than once',
  );
  assert.match(up, /const current = dragRef\.current;/, 'the release no longer reads the card from the ref');
  assert.match(up, /setDrag\(null\);/, 'the flight state is not cleared before the command runs');
  // The auto-scroll must not be inside the updater either, for the same reason.
  const move = src.slice(src.indexOf('function move('), src.indexOf('function up('));
  const opener = move.indexOf('setDrag((current) => {');
  assert.ok(opener >= 0, 'the pointer-move branch no longer updates the drag');
  const body = move.slice(opener, move.indexOf('});', opener));
  assert.equal(
    body.includes('autoScroll('),
    false,
    'scrolling runs inside a state updater',
  );
});

test('a filtered board does not lift a card, because there is nowhere to drop it', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  // The filter draws one full-width lane, so every other lane is off screen: a
  // gesture that could only be released over nothing must not start.
  assert.match(src, /if \(!enabled\) return;/, 'the drag ignores whether any drop target is on screen');
  assert.match(src, /filter === 'all',/, 'the hook is not told which board it is on');
  // The menu path stays available under a filter, since it needs no second lane.
  assert.match(src, /moveEntries\.map/);
});

test('a remembered start mode has a way back, or it could never be changed again', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  const card = src.slice(src.indexOf('function TicketCard'));
  // Ticking "do this from now on" suppresses the dialog, so the only route back
  // is the card's own menu. Without it the dialog's hint would point at a screen
  // that never appears again.
  assert.match(card, /onAskStart/, 'the card has no route back into the start dialog');
  assert.match(card, /t\('ticket\.menu\.startOptions'\)/, 'the menu item that opens it is gone');
  // Pinned to Open: that is the only status a start belongs to.
  assert.match(card, /status === 'open' \? \(/, 'the start-options item is not gated on the status');
  // And the dialog offers to stop remembering, which is the other half.
  const dialog = src.slice(src.indexOf('function StartDialog'), src.indexOf('function TicketCard'));
  assert.match(dialog, /t\('ticket\.start\.remember'\)/);
  assert.ok(en['ticket.menu.startOptions'] !== undefined);
});


/**
 * Where the name sits, and why the model menu can be wheeled.
 *
 * Both are one-line facts with nothing to observe in Node: the field order is
 * markup, and the wheel is a Radix scroll lock that only exists in a browser.
 * They are pinned as source so a later edit cannot quietly put the brief back
 * on top, or drop the `modal` that makes the catalogue scroll inside the
 * dialog (Radix's dialog cancels wheel events outside its own content, and a
 * portalled menu is outside it — the list then draws a scrollbar and refuses
 * to move, which is the report this fixes).
 */
test('the dialog names the work before it briefs it', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  const dialog = src.slice(src.indexOf('function TicketDialog'), src.indexOf('function TicketCard'));
  const title = dialog.indexOf("t('ticket.field.title')");
  const brief = dialog.indexOf("t('ticket.field.brief')");
  assert.ok(title >= 0 && brief >= 0, 'the title and brief labels are gone from TicketDialog');
  assert.ok(
    title < brief,
    'the title field is drawn below the brief: the name is the first thing on the sheet',
  );
});

test('the model menu is modal, which is what lets the wheel turn it inside a dialog', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/panels/TaskPanel.tsx'), 'utf8');
  const picker = src.slice(src.indexOf('export function ModelPicker'), src.indexOf('function TaskInfo'));
  const at = picker.indexOf('<PopoverPrimitive.Root');
  assert.ok(at >= 0, 'ModelPicker no longer renders a PopoverPrimitive.Root');
  const rootTag = picker.slice(at, picker.indexOf('>', at));
  assert.match(
    rootTag,
    /\n\s+modal\r?\n/,
    'the model popover lost `modal`: inside a dialog, Radix cancels the wheel ' +
      'events that land on this portalled menu, so the catalogue stops scrolling',
  );
});

/* ---------------- the card's housekeeping menu ---------------- */

/**
 * Edit, drop and delete are housekeeping, not the card's verbs: they sit behind
 * one ⋯ (and a right-click) rather than on a row of their own. Pinned as source
 * for the same reason as the dialog's markup: the shape is the decision, and
 * Node has no browser to click it in.
 *
 * The check that matters beyond the shape is `canDrop`: the record decides
 * whether "Drop" exists at all, so a Done card's menu is two rows, not three.
 * A menu that offered it everywhere would be a button whose only press is a
 * refusal.
 */
test('the card keeps edit, drop and delete behind one menu, and drop follows the status', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/components/board/TicketBoard.tsx'), 'utf8');
  const card = src.slice(src.indexOf('function TicketCard'));
  assert.equal(
    card.includes('tkb-card-tools'),
    false,
    'the three icon buttons are back on a row of their own; they belong in the card menu',
  );
  assert.match(card, /aria-haspopup="menu"/, 'the ⋯ trigger no longer says it opens a menu');
  assert.match(card, /onContextMenu=/, 'the card lost its right-click way into the same menu');
  assert.match(
    card,
    /\{canDrop\(status\) \? \(/,
    'Drop is offered without asking the record whether the status can be given up',
  );
});

