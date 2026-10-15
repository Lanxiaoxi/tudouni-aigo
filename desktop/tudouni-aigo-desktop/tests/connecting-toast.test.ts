/**
 * What the connecting toast shows, and when it is gone.
 *
 * The selector is pure, so it is asserted directly against store states
 * rather than by looking at a window: the rules it encodes — "the toast is
 * about the in-flight *open*, it names the workspace, and it is gone the
 * moment the handshake lands" — are exactly the kind of invisible behaviour
 * that reads as ordinary code when wrong (a toast that lingers over a failed
 * dial, or one that never appears during the install stretch, would both pass
 * a glance at the window).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectConnectingToast } from '@/connectingToast';
import { createSessionBucket, useApp, type AppStore } from '@/state/store';

/** A store state with only the fields the selector reads, so a test cannot
 *  accidentally lean on a field the selector does not own. */
function state(partial: {
  activeKey?: string | null;
  sessions?: AppStore['sessions'];
  openingRemote?: string | null;
  remoteWorkspaces?: AppStore['remoteWorkspaces'];
}): AppStore {
  return {
    activeKey: partial.activeKey ?? null,
    sessions: partial.sessions ?? {},
    openingRemote: partial.openingRemote ?? null,
    remoteWorkspaces: partial.remoteWorkspaces ?? [],
  } as unknown as AppStore;
}

const ROW = {
  id: 'rw-1',
  hostId: 'ssh-1',
  remotePath: '/home/me/srv',
  remoteBinary: '/opt/tudouni/tudouni-aigo',
  label: 'prod:/home/me/srv',
};

/* ============================================================
   The pre-bucket half: openingRemote, no session yet
   ============================================================ */

test('an open in flight before the bucket exists shows the toast', () => {
  // The config check and the install run before any session bucket exists, so
  // this is the stretch the phase-based half of the selector cannot see.
  const toast = selectConnectingToast(state({ openingRemote: 'rw-1', remoteWorkspaces: [ROW] }));
  assert.deepEqual(toast, { name: 'prod:/home/me/srv' });
});

test('the toast keeps the row label even when the focus is elsewhere', () => {
  // The pre-bucket mark outranks the focus: the person may have moved the
  // screen while the install runs, and the toast is about the open, not the
  // focus. A focus that is a *different*, ready local session.
  const local = createSessionBucket('k-local', 'C:/work', { ericai: false, maxSteps: null });
  local.ready = true;
  const toast = selectConnectingToast(
    state({
      openingRemote: 'rw-1',
      remoteWorkspaces: [ROW],
      activeKey: 'k-local',
      sessions: { 'k-local': local },
    }),
  );
  assert.deepEqual(toast, { name: 'prod:/home/me/srv' });
});

test('a blank label falls back to the remote path', () => {
  const blank = { ...ROW, label: '' };
  const toast = selectConnectingToast(state({ openingRemote: 'rw-1', remoteWorkspaces: [blank] }));
  assert.deepEqual(toast, { name: '/home/me/srv' });
});

test('a row that was deleted mid-open shows nothing rather than a null name', () => {
  const toast = selectConnectingToast(state({ openingRemote: 'rw-gone' }));
  assert.equal(toast, null);
});

/* ============================================================
   The post-bucket half: the session's own connection phase
   ============================================================ */

test('a remote bucket in the connecting phase shows the toast', () => {
  const bucket = createSessionBucket('k-r', '/home/me/srv', { ericai: false, maxSteps: null }, 'rw-1');
  // `createSessionBucket` starts a remote bucket at `connecting`.
  const toast = selectConnectingToast(
    state({
      activeKey: 'k-r',
      sessions: { 'k-r': bucket },
      remoteWorkspaces: [ROW],
    }),
  );
  assert.deepEqual(toast, { name: 'prod:/home/me/srv' });
});

test('handshaking still shows the toast — the dial is not done', () => {
  const bucket = createSessionBucket('k-r', '/home/me/srv', { ericai: false, maxSteps: null }, 'rw-1');
  bucket.connection = { phase: 'handshaking', problem: null };
  const toast = selectConnectingToast(
    state({ activeKey: 'k-r', sessions: { 'k-r': bucket }, remoteWorkspaces: [ROW] }),
  );
  assert.deepEqual(toast, { name: 'prod:/home/me/srv' });
});

test('the handshake landing (ready) takes the toast away', () => {
  const bucket = createSessionBucket('k-r', '/home/me/srv', { ericai: false, maxSteps: null }, 'rw-1');
  bucket.ready = true;
  bucket.connection = { phase: 'ready', problem: null };
  const toast = selectConnectingToast(
    state({ activeKey: 'k-r', sessions: { 'k-r': bucket }, remoteWorkspaces: [ROW] }),
  );
  assert.equal(toast, null);
});

test('a failed dial shows nothing — the problem row is the surface for that', () => {
  const bucket = createSessionBucket('k-r', '/home/me/srv', { ericai: false, maxSteps: null }, 'rw-1');
  bucket.connection = { phase: 'failed', problem: 'connection refused' };
  bucket.problem = 'connection refused';
  const toast = selectConnectingToast(
    state({ activeKey: 'k-r', sessions: { 'k-r': bucket }, remoteWorkspaces: [ROW] }),
  );
  assert.equal(toast, null);
});

test('a local session never shows the toast, whatever its state', () => {
  const bucket = createSessionBucket('k-l', 'C:/work', { ericai: false, maxSteps: null });
  const toast = selectConnectingToast(state({ activeKey: 'k-l', sessions: { 'k-l': bucket } }));
  assert.equal(toast, null);
});

test('nothing open shows nothing', () => {
  assert.equal(selectConnectingToast(state({})), null);
});
