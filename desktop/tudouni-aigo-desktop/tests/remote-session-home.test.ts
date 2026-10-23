/**
 * Which machine a **saved session id** belongs to.
 *
 * `openSession(id)` used to decide remote-vs-local from the *screen* and then
 * pass the id through. Two entry points click an id that belongs to a place that
 * is not on display, and both ended at the wrong machine:
 *
 *   - **a notification's reopen.** The toast carries the workspace the session
 *     was raised from, which for a remote session is the *remote* path. Clicked
 *     with a local conversation on screen, `namesTheScreen` was false, so the id
 *     went to the local spawn together with a path that does not exist here —
 *     "the workspace … is not a directory" — or, on a client where that path
 *     *does* exist, a **local child resuming a remote id**;
 *   - **a task's run history.** `TaskPanel` calls `openSession(row.link.sessionId)`
 *     with no workspace, so `namesTheScreen` was trivially true and the screen's
 *     identity was used for a run that happened elsewhere. The local child got
 *     `--session <remote id>`, and the runtime reads an id with no file as *a new
 *     session with that name*: an empty conversation, silently.
 *
 * The fix is that the saved lists — the only thing here that knows about a
 * machine the person is not looking at — answer first. These assertions pin that
 * ordering, and that the old behaviour survives when no list holds the id.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSessionBucket,
  savedSessionsKey,
  selectSessionHome,
  useApp,
  type SessionRuntime,
} from '@/state/store';

/* ============================================================
   A fake host that records which attach it was asked for
   ============================================================ */

let localCalls: Record<string, unknown>[] = [];
let remoteCalls: Record<string, unknown>[] = [];
let nextKey = 200;

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

/** A conversation in a workspace, ready — enough for `focusSession` to leave it
 *  alone and for `resolveAttachWorkspace` to answer with its path. */
function bucketOf(key: string, workspace: string, remoteWorkspaceId: string | null, id: string): SessionRuntime {
  const bucket = createSessionBucket(key, workspace, { ericai: false, maxSteps: null }, remoteWorkspaceId);
  bucket.ready = true;
  bucket.sessionId = id;
  bucket.session = { ...bucket.session!, resumed: true, id } as never;
  return bucket;
}

/** A saved list, written the way the store writes it. */
function savedList(
  workspace: string,
  remoteWorkspaceId: string | null,
  ids: string[],
): void {
  const items = ids.map((id) => ({
    id,
    messages: 1,
    steps: 1,
    todos: '',
    preview: '',
    modifiedAt: 1,
    archived: false,
  }));
  useApp.setState((s) => ({
    savedSessions: {
      ...s.savedSessions,
      [savedSessionsKey(workspace, remoteWorkspaceId)]: {
        workspace,
        remoteWorkspaceId,
        items,
        active: items,
        listed: true,
      },
    },
  }));
}

/**
 * A **local** screen, a remote workspace's list holding `20261015-190009`, and
 * the same path existing locally — the reported shape.
 */
function localScreenWithRemoteList(): void {
  useApp.setState({
    sessions: { 'k-local': bucketOf('k-local', '/srv/app', null, 's-local') },
    order: ['k-local'],
    activeKey: 'k-local',
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: '/srv/app',
    ericaiDefault: false,
    maxStepsDefault: null,
    configSyncPrompt: null,
    pendingRemoteOpen: null,
    openingRemote: null,
    savedSessions: {},
  });
  savedList('/srv/app', null, ['s-local']);
  savedList(ENTRY.remotePath, ENTRY.id, ['20261015-190009']);
  localCalls = [];
  remoteCalls = [];
}

/* ============================================================
   The id names its own place
   ============================================================ */

test('an id in a remote workspace\'s list reopens on the host, not locally', async () => {
  localScreenWithRemoteList();

  // The notification/task-history shape: the id, and nothing on screen that
  // belongs to the host it lives on.
  await useApp.getState().openSession('20261015-190009');

  assert.equal(localCalls.length, 0, 'a remote id must never be handed to the local spawn');
  assert.equal(remoteCalls.length, 1, 'the host is dialled');
  const call = remoteCalls[0];
  assert.equal(call.host, HOST.host);
  assert.equal(call.remoteWorkspace, ENTRY.remotePath);
  assert.equal(call.sessionId, '20261015-190009', 'and it is a resume, not a new conversation');

  const s = useApp.getState();
  assert.equal(s.sessions[s.activeKey ?? '']?.remoteWorkspaceId, ENTRY.id);
});

test('a local id still opens locally while a remote workspace is saved', async () => {
  // The other direction, and it is the case that must not regress: the local
  // list holds this id, so the path goes to the local spawn.
  localScreenWithRemoteList();
  useApp.setState({ activeKey: null, sessions: {} });
  localCalls = [];
  remoteCalls = [];

  await useApp.getState().openSession('s-local');

  assert.equal(remoteCalls.length, 0, 'a local id is not remote');
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].workspace, '/srv/app');
});

test('an id no list holds falls back to the screen, which is the old behaviour', async () => {
  // A notification from an earlier run, or a workspace whose list was never
  // fetched. Nothing knows the place, so the screen decides — and the screen here
  // is remote, so the host is dialled with the id.
  localScreenWithRemoteList();
  const remote = bucketOf('k-remote', ENTRY.remotePath, ENTRY.id, 's-other');
  useApp.setState((s) => ({
    sessions: { ...s.sessions, 'k-remote': remote },
    order: ['k-local', 'k-remote'],
    activeKey: 'k-remote',
  }));
  localCalls = [];
  remoteCalls = [];

  await useApp.getState().openSession('unknown-id');

  assert.equal(localCalls.length, 0);
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].sessionId, 'unknown-id');
});

/* ============================================================
   The lookup itself
   ============================================================ */

test('the same path on two machines yields two different homes', () => {
  localScreenWithRemoteList();
  const s = useApp.getState();

  assert.deepEqual(selectSessionHome(s, 's-local'), {
    workspace: '/srv/app',
    remoteWorkspaceId: null,
  });
  assert.deepEqual(selectSessionHome(s, '20261015-190009'), {
    workspace: ENTRY.remotePath,
    remoteWorkspaceId: ENTRY.id,
  });
  assert.equal(selectSessionHome(s, 'nowhere'), null, 'an id no list holds has no home');
  assert.equal(selectSessionHome(s, ''), null, 'and an empty id is not a lookup');
});

test('two hosts with the same path list their own sessions, and neither overwrites the other', () => {
  // **P2-1, as a state assertion.** Keyed by `normPath(workspace)` these two were
  // one bucket: whichever answered last won, both rails drew one list, and a row
  // clicked in it carried the other host's `sessionId`. Now the key carries the
  // entry id.
  const HOST_B = { ...HOST, id: 'ssh-2', host: '10.9.9.9', user: 'other' };
  const ENTRY_B = { ...ENTRY, id: 'rw-2', hostId: HOST_B.id, label: 'other:app' };
  localScreenWithRemoteList();
  useApp.setState((s) => ({
    sshHosts: [...s.sshHosts, HOST_B],
    remoteWorkspaces: [...s.remoteWorkspaces, ENTRY_B],
  }));
  savedList('/srv/app', 'rw-2', ['20261015-200000']);
  // Re-establish the first host's list, the way a later `session_list` answer
  // would: the point is that this write must not clobber the other one.
  savedList('/srv/app', 'rw-1', ['20261015-190009']);

  const s = useApp.getState();
  const listA = s.savedSessions[savedSessionsKey('/srv/app', 'rw-1')];
  const listB = s.savedSessions[savedSessionsKey('/srv/app', 'rw-2')];
  assert.ok(listA !== undefined && listB !== undefined, 'two buckets, not one');
  assert.deepEqual(listA.items.map((r) => r.id), ['20261015-190009']);
  assert.deepEqual(listB.items.map((r) => r.id), ['20261015-200000']);
  assert.notEqual(
    savedSessionsKey('/srv/app', null),
    savedSessionsKey('/srv/app', 'rw-1'),
    'and the local path is a third key, not one of theirs',
  );
});

test('an archived session still has a home, because a toast can outlive the archive', () => {
  // `items`, not `active`: clicking a notification about a conversation that was
  // archived in the meantime must still reach its own machine rather than being
  // answered from wherever the screen is.
  localScreenWithRemoteList();
  const items = [
    { id: '20261015-190009', messages: 1, steps: 1, todos: '', preview: '', modifiedAt: 1, archived: true },
  ];
  useApp.setState((s) => ({
    savedSessions: {
      ...s.savedSessions,
      [savedSessionsKey(ENTRY.remotePath, ENTRY.id)]: {
        workspace: ENTRY.remotePath,
        remoteWorkspaceId: ENTRY.id,
        items,
        active: [],
        listed: true,
      },
    },
  }));

  assert.deepEqual(selectSessionHome(useApp.getState(), '20261015-190009'), {
    workspace: ENTRY.remotePath,
    remoteWorkspaceId: ENTRY.id,
  });
});

test('a remote id whose saved entry was forgotten is refused, not sent to the local spawn', async () => {
  // A list can outlive its remote entry: the row was forgotten while a child was
  // still running. There is no dial to build, and falling through would send a
  // remote path to the local spawn — so the open is refused on the first screen
  // instead, the same sentence the other "nowhere to go" paths use.
  localScreenWithRemoteList();
  useApp.setState({ remoteWorkspaces: [] });
  localCalls = [];
  remoteCalls = [];

  await useApp.getState().openSession('20261015-190009');

  assert.equal(localCalls.length, 0, 'no local child');
  assert.equal(remoteCalls.length, 0, 'and no dial without an entry to build one from');
  assert.deepEqual(useApp.getState().startupNotice, { code: 'no-workspace' });
});
