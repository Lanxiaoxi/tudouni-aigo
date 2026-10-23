/**
 * Which machine the config panel edits.
 *
 * The reported shape: on a remote screen, opening Config showed **this**
 * machine's routes and saving wrote **this** machine's file. The two paths spell
 * the same thing — `~/.tudouni/config.json` — so nothing looked wrong; the host's
 * runtime kept reading its own file, and an edit that appeared applied did
 * nothing. Worse, "show the file in the file manager" opened this machine's
 * folder, which is a clear signal of "you are on the wrong machine" that said
 * nothing at all.
 *
 * The panel cannot resolve this itself: it needs the SSH destination, and the
 * credentials live on the saved host. So the store answers, and these assertions
 * pin that answer — including the case the panel must **not** fall back on the
 * local file for.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';

/* A plain window: nothing here dials, so no fake host is needed beyond the one
 * `attachSession` would ask for — and none of these tests start a child. */

const HOST = {
  id: 'ssh-1',
  label: 'prod',
  host: '10.2.0.4',
  port: 22,
  user: 'deploy',
  identityFiles: ['/home/me/.ssh/id_ed25519'],
  password: 'hunter2',
};
const ENTRY = {
  id: 'rw-1',
  hostId: HOST.id,
  remotePath: '/srv/app',
  remoteBinary: '/home/deploy/.tudouni/runtime/current/tudouni-aigo',
  label: 'prod:app',
};

function bucketOf(key: string, workspace: string, remoteWorkspaceId: string | null): SessionRuntime {
  const bucket = createSessionBucket(key, workspace, { ericai: false, maxSteps: null }, remoteWorkspaceId);
  bucket.ready = true;
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  return bucket;
}

function screen(remoteWorkspaceId: string | null): void {
  useApp.setState({
    sessions: {
      'k-1': bucketOf('k-1', remoteWorkspaceId === null ? '/srv/app' : ENTRY.remotePath, remoteWorkspaceId),
    },
    order: ['k-1'],
    activeKey: 'k-1',
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: null,
  });
}

test('a remote screen answers with the host and its credentials', () => {
  screen(ENTRY.id);

  const where = useApp.getState().configTarget();

  assert.ok(where !== null, 'a remote screen has a far host to edit');
  assert.equal(where.remoteWorkspaceId, ENTRY.id);
  assert.equal(where.hostId, HOST.id);
  assert.equal(where.target.host, HOST.host);
  assert.equal(where.target.port, HOST.port);
  assert.equal(where.target.user, HOST.user);
  // The credentials travel with it, and that is why the *store* builds this
  // rather than the component: `remoteConnectionOf` deliberately carries none.
  assert.deepEqual(where.target.identityFiles, HOST.identityFiles);
  assert.equal(where.target.password, 'hunter2');
});

test('a local screen answers null, which selects the ordinary local door', () => {
  screen(null);
  assert.equal(useApp.getState().configTarget(), null);
});

test('with no session open there is nothing remote to edit', () => {
  useApp.setState({ sessions: {}, order: [], activeKey: null, sshHosts: [HOST], remoteWorkspaces: [ENTRY] });
  assert.equal(useApp.getState().configTarget(), null);
});

test('a saved workspace whose host was deleted has no target to build', () => {
  // The entry outlived its host — a row that was forgotten while the workspace
  // stayed. There is no dial to give, and `null` here is the honest answer;
  // `ConfigPanel` checks `remoteWorkspaceIdOf` itself rather than treating this
  // `null` as "then it must be local", which would send it back to this
  // machine's file with the host's path on screen.
  screen(ENTRY.id);
  useApp.setState({ sshHosts: [] });
  assert.equal(useApp.getState().configTarget(), null);
});

/* ============================================================
   The baseline a save has to record
   ============================================================ */

test('a remote save moves the remote baseline and leaves the local one alone', () => {
  // §9.5 compares each side against the value it was last *seen* at. A save that
  // leaves the host's file different from the recorded baseline makes the next
  // open ask "the remote file changed — which side wins?" about an edit the
  // person just made in this panel.
  //
  // The **local** baseline must not move: this save did not touch this machine's
  // file, and claiming it did would hide a real local change from the very
  // comparison the field exists for.
  screen(ENTRY.id);
  useApp.setState({
    sshHosts: [{ ...HOST, configBaselineFingerprint: 'old-remote', configBaselineLocalFingerprint: 'old-local' }],
  });

  useApp.getState().noteRemoteConfigWritten(HOST.id, 'new-remote');

  const host = useApp.getState().sshHosts.find((h) => h.id === HOST.id);
  assert.equal(host?.configBaselineFingerprint, 'new-remote', 'the remote side is what was just written');
  assert.equal(host?.configBaselineLocalFingerprint, 'old-local', 'and this machine\'s file was not touched');
});

test('recording a baseline for a host that is gone is a no-op, not a crash', () => {
  screen(ENTRY.id);
  assert.doesNotThrow(() => useApp.getState().noteRemoteConfigWritten('ssh-missing', 'x'));
});
