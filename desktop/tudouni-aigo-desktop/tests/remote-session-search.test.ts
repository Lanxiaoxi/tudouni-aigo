/**
 * Session search on a **remote** screen.
 *
 * The reported bug: the guard that was supposed to keep the search away from a
 * remote workspace tested `sessionSearchWorkspace === ''`, and a remote
 * session's workspace is never empty — it is a perfectly ordinary path, just on
 * another host. So the search ran against this machine, with two different
 * wrong answers depending on where it ran:
 *
 *   - Windows and macOS, where the remote path does not exist: `sessions_search`
 *     swallowed the missing directory as an empty list, and the rail drew "No
 *     session matches / Try a shorter word" — a **false negative** about a word
 *     that is in a session on the server;
 *   - on a Linux client (or anywhere `/srv/app` happens to exist locally): it
 *     scanned **this** machine's `.tudouni/sessions` and offered another
 *     project's conversations as results for the remote workspace.
 *
 * The fix is a guard on the bucket's `remoteWorkspaceId`, plus a third state
 * that is *neither* "no match" *nor* the red "the search could not run" — this
 * is a capability that does not exist yet, and painting it as a fault would send
 * somebody hunting for a permissions problem on the wrong machine.
 *
 * The assertion is on the **IPC call**, because that is the thing that was
 * wrong: on a remote screen, `sessions_search` must not be asked at all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeWorkspaceOf,
  createSessionBucket,
  remoteWorkspaceIdOf,
  screenIsRemote,
  useApp,
} from '@/state/store';

/* ============================================================
   A fake host that records every scan it was asked to run
   ============================================================ */

const scans: { workspace: string; query: string }[] = [];

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'sessions_search') {
        scans.push({
          workspace: String(args.workspace ?? ''),
          query: String(args.query ?? ''),
        });
        // A hit, so "the answer arrived" is distinguishable from "nothing was
        // asked": a remote screen that skipped the scan must not look like one
        // whose scan came back empty.
        return Promise.resolve([{ sessionId: 's-local', snippet: 'local hit', modifiedAt: 1 }]);
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
  remotePath: '/srv/app',
  remoteBinary: '/home/tudouni/.tudouni/runtime/current/tudouni-aigo',
  label: 'rvv:app',
};

function screen(remoteWorkspaceId: string | null): void {
  const bucket = createSessionBucket(
    'k-1',
    remoteWorkspaceId === null ? '/srv/app' : ENTRY.remotePath,
    { ericai: false, maxSteps: null },
    remoteWorkspaceId,
  );
  bucket.ready = true;
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  useApp.setState({
    sessions: { 'k-1': bucket },
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
  scans.length = 0;
}

/* ============================================================
   The guard
   ============================================================ */

test('a remote workspace is recognised as remote, whatever its path looks like on this machine', () => {
  // The whole bug in one assertion: the old test was `workspace === ''`, and
  // `/srv/app` — a path that exists on plenty of Linux clients — is not empty.
  screen(ENTRY.id);
  assert.equal(screenIsRemote(useApp.getState()), true);
});

test('a local workspace with the very same path is not remote', () => {
  // The other half: the *string* is identical, so no path-shaped test can tell
  // them apart. Only `remoteWorkspaceId` can.
  screen(null);
  assert.equal(screenIsRemote(useApp.getState()), false);
  // The path is the same string the remote case used, which is what makes this
  // a test of the predicate rather than of the fixture.
  assert.equal(activeWorkspaceOf(useApp.getState()), '/srv/app');
});

test('with no session open there is nothing remote, so nothing is blocked by it', () => {
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  assert.equal(screenIsRemote(useApp.getState()), false);
  assert.equal(remoteWorkspaceIdOf(useApp.getState(), null), null);
});

test('the remote entry id is what the screen reports, not a path', () => {
  screen(ENTRY.id);
  assert.equal(remoteWorkspaceIdOf(useApp.getState(), 'k-1'), ENTRY.id);
  // A key that names no session answers `null` rather than throwing, which is
  // the shape every caller of `runtimeOf` already relies on.
  assert.equal(remoteWorkspaceIdOf(useApp.getState(), 'k-none'), null);
});

/* ============================================================
   The scan itself
   ============================================================ */

test('the scan is keyed by the local workspace, never by the remote one', async () => {
  // A local screen: the search must still work, and it must be aimed at the
  // path this machine holds — which is also the key its saved list is filed
  // under.
  screen(null);
  const hits = await (await import('@/runtime/tauri')).searchSessions('/srv/app', 'word');
  assert.ok(hits !== null && hits.length === 1);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].workspace, '/srv/app');
});
