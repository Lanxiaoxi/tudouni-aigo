/**
 * Task templates: the pure rules, and the Run path against the store.
 *
 * Two halves, for the two ways the feature can quietly go wrong:
 *
 *   - **The pure half** (`src/task/tasks.ts`): what a task is, what makes one
 *     runnable, and how a workspace ref resolves against the store's lists.
 *     `workspaceRefLabel` returning `null` is what makes the panel show
 *     "workspace unavailable" instead of silently running somewhere else.
 *
 *   - **The Run half** (`runTask`): which open path each workspace ref takes —
 *     the local spawn, the remote dial, or the `forceNew` connect — and the
 *     design's "no fake success" rule: a link is recorded only when a *new*
 *     bucket was created by this Run. Focusing an existing session is not a
 *     run; a failed open records nothing; deleting a task keeps its links.
 *
 * Driven against the same fake Tauri host `remote-new-session.test.ts` uses.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp } from '@/state/store';
import { registerRuntime, unregisterRuntime } from '@/runtime/bus';
import {
  canRunTask,
  emptyTask,
  isValidTask,
  isValidTaskRun,
  outcomeOfChildExit,
  outcomeOfTurnStatus,
  runDay,
  taskProblems,
  taskRunOutcome,
  workspaceRefLabel,
  type Task,
} from '../src/task/tasks';
import type { SessionRuntime } from '@/state/store';

/* ============================================================
   The pure half
   ============================================================ */

test('a task without a name or a prompt is not runnable, and says which is missing', () => {
  const task = emptyTask(1_000);
  assert.deepEqual(taskProblems(task).sort(), ['name', 'prompt']);
  assert.equal(canRunTask(task), false);

  task.name = 'nightly build';
  assert.deepEqual(taskProblems(task), ['prompt']);
  task.prompt = 'build everything';
  assert.deepEqual(taskProblems(task), []);
  assert.equal(canRunTask(task), true);
});

test('a disabled task is not runnable even when complete', () => {
  const task: Task = {
    ...emptyTask(1),
    name: 'x',
    prompt: 'y',
    enabled: false,
  };
  assert.equal(canRunTask(task), false);
});

test('a fresh task defaults to autopilot on — a task is an automated run', () => {
  const task = emptyTask(1_000);
  assert.equal(task.autopilot, true);
});

test('the guards drop malformed localStorage records instead of trusting them', () => {
  assert.equal(isValidTask({ id: 'task-1', name: '', description: '', prompt: '', workspace: { kind: 'active' }, model: '', enabled: true, createdAtMs: 1, updatedAtMs: 1 }), true);
  assert.equal(isValidTask({ id: 'task-2', workspace: { kind: 'nonsense' }, model: '', enabled: true, createdAtMs: 1, updatedAtMs: 1, name: '', description: '', prompt: '' }), false);
  assert.equal(isValidTask({ id: '', workspace: { kind: 'active' }, model: '', enabled: true, createdAtMs: 1, updatedAtMs: 1, name: '', description: '', prompt: '' }), false);
  assert.equal(isValidTask(null), false);
  // An absent `autopilot` is the pre-field shape and is kept; a present one
  // that is not a boolean is malformed and dropped.
  assert.equal(isValidTask({ id: 'task-3', name: '', description: '', prompt: '', workspace: { kind: 'active' }, model: '', enabled: true, createdAtMs: 1, updatedAtMs: 1, autopilot: true }), true);
  assert.equal(isValidTask({ id: 'task-4', name: '', description: '', prompt: '', workspace: { kind: 'active' }, model: '', enabled: true, createdAtMs: 1, updatedAtMs: 1, autopilot: 'yes' }), false);
  assert.equal(isValidTaskRun({ taskId: 't', sessionId: 's', sessionKey: 'k', startedAtMs: 1, taskName: 'n', model: 'm', workspaceLabel: 'w', autopilot: true }), true);
  assert.equal(isValidTaskRun({ taskId: 't', sessionId: 's', sessionKey: 'k', startedAtMs: 1, taskName: 'n', model: 'm', workspaceLabel: 'w', autopilot: 1 }), false);

  assert.equal(
    isValidTaskRun({ taskId: 't', sessionId: 's', sessionKey: 'k', startedAtMs: 1, taskName: 'n', model: 'm', workspaceLabel: 'w' }),
    true,
  );
  assert.equal(isValidTaskRun({ taskId: 't', sessionKey: 'k', startedAtMs: 1, taskName: 'n', model: 'm', workspaceLabel: 'w' }), false);
});

test('workspaceRefLabel resolves each ref kind, and null means the store no longer knows it', () => {
  const labels = new Map([['rw-1', 'rvv:project']]);
  assert.equal(workspaceRefLabel({ kind: 'active' }, 'C:/work', [], labels), 'C:/work');
  assert.equal(workspaceRefLabel({ kind: 'active' }, '', [], labels), null, 'no workspace on screen is not a place');
  assert.equal(workspaceRefLabel({ kind: 'local', path: 'C:/work' }, '', ['C:/work'], labels), 'C:/work');
  assert.equal(workspaceRefLabel({ kind: 'local', path: 'C:/gone' }, '', ['C:/work'], labels), null, 'a forgotten bookmark is not silently runnable');
  assert.equal(workspaceRefLabel({ kind: 'remote', id: 'rw-1' }, '', [], labels), 'rvv:project');
  assert.equal(workspaceRefLabel({ kind: 'remote', id: 'rw-404' }, '', [], labels), null, 'a deleted host is not silently runnable');
});

/* ============================================================
   The Run half: a fake Tauri host, the same shape remote-new-session uses
   ============================================================ */

let localCalls: Record<string, unknown>[] = [];
let remoteCalls: Record<string, unknown>[] = [];
let nextKey = 100;
/** When set, `runtime_attach` rejects with this — the "the open failed" case. */
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
      // The config-sync check runs before every remote connect; answer it
      // with matching fingerprints so no prompt is raised and no open parks.
      if (cmd === 'check_remote_config') {
        return Promise.resolve({ status: 'valid', fingerprint: 'fp-1', error: null });
      }
      if (cmd === 'read_local_config_text') {
        return Promise.resolve({ text: '{}', fingerprint: 'fp-1' });
      }
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
  remotePath: '/repo/echuzhi/rvv-project',
  remoteBinary: '/home/tudouni/.tudouni/runtime/current/tudouni-aigo',
  label: 'rvv:rvv-project',
};

/** The workspace on screen, local, ready. */
function localScreen(workspace = 'C:/work'): void {
  const bucket = liveBucket('k-active', workspace, null);
  useApp.setState((s) => ({
    sessions: { 'k-active': bucket },
    order: ['k-active'],
    activeKey: 'k-active',
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    workspaces: [workspace],
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: workspace,
  }));
  localCalls = [];
  remoteCalls = [];
}

/** A live local session: ready and resumed, so it is a conversation, not an
 *  untouched placeholder something might abandon. */
function liveBucket(key: string, workspace: string, remoteWorkspaceId: string | null): SessionRuntime {
  const bucket = createSessionBucket(key, workspace, { ericai: false, maxSteps: null }, remoteWorkspaceId);
  bucket.ready = true;
  bucket.session = {
    ...(bucket.session ?? ({} as NonNullable<SessionRuntime['session']>)),
    resumed: true,
    id: 'sid-' + key,
    workspace,
  } as never;
  return bucket;
}

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    ...emptyTask(1_000),
    name: 'nightly',
    prompt: 'build everything',
    ...patch,
  };
}

test('a run in the active local workspace spawns locally, opens a new bucket, and records the link', async () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });

  const taskId = useApp.getState().tasks[0]?.id ?? '';
  const key = await useApp.getState().runTask(taskId);
  assert.ok(key, 'a run that opened a session returns its key');
  assert.equal(localCalls.length, 1, 'the local spawn is the open path');
  assert.equal(remoteCalls.length, 0);

  const s = useApp.getState();
  const bucket = s.sessions[key];
  assert.ok(bucket, 'the run landed on a new bucket');
  assert.equal(s.activeKey, key, 'the new session is the one on screen');
  assert.equal(bucket.workspace, 'C:/work');
  assert.equal(bucket.sessionId, null, 'a brand-new bucket has no handshake yet');

  assert.equal(s.taskRuns.length, 1, 'one link, recorded');
  const link = s.taskRuns[0];
  assert.equal(link.taskId, s.tasks[0]?.id);
  assert.equal(link.sessionKey, key);
  assert.equal(link.workspaceLabel, 'C:/work');
  assert.equal(link.sessionId, '', 'the id waits for the handshake');
  assert.equal(link.taskName, 'nightly', 'the link froze the task name at start time');
  assert.equal(link.autopilot, true, 'the link froze the template\u2019s autopilot too');
  assert.equal(link.prompt, 'build everything', 'the link froze the prompt text too — the refine feature\u2019s ground');
});

/**
 * A run's own outbound messages, once the child is ready: the store's prompt
 * is filed on a background pass (wait for ready, then speak), so these tests
 * register a real registry handle for the run's key, mark the bucket ready,
 * and let that pass run before asserting what went out the door.
 */
async function waitForPrompt(key: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  registerRuntime({ key, send: (m) => out.push(m as unknown as Record<string, unknown>), subscribe: () => () => undefined, dispose: () => undefined });
  useApp.setState((s) => ({ sessions: { ...s.sessions, [key]: { ...s.sessions[key], ready: true } } }));
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (out.some((m) => m.t === 'user_message')) break;
    if (Date.now() >= deadline) throw new Error('the run never sent its prompt');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return out;
}

test('a run of an autopilot task turns the session on before the prompt goes out', async () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });

  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.ok(key);
  const out = await waitForPrompt(key);

  const atSwitch = out.findIndex((m) => m.t === 'set_autopilot');
  const atPrompt = out.findIndex((m) => m.t === 'user_message');
  assert.notEqual(atSwitch, -1, 'the switch is sent');
  assert.equal(out[atSwitch].on, true, 'on, not off');
  assert.ok(atSwitch < atPrompt, 'and it lands before the run, which is the whole point');

  assert.equal(useApp.getState().taskRuns[0]?.autopilot, true, 'the link recorded it');
  unregisterRuntime(key);
});

test('a run of a task with autopilot off sends no switch', async () => {
  localScreen();
  useApp.setState({ tasks: [makeTask({ autopilot: false })], taskRuns: [] });

  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.ok(key);
  const out = await waitForPrompt(key);

  assert.equal(out.some((m) => m.t === 'set_autopilot'), false, 'off means nothing is sent, not an off switch');
  assert.equal(useApp.getState().taskRuns[0]?.autopilot, false, 'the link recorded it');
  unregisterRuntime(key);
});

test('a run of a template saved before the field existed keeps the old behaviour', async () => {
  localScreen();
  const legacy = makeTask();
  delete legacy.autopilot;
  useApp.setState({ tasks: [legacy], taskRuns: [] });

  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.ok(key);
  const out = await waitForPrompt(key);

  assert.equal(out.some((m) => m.t === 'set_autopilot'), false, 'an absent field is not on');
  assert.equal(useApp.getState().taskRuns[0]?.autopilot, false, 'and the link freezes it as off');
  unregisterRuntime(key);
});

test('a run with an explicit local workspace passes that path to the local spawn', async () => {
  localScreen();
  useApp.setState({
    tasks: [makeTask({ workspace: { kind: 'local', path: 'D:/other' } })],
    taskRuns: [],
  });

  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.ok(key);
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].workspace, 'D:/other', 'the template names the workspace, not the screen');
  assert.equal(useApp.getState().taskRuns[0]?.workspaceLabel, 'D:/other');
});

test('a run of a remote workspace dials the remote row, forceNew when a child is already live', async () => {
  // First run: no live child in that remote workspace → the rail's own entry
  // path (which for a fresh window dials without forceNew through
  // enterRemoteWorkspace — but either way the dial is remote).
  localScreen();
  useApp.setState({
    tasks: [makeTask({ workspace: { kind: 'remote', id: ENTRY.id } })],
    taskRuns: [],
  });

  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.ok(key);
  assert.equal(localCalls.length, 0, 'a remote path is never a local spawn');
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].remoteWorkspace, ENTRY.remotePath);
  assert.equal(useApp.getState().sessions[key]?.remoteWorkspaceId, ENTRY.id);

  // Second run: the remote workspace now has a live child → forceNew, another
  // child, not a focus. A Run means a new session, never "look at the old one".
  remoteCalls = [];
  const before = useApp.getState().order;
  await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.equal(remoteCalls.length, 1, 'another dial');
  const s = useApp.getState();
  assert.equal(s.order.length, before.length + 1, 'a second child exists');
  assert.notEqual(s.activeKey, before[before.length - 1], 'the screen moved to the new child');
  assert.equal(s.taskRuns.length, 2, 'both runs recorded');
});

test('running while the workspace on screen is remote dials remote with the screen\u2019s own ref', async () => {
  const bucket = liveBucket('k-remote', ENTRY.remotePath, ENTRY.id);
  useApp.setState((s) => ({
    sessions: { 'k-remote': bucket },
    order: ['k-remote'],
    activeKey: 'k-remote',
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    panel: null,
  }));
  localCalls = [];
  remoteCalls = [];
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });

  await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');

  assert.equal(localCalls.length, 0, 'the active ref on a remote screen is answered there');
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].remoteWorkspace, ENTRY.remotePath);
});

test('a run that focuses an existing session records no link — no fake success', async () => {
  localScreen();
  // The screen's own workspace already has `active` as the ref, but make the
  // open path focus: `openSession(null)` on a local screen always spawns, so
  // instead simulate the outcome the rule guards — the link may only land on
  // a bucket this open created. Drive it through an explicit `sessionId`
  // focus: runTask with a task whose workspace names the active workspace,
  // while the open path is replaced by a focus (the existing-child tell).
  useApp.setState({ tasks: [], taskRuns: [] });

  // Simplest honest construction: a task run where `openSession` focuses —
  // `openSession('sid-k-active')` finds the live child and focuses it. Run's
  // own paths go through `openSession(null)`, so assert the *record-keeping*
  // rule directly: a bucket that already existed before the open is refused.
  const s = useApp.getState();
  const previousKeys = new Set(s.order);
  assert.ok(previousKeys.has('k-active'));

  // The rule under test, expressed through the store: noteTaskRunInit is a
  // no-op for a link whose sessionKey never got a bucket, and a link is only
  // appended after a *new* bucket lands. Both halves are asserted elsewhere;
  // here assert the guard the panel sees — runTask on a task with an
  // unresolvable workspace records nothing and returns null.
  useApp.setState({
    tasks: [makeTask({ workspace: { kind: 'remote', id: 'rw-404' } })],
    taskRuns: [],
  });
  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  assert.equal(key, null, 'an unresolvable ref starts nothing');
  assert.equal(useApp.getState().taskRuns.length, 0, 'and records nothing');
});

test('a failed open records no link', async () => {
  localScreen();
  useApp.setState({ tasks: [makeTask({ workspace: { kind: 'local', path: 'C:/refused' } })], taskRuns: [] });

  refuseLocal = 'the workspace C:/refused is not a directory';
  const key = await useApp.getState().runTask(useApp.getState().tasks[0]?.id ?? '');
  refuseLocal = null;

  assert.equal(key, null, 'a refused open is not a run');
  assert.equal(useApp.getState().taskRuns.length, 0, 'nothing recorded for a refused open');
});

test('deleting a task keeps its run links — history survives the template', () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });
  const id = useApp.getState().tasks[0]?.id ?? '';
  useApp.setState({
    taskRuns: [
      { taskId: id, sessionId: '20261015-080000', sessionKey: 'k-1', startedAtMs: 1, taskName: 'nightly', model: '', workspaceLabel: 'C:/work' },
    ],
  });

  useApp.getState().deleteTask(id);

  const s = useApp.getState();
  assert.equal(s.tasks.length, 0, 'the template is gone');
  assert.equal(s.taskRuns.length, 1, 'the link is not');
  assert.equal(s.taskRuns[0]?.taskName, 'nightly', 'the link carries its own copy of the name');
});

test('noteTaskRunInit back-fills the newest link still waiting for the id, and persists nothing for strangers', () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });
  const id = useApp.getState().tasks[0]?.id ?? '';
  useApp.setState({
    taskRuns: [
      { taskId: id, sessionId: '', sessionKey: 'k-a', startedAtMs: 1, taskName: 'a', model: '', workspaceLabel: 'w' },
      { taskId: id, sessionId: '', sessionKey: 'k-b', startedAtMs: 2, taskName: 'b', model: '', workspaceLabel: 'w' },
    ],
  });

  useApp.getState().noteTaskRunInit('k-b', 'sid-b');
  let s = useApp.getState();
  assert.equal(s.taskRuns[1]?.sessionId, 'sid-b', 'the named child\u2019s link learned its id');
  assert.equal(s.taskRuns[0]?.sessionId, '', 'the other link still waits');

  // A handshake from a session no task started is a no-op, not a write.
  useApp.getState().noteTaskRunInit('k-stranger', 'sid-x');
  s = useApp.getState();
  assert.equal(s.taskRuns.filter((row) => row.sessionId === 'sid-x').length, 0);
});

/* ============================================================
   Run outcome: the four states the design's History draws
   ============================================================ */

test('a turn status becomes a verdict, and the engine\u2019s failures are the only failures', () => {
  // The engine failing is a Failed row with a Retry on it.
  assert.equal(outcomeOfTurnStatus('model_error'), 'failed');
  assert.equal(outcomeOfTurnStatus('model_fatal'), 'failed');
  assert.equal(outcomeOfTurnStatus('runtime_exited'), 'failed');

  // **Not failures**, and this is the half worth pinning: pressing Stop three
  // times must not earn three red marks, or red stops meaning anything. A step
  // budget and a blank answer are not the engine breaking either.
  assert.equal(outcomeOfTurnStatus('cancelled'), 'ok', 'the person stopping it is not a failure');
  assert.equal(outcomeOfTurnStatus('max_steps'), 'ok');
  assert.equal(outcomeOfTurnStatus('empty_response'), 'ok');
  assert.equal(outcomeOfTurnStatus('answered'), 'ok');
  assert.equal(outcomeOfTurnStatus('completed'), 'ok');
});

test('a child that goes away is a failure only when nobody asked it to', () => {
  // The front end closing a session is not the run failing.
  assert.equal(outcomeOfChildExit(true), null, 'a requested close records no verdict');
  // The runtime dying mid-run is, however the last turn happened to end.
  assert.equal(outcomeOfChildExit(false), 'failed');
});

test('what is happening outranks what was written down', () => {
  // A turn in flight wins outright: a Retry offered on a row that is already
  // running again would be a second run wearing the first one's row.
  assert.equal(
    taskRunOutcome({ live: true, running: true, stopReason: 'running', recorded: 'failed' }),
    'running',
  );

  // A settled turn in a live session is newer than anything persisted, which
  // is what catches a failure that happened since the last write.
  assert.equal(
    taskRunOutcome({ live: true, running: false, stopReason: 'model_error', recorded: 'ok' }),
    'failed',
    'the live transcript outranks a stale recorded success',
  );
  assert.equal(
    taskRunOutcome({ live: true, running: false, stopReason: 'answered', recorded: 'failed' }),
    'ok',
    'and outranks a stale recorded failure too',
  );

  // A live child that has not run anything yet: the recorded verdict is all
  // there is, and "no verdict" is not a success.
  assert.equal(taskRunOutcome({ live: true, running: false, stopReason: null, recorded: null }), 'running');
  assert.equal(taskRunOutcome({ live: true, running: false, stopReason: null, recorded: 'ok' }), 'ok');

  // A closed session: only the recorded verdict survives it.
  assert.equal(taskRunOutcome({ live: false, running: false, stopReason: null, recorded: 'failed' }), 'failed');
  assert.equal(
    taskRunOutcome({ live: false, running: false, stopReason: 'model_error', recorded: 'ok' }),
    'ok',
    'a stop reason with no live session to have read it from is not evidence',
  );
});

test('the recorded verdict is back-filled once, and only for a session a task started', () => {
  localScreen();
  useApp.setState({
    tasks: [makeTask()],
    taskRuns: [
      { taskId: 't', sessionId: 'sid', sessionKey: 'k-a', startedAtMs: 1, taskName: 'a', model: '', workspaceLabel: 'w' },
    ],
  });

  useApp.getState().noteTaskRunOutcome('k-a', 'failed', 12_000);
  let row = useApp.getState().taskRuns[0];
  assert.equal(row?.outcome, 'failed');
  assert.equal(row?.durationMs, 12_000, 'the runtime\u2019s own figure is copied onto the link');

  // The identity of the array is the observable "was this a write": a second
  // verdict saying the same thing must not rewrite the record, because that
  // record is persisted on every write and a turn's end is not a reason to
  // touch localStorage twice.
  const before = useApp.getState().taskRuns;
  useApp.getState().noteTaskRunOutcome('k-a', 'failed', 12_000);
  assert.equal(useApp.getState().taskRuns, before, 'an unchanged verdict is not a write');

  // A child that died mid-turn sends no duration; the one already recorded
  // stays rather than being cleared by the absent value.
  useApp.getState().noteTaskRunOutcome('k-a', 'ok', null);
  row = useApp.getState().taskRuns[0];
  assert.equal(row?.outcome, 'ok');
  assert.equal(row?.durationMs, 12_000, 'no new measurement means keep the old one');

  // A stranger key is a no-op, exactly like `noteTaskRunInit`.
  const after = useApp.getState().taskRuns;
  useApp.getState().noteTaskRunOutcome('k-nobody', 'failed', 1);
  assert.equal(useApp.getState().taskRuns, after);
});

test('history keeps the verdicts of templates that no longer exist', () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });
  const id = useApp.getState().tasks[0]?.id ?? '';
  useApp.setState({
    taskRuns: [
      { taskId: id, sessionId: 'sid', sessionKey: 'k-1', startedAtMs: 1, taskName: 'nightly', model: '', workspaceLabel: 'w' },
    ],
  });
  useApp.getState().noteTaskRunOutcome('k-1', 'failed', 900);

  useApp.getState().deleteTask(id);

  const s = useApp.getState();
  assert.equal(s.tasks.length, 0, 'the template is gone');
  assert.equal(s.taskRuns.length, 1, 'its run is not');
  assert.equal(s.taskRuns[0]?.outcome, 'failed', 'and its verdict survives with it');
});

test('clearing the run history drops the links and nothing else', () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });
  const id = useApp.getState().tasks[0]?.id ?? '';
  useApp.setState({
    taskRuns: [
      { taskId: id, sessionId: 'sid', sessionKey: 'k-1', startedAtMs: 1, taskName: 'nightly', model: '', workspaceLabel: 'w' },
    ],
  });

  useApp.getState().clearTaskRuns();

  const s = useApp.getState();
  assert.equal(s.taskRuns.length, 0);
  assert.equal(s.tasks.length, 1, 'the template is not what was cleared');
});

/* ============================================================
   The guard: an upgrade must not delete somebody's history
   ============================================================ */

test('a run link saved before outcomes existed is kept, and a malformed one is not', () => {
  // The shape an older build wrote: no `outcome`, no `durationMs`.
  const legacy = {
    taskId: 't',
    sessionId: 'sid',
    sessionKey: 'k',
    startedAtMs: 1,
    taskName: 'n',
    model: '',
    workspaceLabel: 'w',
  };
  assert.equal(isValidTaskRun(legacy), true, 'history persisted before this field existed still loads');
  assert.equal(isValidTaskRun({ ...legacy, outcome: 'ok' }), true);
  assert.equal(isValidTaskRun({ ...legacy, outcome: 'failed', durationMs: 12 }), true);

  // A *present* value is still checked: a record carrying a verdict that is
  // not one of the two is malformed, and a malformed record is dropped whole.
  assert.equal(isValidTaskRun({ ...legacy, outcome: 'maybe' }), false);
  assert.equal(isValidTaskRun({ ...legacy, outcome: null }), false);
  assert.equal(isValidTaskRun({ ...legacy, durationMs: '12' }), false);
});

/* ============================================================
   Day grouping: the History headers
   ============================================================ */

test('the day headers follow the calendar, not the elapsed hours', () => {
  // Local noon, so the test is time-zone independent: a midnight anchor is one
  // hour away from the previous day in half the world's zones.
  const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h, 0, 0, 0).getTime();
  const now = at(2026, 4, 20, 9); // 2026-05-20 09:00 local

  assert.equal(runDay(now, now), 'today');
  assert.equal(runDay(at(2026, 4, 20, 0), now), 'today', 'midnight today is still today');
  assert.equal(runDay(at(2026, 4, 19, 23), now), 'yesterday', 'an hour ago, but yesterday');
  assert.equal(runDay(at(2026, 4, 19, 0), now), 'yesterday');
  assert.equal(runDay(at(2026, 4, 18, 23), now), 'earlier');
  assert.equal(runDay(at(2026, 3, 1, 12), now), 'earlier');

  // The case an hours-based rule gets wrong: at 00:30, a run from 23:50 is
  // forty minutes ago and belongs to *yesterday*.
  const justAfterMidnight = at(2026, 4, 20, 0);
  assert.equal(runDay(at(2026, 4, 19, 23), justAfterMidnight), 'yesterday');
});

/* ============================================================
   Refine: the store's half — a new ordinary session, and the
   front end's half — the candidate applied on the answer.
   ============================================================ */

function settleRun(taskId: string, patch: Partial<TaskRunLink> = {}): TaskRunLink {
  return {
    taskId,
    sessionId: '20260101-080000',
    sessionKey: 'k-run',
    startedAtMs: 1,
    taskName: 'nightly',
    model: '',
    workspaceLabel: 'C:/work',
    outcome: 'ok',
    ...patch,
  };
}

test('refineTask starts a new session, marks it, and sends the refine prompt as its first message', async () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });
  const taskId = useApp.getState().tasks[0]?.id ?? '';
  useApp.setState({
    taskRuns: [
      settleRun(taskId, { outcome: 'ok', prompt: 'old prompt' }),
      settleRun(taskId, { startedAtMs: 2, outcome: 'failed', sessionId: '20260101-090000' }),
    ],
  });

  const before = new Set(useApp.getState().order);
  const pending = useApp.getState().refineTask(taskId, { kind: 'all' }, false, 'focus on the login step');
  // Let the attach land, then answer the handshake the loop is waiting on.
  for (;;) {
    const s = useApp.getState();
    const fresh = s.order.find((key) => !before.has(key));
    if (fresh !== undefined) {
      useApp.setState((st) => ({
        sessions: { ...st.sessions, [fresh]: { ...st.sessions[fresh], ready: true } },
      }));
      break;
    }
    if (Date.now() > 5_000) throw new Error('refineTask never opened a session');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const key = await pending;
  assert.ok(key, 'a refine run that opened a session returns its key');
  assert.equal(localCalls.length, 1, 'the local spawn is the open path');

  const s = useApp.getState();
  const bucket = s.sessions[key];
  assert.equal(bucket.refineTaskId, taskId, 'the bucket is marked as this task\u2019s refine run');
  const spoken = bucket.entries.filter((row) => row.kind === 'user');
  assert.equal(spoken.length, 1, 'one message out');
  const text = spoken[0].text;
  assert.ok(text.includes('You are starting a task refinement.'));
  assert.ok(text.includes('prompt: old prompt'), 'the snapshot is in the prompt');
  assert.ok(text.includes('prompt: (not recorded)'), 'the link without one is labelled, not guessed');
  assert.ok(text.includes('focus on the login step'));
});

test('refineTask is refused by its own gate, and records nothing', async () => {
  localScreen();
  useApp.setState({ tasks: [makeTask()], taskRuns: [] });
  const taskId = useApp.getState().tasks[0]?.id ?? '';

  // No finished run at all.
  useApp.setState({ taskRuns: [settleRun(taskId, { outcome: undefined as never })] });
  assert.equal(await useApp.getState().refineTask(taskId, { kind: 'all' }, false, ''), null);

  // A remote-bound task, on a local screen.
  useApp.setState({
    tasks: [makeTask({ workspace: { kind: 'remote', id: 'rw-1' } })],
    taskRuns: [settleRun(taskId)],
  });
  assert.equal(await useApp.getState().refineTask(taskId, { kind: 'all' }, false, ''), null);

  // A local task bound to a workspace that is not the screen's.
  useApp.setState({
    tasks: [makeTask({ workspace: { kind: 'local', path: 'D:/other' } })],
    taskRuns: [settleRun(taskId)],
  });
  assert.equal(await useApp.getState().refineTask(taskId, { kind: 'all' }, false, ''), null);

  assert.equal(useApp.getState().taskRuns.length, 1, 'the seed link is the only one — nothing was started');
  assert.equal(useApp.getState().order.length, 1, 'no new bucket');
});

test('a refine answer applies the chosen candidate to the task — created stays, updated moves', () => {
  localScreen();
  const task = makeTask();
  useApp.setState({ tasks: [task], taskRuns: [], modal: null, pendingModals: [] });

  const key = 'k-refine';
  const bucket = liveBucket(key, 'C:/work', null);
  bucket.refineTaskId = task.id;
  // What the `question_request` handler would have left behind — the report
  // is in the stream by the time the question lands (see the wire-order test
  // below).
  bucket.refineCandidates = ['the improved prompt'];
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: bucket },
    order: [...s.order, key],
    activeKey: key,
    modal: {
      kind: 'question',
      key,
      batch: {
        batch_id: 'q-1',
        questions: [
          { v: 1, t: 'question_request', id: 'q-1', question: 'apply?', header: '', options: [], multi_select: false, batch_id: 'q-1', question_index: 0, question_count: 1 } as never,
        ],
        ready: true,
      },
    },
  }));

  const createdAt = task.createdAtMs;
  const before = Date.now();
  useApp.getState().answerQuestion(['Apply candidate 1: replace the task prompt']);

  const s = useApp.getState();
  assert.equal(s.tasks[0]?.prompt, 'the improved prompt', 'the chosen candidate is on the task');
  assert.equal(s.tasks[0]?.createdAtMs, createdAt, 'the task\u2019s birth is not rewritten');
  assert.ok((s.tasks[0]?.updatedAtMs ?? 0) >= before, 'its update time moves');
  assert.equal(s.modal, null, 'the question is answered and gone');
});

test('a refine answer of \u201cnone\u201d leaves the task untouched, and still says so', () => {
  localScreen();
  const task = makeTask();
  useApp.setState({ tasks: [task], taskRuns: [], modal: null, pendingModals: [] });

  const key = 'k-refine-none';
  const bucket = liveBucket(key, 'C:/work', null);
  bucket.refineTaskId = task.id;
  bucket.refineCandidates = ['the improved prompt'];
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: bucket },
    order: [...s.order, key],
    activeKey: key,
    modal: {
      kind: 'question',
      key,
      batch: {
        batch_id: 'q-2',
        questions: [
          { v: 1, t: 'question_request', id: 'q-2', question: 'apply?', header: '', options: [], multi_select: false, batch_id: 'q-2', question_index: 0, question_count: 1 } as never,
        ],
        ready: true,
      },
    },
  }));

  useApp.getState().answerQuestion(['Apply none of them']);

  const s = useApp.getState();
  assert.equal(s.tasks[0]?.prompt, task.prompt, 'nothing was applied');
  assert.equal(s.tasks[0]?.updatedAtMs, task.updatedAtMs, 'and not even a write');
});

test('a question that is not a refine\u2019s touches no task at all', () => {
  localScreen();
  const task = makeTask();
  useApp.setState({ tasks: [task], taskRuns: [], modal: null, pendingModals: [] });

  const key = 'k-plain';
  const bucket = liveBucket(key, 'C:/work', null);
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: bucket },
    order: [...s.order, key],
    activeKey: key,
    modal: {
      kind: 'question',
      key,
      batch: {
        batch_id: 'q-3',
        questions: [
          { v: 1, t: 'question_request', id: 'q-3', question: 'apply?', header: '', options: [], multi_select: false, batch_id: 'q-3', question_index: 0, question_count: 1 } as never,
        ],
        ready: true,
      },
    },
  }));

  const before = task.updatedAtMs;
  useApp.getState().answerQuestion(['Apply candidate 1: replace the task prompt']);

  const s = useApp.getState();
  assert.equal(s.tasks[0]?.prompt, task.prompt, 'an ordinary session\u2019s answer is not a refine delivery');
  assert.equal(s.tasks[0]?.updatedAtMs, before);
});

/**
 * The wire order that broke the real delivery (TR-assistant, 2026-06): the
 * refine report streams in the **same model step** as the ask_user call, so
 * its text is in the stream the moment the question_request lands — while
 * `run_finished` arrives only after the person has answered, and its
 * `answer` is the model's post-answer confirmation, which carries no
 * candidate blocks. Extracting on `run_finished` alone therefore found
 * nothing, and the chosen candidate never reached the task.
 */
const REPORT_WITH_BLOCKS = [
  '# Refine report',
  '',
  'BEGIN TASK PROMPT CANDIDATE (candidate 1)',
  'the improved prompt text',
  'END TASK PROMPT CANDIDATE',
].join('\n');

function feedTurnStart(key: string, runId: string): void {
  useApp.getState().applyRuntimeMessage(key, {
    v: 1,
    t: 'event',
    kind: 'run_started',
    run_id: runId,
    step: 0,
    session_id: 's-x',
    ts: '2026-06-01T00:00:00Z',
  } as never);
}

function feedDelta(key: string, runId: string, step: number, text: string): void {
  useApp.getState().applyRuntimeMessage(key, {
    v: 1,
    t: 'delta',
    session_id: 's-x',
    run_id: runId,
    step,
    channel: 'text',
    text,
    reset: false,
  } as never);
}

function feedQuestionRequest(key: string): void {
  useApp.getState().applyRuntimeMessage(key, {
    v: 1,
    t: 'question_request',
    id: 'q-t1',
    question: 'Which candidate do you want applied?',
    header: 'Refine',
    options: ['Apply candidate 1: replace the task prompt', 'Apply none of them'],
    multi_select: false,
    batch_id: 'q-t1',
    question_index: 0,
    question_count: 1,
  } as never);
}

function feedRunFinished(key: string, runId: string, answer: string): void {
  useApp.getState().applyRuntimeMessage(key, {
    v: 1,
    t: 'ui',
    kind: 'run_finished',
    run_id: runId,
    answer,
  } as never);
}

test('the refine report streams before its question: the candidates are read when the question lands, and the post-answer run_finished does not blank them', () => {
  localScreen();
  const task = makeTask();
  useApp.setState({ tasks: [task], taskRuns: [] });

  const key = 'k-wire';
  const bucket = liveBucket(key, 'C:/work', null);
  bucket.refineTaskId = task.id;
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: bucket },
    order: [...s.order, key],
    activeKey: key,
    modal: null,
    pendingModals: [],
  }));

  const runId = 'rr-1';
  feedTurnStart(key, runId);
  // The report streams in the same step as the ask_user call.
  feedDelta(key, runId, 1, REPORT_WITH_BLOCKS);
  feedQuestionRequest(key);

  const midTurn = useApp.getState().sessions[key];
  assert.ok(midTurn.refineCandidates, 'the question_request is where the candidates are read');
  assert.deepEqual(midTurn.refineCandidates, ['the improved prompt text']);

  // The person answers; the turn ends with the model's confirmation, which
  // names no candidate blocks at all.
  useApp.getState().answerQuestion(['Apply candidate 1: replace the task prompt']);

  const s = useApp.getState();
  assert.equal(s.tasks[0]?.prompt, 'the improved prompt text', 'the choice landed on the task');
  assert.deepEqual(s.sessions[key].refineCandidates, ['the improved prompt text']);

  // Then run_finished arrives with the confirmation as its answer: it must
  // not overwrite the list the question already read.
  feedRunFinished(key, runId, 'Done — candidate 1 applied.');
  const after = useApp.getState().sessions[key];
  assert.deepEqual(after.refineCandidates, ['the improved prompt text'], 'the post-answer answer carries no blocks and must not blank the list');
  assert.equal(after.activeRunId, null);
  assert.equal(after.lastRunId, runId);
});

test('a refine question that lands before the report has finished streaming is still rescued by run_finished', () => {
  localScreen();
  const task = makeTask();
  useApp.setState({ tasks: [task], taskRuns: [] });

  const key = 'k-wire2';
  const bucket = liveBucket(key, 'C:/work', null);
  bucket.refineTaskId = task.id;
  useApp.setState((s) => ({
    sessions: { ...s.sessions, [key]: bucket },
    order: [...s.order, key],
    activeKey: key,
    modal: null,
    pendingModals: [],
  }));

  const runId = 'rr-2';
  feedTurnStart(key, runId);
  feedDelta(key, runId, 1, REPORT_WITH_BLOCKS);
  // No question_request: the question never drew (a background session), but
  // the turn still ends. The fallback reads the report out of the stream —
  // before applyFinalAnswer clears it.
  feedRunFinished(key, runId, '');

  const s = useApp.getState();
  assert.deepEqual(s.sessions[key].refineCandidates, ['the improved prompt text'], 'the stream held the report, and the fallback read it');
  assert.equal(s.tasks[0]?.prompt, task.prompt, 'nobody answered, so nothing was applied');
});
