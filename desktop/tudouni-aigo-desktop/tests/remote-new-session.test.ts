/**
 * "New session" while the conversation on screen is a remote one.
 *
 * The reported bug: the remote workspace's directory (`/repo/echuzhi/rvv-project`)
 * was handed to the **local** spawn, which checked it against this machine's
 * filesystem and refused it — "the workspace … is not a directory" — while the
 * person who pressed the button had been working in that directory just fine,
 * over SSH. The remote path is not a local directory, and no amount of pressing
 * the button again will make it one; the button's job on a remote screen is to
 * open **another conversation in that remote workspace**, which is a second
 * child over the same SSH row.
 *
 * So the assertions are about routing: with the active session remote,
 * `openSession(null)` must dial `runtime_attach_remote` with the row's
 * arguments and must not ask for a local child at all; and it must not focus
 * the session it already has open (the `forceNew` half), because a "New
 * session" that comes back to the old conversation reads as a dead button.
 *
 * Driven against a fake Tauri host that records which attach commands it was
 * asked for — the same harness `ericai-launch.test.ts` uses for the local
 * half.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';

/* ============================================================
   A fake Tauri host that records which attach it was asked for
   ============================================================ */

let localCalls: Record<string, unknown>[] = [];
let remoteCalls: Record<string, unknown>[] = [];
let nextKey = 10;

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

const HOST = { id: 'ssh-1', label: 'rvv', host: '10.2.0.4', port: 22, user: 'tudouni', identityFiles: [] };
const ENTRY = {
  id: 'rw-1',
  hostId: HOST.id,
  remotePath: '/repo/echuzhi/rvv-project',
  remoteBinary: '/home/tudouni/.tudouni/runtime/current/tudouni-aigo',
  label: 'rvv:rvv-project',
};

/** A live local session: ready, and a resumed one — so nothing here ever
 *  qualifies it as an untouched session that a switch may abandon. */
function localBucket(key: string): SessionRuntime {
  const bucket = createSessionBucket(key, 'C:/work', { ericai: false, maxSteps: null });
  bucket.ready = true;
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  return bucket;
}

/** The reported state: a remote session, ready, on screen, with a local
 *  conversation open behind it. */
function remoteScreen(): void {
  useApp.setState((s) => ({
    sessions: {
      'k-local': localBucket('k-local'),
      'k-remote': {
        ...createSessionBucket('k-remote', ENTRY.remotePath, { ericai: false, maxSteps: null }, ENTRY.id),
        ready: true,
        connection: { phase: 'ready', problem: null },
      },
    },
    order: ['k-local', 'k-remote'],
    activeKey: 'k-remote',
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    openingRemote: null,
    lastWorkspace: 'C:/work',
  }));
  localCalls = [];
  remoteCalls = [];
}

/* ============================================================
   New session over a remote screen
   ============================================================ */

test('a new session over a remote screen opens another remote child, not a local one', async () => {
  remoteScreen();

  await useApp.getState().openSession(null);

  // The regression, verbatim: before the fix this call dialed `runtime_attach`
  // with the remote path as the workspace, and the Rust side answered "the
  // workspace /repo/echuzhi/rvv-project is not a directory" — a sentence about
  // this machine's filesystem, for a directory that was never on this machine.
  assert.equal(localCalls.length, 0, 'no local child may be asked for');
  assert.equal(remoteCalls.length, 1, 'the same SSH row was dialed again');
  const call = remoteCalls[0];
  assert.equal(call.host, HOST.host);
  assert.equal(call.port, HOST.port);
  assert.equal(call.user, HOST.user);
  assert.equal(call.remoteWorkspace, ENTRY.remotePath);
  assert.equal(call.remoteBinary, ENTRY.remoteBinary);

  const s = useApp.getState();
  assert.equal(s.order.length, 3, 'a third session now exists');
  const bucket = s.sessions[s.activeKey ?? ''];
  assert.ok(bucket, 'the new session is the one on screen');
  assert.equal(bucket.remoteWorkspaceId, ENTRY.id, 'it is a remote session, like the one it came from');
  assert.equal(bucket.workspace, ENTRY.remotePath);
  assert.equal(bucket.key, s.activeKey, 'the bucket carries the key the bridge minted');
});

test('an explicit local workspace still wins over a remote screen', async () => {
  remoteScreen();

  // `/resume` on a saved session in another directory names its workspace
  // explicitly; that is a statement about **this machine**, so the local path
  // is what was asked for.
  await useApp.getState().openSession(null, 'C:/other');

  assert.equal(remoteCalls.length, 0);
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].workspace, 'C:/other');
  const s = useApp.getState();
  const bucket = s.sessions[s.activeKey ?? ''];
  assert.equal(bucket?.remoteWorkspaceId, null, 'a named local workspace is a local session');
  assert.equal(bucket?.workspace, 'C:/other');
});

/* ============================================================
   The same row, pressed twice, means two children
   ============================================================ */

test('a second new session in the same remote workspace is a second child, not a focus', async () => {
  remoteScreen();
  await useApp.getState().openSession(null);
  remoteCalls = [];
  const firstKey = useApp.getState().activeKey;

  // The ordinary open of a row that already has a live session is a no-op — it
  // focuses. The button must not be that no-op: the person asked for another
  // conversation, and the `forceNew` flag is what keeps it so.
  await useApp.getState().openSession(null);

  assert.equal(remoteCalls.length, 1, 'another dial, not a focus');
  const s = useApp.getState();
  assert.equal(s.order.length, 4);
  assert.notEqual(s.activeKey, firstKey, 'the second child is a different session');
  assert.equal(s.sessions[s.activeKey ?? '']?.remoteWorkspaceId, ENTRY.id);
});

/* ============================================================
   Retrying a failed remote session dials remote, not local
   ============================================================ */

test('retrying a failed remote session dials the remote row again, not a local child', async () => {
  remoteScreen();
  useApp.setState((s) => ({
    sessions: {
      ...s.sessions,
      'k-failed': {
        ...createSessionBucket('k-failed', ENTRY.remotePath, { ericai: false, maxSteps: null }, ENTRY.id),
        problem: 'could not start the remote runtime: connection refused',
        connection: { phase: 'failed', problem: 'could not start the remote runtime: connection refused' },
      },
    },
    order: [...s.order, 'k-failed'],
    activeKey: 'k-failed',
  }));
  localCalls = [];
  remoteCalls = [];

  await useApp.getState().retrySession('k-failed');

  assert.equal(localCalls.length, 0, 'the remote path is not a directory here, and retrying must not try it');
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].remoteWorkspace, ENTRY.remotePath);

  const s = useApp.getState();
  assert.ok(!('k-failed' in s.sessions), 'the failed row was retired');
  assert.equal(s.activeKey, remoteCalls.length === 1 ? s.sessions[s.activeKey ?? ''].key : null);
  assert.equal(s.sessions[s.activeKey ?? '']?.remoteWorkspaceId, ENTRY.id);
});

/* ============================================================
   Reopening a *saved* session over a remote screen
   ============================================================ */

test('opening a saved session over a remote screen dials remote with the session id', async () => {
  remoteScreen();

  // The reported bug: clicking a saved-session row in the rail called
  // `openSession(id)` while the screen was a remote one. The id was passed on,
  // but the *workspace* came from `resolveAttachWorkspace` — the active
  // session's own `init.workspace`, a directory on the **remote** host — and
  // the local spawn checked it against this machine's filesystem, refusing
  // with "the workspace … is not a directory". The same routing rule that
  // "new session" over a remote screen needs applies here: the row was
  // clicked on a remote screen, so the conversation it names lives there.
  await useApp.getState().openSession('20261015-082946');

  // The regression, verbatim: before the fix this call dialed `runtime_attach`
  // with the remote path as the workspace. The remote path is never a directory
  // here, and no amount of pressing the row again will make it one.
  assert.equal(localCalls.length, 0, 'no local child may be asked for');
  assert.equal(remoteCalls.length, 1, 'the same SSH row was dialed');
  const call = remoteCalls[0];
  assert.equal(call.host, HOST.host);
  assert.equal(call.remoteWorkspace, ENTRY.remotePath);
  // And it is a **resume**, not a new conversation: the clicked row's id rides
  // along as `--session <id>`, the same id the local path passes on.
  assert.equal(call.sessionId, '20261015-082946', 'the saved session is resumed on the remote host');

  const s = useApp.getState();
  assert.ok(s.sessions[s.activeKey ?? ''], 'a session landed on screen');
  assert.equal(s.sessions[s.activeKey ?? '']?.remoteWorkspaceId, ENTRY.id, 'it is a remote session, like the one it came from');
});

test('a saved session with an explicit local workspace still goes local over a remote screen', async () => {
  remoteScreen();

  // `/resume` on a saved session in a *named* local directory is a statement
  // about this machine, even with a remote screen on display: the explicit
  // workspace outranks the screen, so the local path is what was asked for.
  await useApp.getState().openSession('20261015-082946', 'C:/other');

  assert.equal(remoteCalls.length, 0, 'a named local workspace is not remote');
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].workspace, 'C:/other');
  assert.equal(localCalls[0].sessionId, '20261015-082946');
});
