/**
 * Applying the start-up arguments while a **remote** session is on screen.
 *
 * The reported bug: the settings panel's "Apply" called `attachSession` with the
 * active session's `workspace`, which on a remote screen is a directory on the
 * other host. Two very different things then happened, and neither is what the
 * button meant:
 *
 *   - on Windows the local spawn checked that path against this machine's
 *     filesystem, refused it ("the workspace /home/me/proj is not a directory"),
 *     and dropped a failure row over a perfectly healthy remote conversation;
 *   - on a Linux or macOS client whose own `/srv/app` exists, the spawn
 *     **succeeded**, so the screen showed a *local* child while the rail, the
 *     top bar and the conversation still read as the remote workspace. Every
 *     file tool, terminal and deliverable then landed on this machine while the
 *     person believed they were editing the server.
 *
 * And the failure was not recoverable by its own button: the row it left behind
 * has no `remoteWorkspaceId`, so "Try again" took the local path again.
 *
 * So the assertions are about routing — the same shape
 * `remote-new-session.test.ts` pins for "New session": over a remote screen,
 * applying means `runtime_attach_remote` with `forceNew` and **no** local child.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';

/* ============================================================
   A fake Tauri host that records which attach it was asked for
   ============================================================ */

let localCalls: Record<string, unknown>[] = [];
let remoteCalls: Record<string, unknown>[] = [];
/** Monotonic, and **not** derived from `remoteCalls.length` — that array is
 *  cleared between assertions, and a key minted from it would be handed out
 *  twice. The bridge's own keys are never reused, and the fold in
 *  `connectRemoteWorkspace` re-keys the bucket by them, so a repeated key would
 *  hide exactly the thing this file is testing. */
let nextKey = 100;

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

/** A live local session, ready and resumed — nothing here may abandon it. */
function localBucket(key: string, workspace = 'C:/work'): SessionRuntime {
  const bucket = createSessionBucket(key, workspace, { ericai: false, maxSteps: null });
  bucket.ready = true;
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  return bucket;
}

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
    // The remote path is deliberately **also** a path that exists on this
    // machine in the reported bug's third case. `attachSession` never gets to
    // look at a filesystem here (the fake host answers for both doors), so the
    // assertion is about routing rather than about the spawn's refusal.
    lastWorkspace: ENTRY.remotePath,
    ericaiDefault: false,
    maxStepsDefault: null,
    configSyncPrompt: null,
    pendingRemoteOpen: null,
    openingRemote: null,
  }));
  localCalls = [];
  remoteCalls = [];
}

/* ============================================================
   Applying the settings over a remote screen
   ============================================================ */

test('applying the start-up arguments over a remote screen dials remote, never local', async () => {
  remoteScreen();

  await useApp.getState().applyLaunch({ ericai: true, maxSteps: 40 });

  // The regression, verbatim: before the fix this was one `runtime_attach` with
  // `/repo/echuzhi/rvv-project` as the workspace — either refused ("is not a
  // directory") or, where that path exists locally, silently a local session.
  assert.equal(localCalls.length, 0, 'the remote path must never be handed to the local spawn');
  assert.equal(remoteCalls.length, 1, 'one remote child, on the same row');

  const call = remoteCalls[0];
  assert.equal(call.host, HOST.host);
  assert.equal(call.port, HOST.port);
  assert.equal(call.user, HOST.user);
  assert.equal(call.remoteWorkspace, ENTRY.remotePath, 'the workspace is the one on the host');
  assert.equal(call.remoteBinary, ENTRY.remoteBinary);
  // A **new** child, not a resume: applying is "another conversation with these
  // arguments", so no session id rides along. (`forceNew` itself is a
  // store-level flag `connectRemoteWorkspace` consumes before dialling; what it
  // buys is the assertion two tests below, and a wire field for it would be a
  // fact the Rust side has no use for.)
  assert.equal(call.sessionId, null, 'applying opens a new conversation, not a resume');
  // The arguments just applied are the ones the new child gets — they are read
  // off the defaults, which `applyLaunch` persists before it opens anything.
  assert.equal(call.ericai, true);
  assert.equal(call.maxSteps, 40);
});

test('applying twice spawns two children rather than focusing the first', async () => {
  // This is the `forceNew` half, asserted the way a person would notice it: the
  // guard inside `connectRemoteWorkspace` focuses a session that already exists
  // for this remote row, so without `forceNew` the second "Apply" would come
  // back to the conversation the first one opened — a dead button, exactly like
  // the "New session" case that flag was introduced for.
  remoteScreen();

  await useApp.getState().applyLaunch({ ericai: false, maxSteps: null });
  const firstKey = useApp.getState().activeKey;
  remoteCalls = [];

  await useApp.getState().applyLaunch({ ericai: true, maxSteps: 40 });

  assert.equal(remoteCalls.length, 1, 'another dial, not a focus');
  const s = useApp.getState();
  assert.notEqual(s.activeKey, firstKey, 'the second child is a different session');
  assert.equal(s.sessions[s.activeKey ?? '']?.remoteWorkspaceId, ENTRY.id);
  assert.ok(firstKey !== null && firstKey in s.sessions, 'and the first one is still open');
});

test('applying over a remote screen leaves the old conversation open', async () => {
  remoteScreen();

  await useApp.getState().applyLaunch({ ericai: true, maxSteps: 40 });

  const s = useApp.getState();
  assert.ok('k-remote' in s.sessions, 'the conversation that was on screen is not closed');
  assert.ok('k-local' in s.sessions, 'nor the local one behind it');
  const active = s.sessions[s.activeKey ?? ''];
  assert.ok(active !== undefined, 'a session landed on screen');
  assert.equal(active.remoteWorkspaceId, ENTRY.id, 'the new session is remote, like the one it came from');
  assert.equal(active.workspace, ENTRY.remotePath);
});

test('applying over a remote screen records the arguments as the remembered defaults', async () => {
  remoteScreen();

  await useApp.getState().applyLaunch({ ericai: true, maxSteps: 40 });

  // A launch that fails must not silently drop the choice — the local path
  // writes these before it opens anything, and the remote path must not lose
  // that property by returning early on some other branch.
  assert.equal(useApp.getState().ericaiDefault, true);
  assert.equal(useApp.getState().maxStepsDefault, 40);
});

test('applying with no remote entry still goes through the local path', async () => {
  // The other direction, and it is not a formality: a window opened on a local
  // workspace must keep starting a local child, with the arguments applied.
  remoteScreen();
  useApp.setState({ activeKey: 'k-local' });
  localCalls = [];
  remoteCalls = [];

  await useApp.getState().applyLaunch({ ericai: true, maxSteps: 12 });

  assert.equal(remoteCalls.length, 0, 'a local screen must not dial SSH');
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].workspace, 'C:/work');
  assert.equal(localCalls[0].ericai, true);
  assert.equal(localCalls[0].maxSteps, 12);
});

/* ============================================================
   The row "Try again" leaves behind
   ============================================================ */

test('a failed apply leaves a row that retries the remote way', async () => {
  // A retry reads `remoteWorkspaceId` off the failed row; a row built with
  // `null` — which is what the old `attachSession` placeholder produced — sends
  // the retry straight back to the local spawn, which is the same refusal a
  // second time. This pins the property the P0 fix rests on.
  remoteScreen();
  const window = globalThis as { window: { __TAURI_INTERNALS__: { invoke: unknown } } };
  const host = window.window.__TAURI_INTERNALS__;
  const original = host.invoke;
  host.invoke = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'runtime_attach_remote') {
      return Promise.reject(new Error('could not start the remote runtime: connection refused'));
    }
    return (original as (c: string, a: Record<string, unknown>) => unknown)(cmd, args);
  };
  try {
    await useApp.getState().applyLaunch({ ericai: false, maxSteps: null });
  } finally {
    host.invoke = original;
  }

  const s = useApp.getState();
  const failedKey = s.activeKey ?? '';
  const row = s.sessions[failedKey];
  assert.ok(row, 'the failure has a row of its own on screen');
  assert.ok(row.problem !== null, 'and it says why');
  assert.equal(row.remoteWorkspaceId, ENTRY.id, 'the row knows which host it belongs to');

  remoteCalls = [];
  localCalls = [];
  await useApp.getState().retrySession(failedKey);
  assert.equal(localCalls.length, 0, 'the retry must dial the host again, not this machine');
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].remoteWorkspace, ENTRY.remotePath);
});
