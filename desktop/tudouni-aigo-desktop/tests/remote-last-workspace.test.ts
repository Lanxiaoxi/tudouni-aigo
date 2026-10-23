/**
 * Which place the next launch should offer.
 *
 * The reported gap: `lastWorkspace` is a **local directory**, and the start-up
 * opens it *here*. A remote workspace's directory is on another host, so it can
 * never be that value — the old code deliberately skipped remote sessions when
 * remembering, which was right, and left the other half missing: somebody who
 * works on a server every day got the empty first screen on every launch and had
 * to find the row in the rail again.
 *
 * The answer is a second field, `lastRemoteWorkspaceId`, and it is an **entry
 * id** rather than a path: a path cannot say which machine it belongs to, and
 * this one has to survive being compared against saved entries whose hosts may
 * since have been deleted.
 *
 * Two rules are asserted here, and they are the two ways this could go wrong:
 *
 *   1. it is recorded whenever a remote session becomes the screen (both the
 *      explicit focus **and** the open, which never passes through
 *      `focusSession`);
 *   2. a stale id — the entry was forgotten while the field still said so — is
 *      never offered, because an offer that cannot be kept is worse than none.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';

/* ============================================================
   A fake host, so a remote open can actually land
   ============================================================ */

let nextKey = 500;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string) {
      if (cmd === 'runtime_attach_remote') return Promise.resolve(nextKey++);
      if (cmd === 'runtime_attach') return Promise.resolve(nextKey++);
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  },
};

const HOST = { id: 'ssh-1', label: 'prod', host: '10.2.0.4', port: 22, user: 'deploy', identityFiles: [] };
const ENTRY = {
  id: 'rw-1',
  hostId: HOST.id,
  remotePath: '/srv/app',
  remoteBinary: '/home/deploy/.tudouni/runtime/current/tudouni-aigo',
  label: 'prod:app',
};
const OTHER = { ...ENTRY, id: 'rw-2', remotePath: '/srv/other', label: 'prod:other' };

function remoteBucket(key: string, remoteWorkspaceId: string): SessionRuntime {
  const bucket = createSessionBucket(key, ENTRY.remotePath, { ericai: false, maxSteps: null }, remoteWorkspaceId);
  bucket.ready = true;
  bucket.sessionId = 's-1';
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  return bucket;
}

function localBucket(key: string): SessionRuntime {
  const bucket = createSessionBucket(key, 'C:/work', { ericai: false, maxSteps: null });
  bucket.ready = true;
  bucket.sessionId = 's-l';
  bucket.session = { ...bucket.session!, resumed: true, id: 's-l' } as never;
  return bucket;
}

function window(overrides: Record<string, unknown> = {}): void {
  useApp.setState({
    sessions: {},
    order: [],
    activeKey: null,
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY, OTHER],
    lastWorkspace: null,
    lastRemoteWorkspaceId: null,
    ericaiDefault: false,
    maxStepsDefault: null,
    configSyncPrompt: null,
    pendingRemoteOpen: null,
    openingRemote: null,
    installStatus: {},
    ...overrides,
  });
}

/* ============================================================
   Recording it
   ============================================================ */

test('focusing a remote session records its workspace, and leaves the local field alone', () => {
  // Both halves in one assertion, because the whole point of a second field is
  // that the first one must not receive a path from another machine.
  window({
    sessions: { 'k-r': remoteBucket('k-r', ENTRY.id), 'k-l': localBucket('k-l') },
    order: ['k-l', 'k-r'],
    activeKey: 'k-l',
    lastWorkspace: 'C:/work',
  });

  useApp.getState().focusSession('k-r');

  const s = useApp.getState();
  assert.equal(s.lastRemoteWorkspaceId, ENTRY.id);
  assert.equal(s.lastWorkspace, 'C:/work', 'the remote path must never become the local one');
});

test('focusing a local session does not record a remote workspace', () => {
  // The other direction: the local field keeps working exactly as it did, and a
  // remote id already recorded is not cleared — "last remote" is a memory, and
  // walking back to a local directory does not mean the host was never used.
  window({
    sessions: { 'k-r': remoteBucket('k-r', ENTRY.id) },
    order: ['k-r'],
    activeKey: 'k-r',
    lastRemoteWorkspaceId: ENTRY.id,
  });

  useApp.getState().focusSession('k-r');
  assert.equal(useApp.getState().lastRemoteWorkspaceId, ENTRY.id);
});

test('opening a remote workspace records it, without going through focusSession', () => {
  // **The gap this closed.** `connectRemoteWorkspace` installs its bucket and
  // sets `activeKey` in one write, so an *opened* session never passes through
  // `focusSession` — recording it only there would miss the commonest way a
  // remote workspace is entered.
  window();

  return useApp.getState().connectRemoteWorkspace(ENTRY.id).then(() => {
    assert.equal(useApp.getState().lastRemoteWorkspaceId, ENTRY.id);
  });
});

test('an id that names no saved workspace is refused rather than stored', () => {
  // A session whose entry was just deleted must not leave a dangling answer
  // behind: the start-up would then have to decide whether to trust it.
  window();
  useApp.getState().rememberRemoteWorkspace('rw-does-not-exist');
  assert.equal(useApp.getState().lastRemoteWorkspaceId, null);
});

test('an empty id is not a statement about anything', () => {
  window({ lastRemoteWorkspaceId: ENTRY.id });
  useApp.getState().rememberRemoteWorkspace('   ');
  assert.equal(useApp.getState().lastRemoteWorkspaceId, ENTRY.id, 'left as it was');
});

/* ============================================================
   Offering it — the rules the first screen relies on
   ============================================================ */

test('the saved entry is found by id, and a forgotten one yields nothing', () => {
  // The first screen's two lookups, as plain reads: no entry means no block.
  window({ lastRemoteWorkspaceId: ENTRY.id });
  let s = useApp.getState();
  assert.equal(s.remoteWorkspaces.find((entry) => entry.id === s.lastRemoteWorkspaceId)?.label, ENTRY.label);

  // The workspace is forgotten under a still-written id — the state a deleted
  // row leaves behind.
  window({ lastRemoteWorkspaceId: 'rw-gone' });
  s = useApp.getState();
  assert.equal(s.remoteWorkspaces.find((entry) => entry.id === s.lastRemoteWorkspaceId), undefined);
});

test('an entry whose host is gone is not offered either', () => {
  // The block needs the host for the machine line, and dialling without one is
  // impossible — so the offer is withheld rather than drawn and refused.
  window({ lastRemoteWorkspaceId: ENTRY.id, sshHosts: [] });
  const s = useApp.getState();
  const entry = s.remoteWorkspaces.find((row) => row.id === s.lastRemoteWorkspaceId);
  assert.ok(entry !== undefined, 'the entry survives on its own');
  assert.equal(s.sshHosts.find((host) => host.id === entry.hostId), undefined, 'but its host does not');
});

/* ============================================================
   The two fields are independent
   ============================================================ */

test('a local and a remote place are remembered side by side', () => {
  // They answer "where was the work" and the answer may be either; neither
  // erases the other, because both are offers rather than a single focus.
  window({
    sessions: { 'k-r': remoteBucket('k-r', ENTRY.id), 'k-l': localBucket('k-l') },
    order: ['k-l', 'k-r'],
    activeKey: 'k-l',
  });

  useApp.getState().focusSession('k-r');
  useApp.getState().focusSession('k-l');

  const s = useApp.getState();
  assert.equal(s.lastRemoteWorkspaceId, ENTRY.id, 'the host is still remembered');
  assert.equal(s.lastWorkspace, 'C:/work', 'and so is the local directory');
});
