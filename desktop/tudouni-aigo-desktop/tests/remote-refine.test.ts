/**
 * Refining a task on a **remote** screen.
 *
 * The reported shape: the task panel's Refine was greyed out for every remote
 * workspace, with the tooltip "This task runs on a remote workspace; its
 * sessions are not on this machine." The sentence was honest about a limitation
 * that did not have to exist: the refine prompt names each run's
 * **workspace-relative** `.tudouni/sessions/<id>.jsonl`, and the thing that
 * opens those files is the child of that workspace — which, on a remote screen,
 * runs on the host and reads its own files perfectly well.
 *
 * So the defect was in `refineTask`'s open path, not in the idea: it always
 * called `attachSession({})`, which on a remote screen hands a remote path to the
 * **local** spawn. These assertions pin the routing — the same shape
 * `remote-new-session.test.ts` pins for "New session".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';
import type { Task, TaskRunLink } from '@/task/tasks';

/* ============================================================
   A fake host that records which attach it was asked for
   ============================================================ */

let localCalls: Record<string, unknown>[] = [];
let remoteCalls: Record<string, unknown>[] = [];
let nextKey = 300;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'runtime_attach') {
        localCalls.push((args.options ?? {}) as Record<string, unknown>);
        return Promise.resolve(nextKey++);
      }
      if (cmd === 'runtime_attach_remote') {
        remoteCalls.push((args.options ?? {}) as Record<string, unknown>);
        return Promise.resolve(nextKey++);
      }
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  },
};

/* ============================================================
   The window
   ============================================================ */

const HOST = { id: 'ssh-1', label: 'prod', host: '10.2.0.4', port: 22, user: 'deploy', identityFiles: [] };
const ENTRY = {
  id: 'rw-1',
  hostId: HOST.id,
  remotePath: '/srv/app',
  remoteBinary: '/home/deploy/.tudouni/runtime/current/tudouni-aigo',
  label: 'prod:app',
};

const TASK: Task = {
  id: 'task-1',
  name: 'nightly',
  description: '',
  prompt: 'build everything',
  workspace: { kind: 'active' },
  model: '',
  enabled: true,
  autopilot: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

/** One settled run, as a finished Run would have written it. */
const RUN: TaskRunLink = {
  taskId: TASK.id,
  sessionId: '20261015-190009',
  sessionKey: 'k-old',
  startedAtMs: 1,
  taskName: 'nightly',
  model: '',
  workspaceLabel: '/srv/app',
  outcome: 'ok',
  prompt: 'build everything',
  remoteWorkspaceId: ENTRY.id,
};

/** A ready remote bucket on screen, with the task and its one settled run. */
function remoteScreen(): void {
  const bucket: SessionRuntime = createSessionBucket(
    'k-remote',
    ENTRY.remotePath,
    { ericai: false, maxSteps: null },
    ENTRY.id,
  );
  bucket.ready = true;
  bucket.session = { ...bucket.session!, resumed: true, id: 's-current' } as never;
  useApp.setState({
    sessions: { 'k-remote': bucket },
    order: ['k-remote'],
    activeKey: 'k-remote',
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: null,
    ericaiDefault: false,
    maxStepsDefault: null,
    configSyncPrompt: null,
    pendingRemoteOpen: null,
    openingRemote: null,
    tasks: [TASK],
    taskRuns: [RUN],
    savedSessions: {},
  });
  localCalls = [];
  remoteCalls = [];
}

/**
 * Run `refineTask` far enough to observe **which child it asked for**.
 *
 * The real call waits for the new child's handshake before it sends the prompt
 * (`waitForReady`, bounded at 30s). A fake host has no runtime behind it, so
 * awaiting the whole promise would sit out that deadline once per test — and the
 * deadline is not what is being asserted. The dial and the bucket mark both
 * happen before the wait, so a short settle is enough to see them.
 */
async function startRefine(taskId = TASK.id): Promise<void> {
  const done = useApp.getState().refineTask(taskId, { kind: 'all' }, false, '');
  // Let the open chain run: `connectRemoteWorkspace` awaits the bridge, then
  // installs the bucket, then `refineTask` marks it. A few macrotasks is well
  // past that and nowhere near the handshake deadline.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  void done;
}

/* ============================================================
   The open
   ============================================================ */

test('refining a task on a remote screen dials the host, not this machine', async () => {
  remoteScreen();

  await startRefine();

  // The regression, verbatim: before the fix this was one `runtime_attach` with
  // `/srv/app` as the workspace — refused here as "not a directory", or a local
  // session where that path exists.
  assert.equal(localCalls.length, 0, 'the remote path must never reach the local spawn');
  assert.equal(remoteCalls.length, 1, 'one child on the host');
  assert.equal(remoteCalls[0].remoteWorkspace, ENTRY.remotePath);
  assert.equal(remoteCalls[0].remoteBinary, ENTRY.remoteBinary);
  // A refine run is a **new** conversation, never "focus the one already open".
  assert.equal(remoteCalls[0].sessionId, null);
});

test('the refine child is marked as the task\'s refine session', async () => {
  remoteScreen();

  await startRefine();

  const s = useApp.getState();
  const bucket = s.sessions[s.activeKey ?? ''];
  assert.ok(bucket !== undefined, 'a session landed on screen');
  assert.equal(bucket.refineTaskId, TASK.id, 'the candidate is applied against this task');
  assert.equal(bucket.remoteWorkspaceId, ENTRY.id);
});

test('refining a task bound to another host is refused without opening anything', async () => {
  // The gate is about *which place*, not about remote-ness: an `active` task
  // refines wherever the screen is (asserted above), but a task pinned to a
  // different saved remote workspace must not silently study this host's files.
  remoteScreen();
  useApp.setState({ tasks: [{ ...TASK, workspace: { kind: 'remote', id: 'rw-other' } }] });
  localCalls = [];
  remoteCalls = [];

  await startRefine();

  assert.equal(localCalls.length, 0, 'nothing was started');
  assert.equal(remoteCalls.length, 0, 'and nothing was dialled');
  assert.equal(useApp.getState().sessions['k-remote']?.refineTaskId ?? null, null,
    'the session already on screen was not repurposed');
});

/* ============================================================
   The recorded home of a run
   ============================================================ */

test('a run remembers which machine its evidence is on', () => {
  // The label alone cannot answer this — a local `/srv/app` and the host's are
  // one string. Refine reads `.tudouni/sessions/<id>.jsonl`, so the machine is a
  // recorded fact on the link rather than something inferred from a path.
  assert.equal(RUN.remoteWorkspaceId, ENTRY.id);
  // And a link saved before the field existed reads as local, which is what
  // every such link was.
  const legacy: TaskRunLink = { ...RUN };
  delete legacy.remoteWorkspaceId;
  assert.equal(legacy.remoteWorkspaceId ?? null, null);
});
