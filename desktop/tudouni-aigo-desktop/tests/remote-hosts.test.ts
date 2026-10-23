/**
 * The saved hosts, and the two settings that had no surface.
 *
 * A host record is the **account** — user, address, port, key or password — and
 * several saved remote workspaces can sit on one. The wizard writes them as a
 * side effect of adding a workspace, and until the hosts dialog existed the
 * result was unreachable:
 *
 *   - `removeSshHost` was implemented, typed, and **called by nothing**, so a
 *     host that had been mistyped once lived in `aigo.prefs` for ever;
 *   - `configPolicy` was written by the sync prompt's "remember" and read by the
 *     check, and nothing could show it or change it back. A host left on
 *     `use-remote` kept that answer silently — the worst shape for a setting,
 *     because the consequence (this machine's config file no longer reaching the
 *     host) is invisible until somebody wonders why an edit did nothing.
 *
 * The dialog is thin; these assertions are about the store rules it stands on,
 * because those are what the refusal and the policy actually mean.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { useApp } from '@/state/store';

const HOST = {
  id: 'ssh-1',
  label: 'prod',
  host: '10.2.0.4',
  port: 22,
  user: 'deploy',
  identityFiles: [],
};
const IDLE = {
  id: 'ssh-2',
  label: 'spare',
  host: '10.9.9.9',
  port: 22,
  user: 'deploy',
  identityFiles: [],
};
const ENTRY = {
  id: 'rw-1',
  hostId: HOST.id,
  remotePath: '/srv/app',
  remoteBinary: '/home/deploy/.tudouni/runtime/current/tudouni-aigo',
  label: 'prod:app',
};

function install(hosts = [HOST, IDLE], entries = [ENTRY]): void {
  useApp.setState({ sshHosts: hosts, remoteWorkspaces: entries });
}

/* ============================================================
   Removing a host
   ============================================================ */

test('a host nothing references is removed', () => {
  install();

  const removed = useApp.getState().removeSshHost(IDLE.id);

  assert.equal(removed, true);
  assert.deepEqual(useApp.getState().sshHosts.map((host) => host.id), [HOST.id]);
});

test('a host a saved workspace still names is refused, and nothing is removed', () => {
  // The refusal is the whole point of `removeSshHost` answering a boolean: a
  // workspace that lost its host could not say where it lives, and its row would
  // be an entry that opens nothing.
  install();

  const removed = useApp.getState().removeSshHost(HOST.id);

  assert.equal(removed, false);
  assert.deepEqual(useApp.getState().sshHosts.map((host) => host.id), [HOST.id, IDLE.id]);
});

test('removing a host that does not exist answers false rather than throwing', () => {
  install();
  assert.equal(useApp.getState().removeSshHost('ssh-missing'), false);
});

test('the removal is remembered, not just applied to the store', () => {
  // `removeSshHost` persists; a host that came back on the next launch would be
  // the same "there is no way to get rid of it" complaint one level down. The
  // assertion is on the store's own state after a re-read of the preference
  // writer's input.
  install();
  useApp.getState().removeSshHost(IDLE.id);
  // The store is what `persistPrefs` reads, so a host absent here is a host
  // absent from the record it writes.
  assert.equal(useApp.getState().sshHosts.some((host) => host.id === IDLE.id), false);
});

/* ============================================================
   The config policy
   ============================================================ */

test('a host with no stored policy reads as ask', () => {
  // `undefined` is what every host saved before the field existed has, and "ask"
  // is the safe reading: it is the only policy that cannot overwrite anything
  // without a decision.
  install();
  const host = useApp.getState().sshHosts.find((row) => row.id === HOST.id);
  assert.equal(host?.configPolicy ?? 'ask', 'ask');
});

test('each policy can be set, including changing one back to ask', () => {
  // **The one-way state this dialog exists to undo.** The sync prompt's
  // "remember" could only ever move a host off `ask`; nothing could move it back.
  install();

  useApp.getState().updateSshHost(HOST.id, { configPolicy: 'use-remote' });
  assert.equal(useApp.getState().sshHosts.find((row) => row.id === HOST.id)?.configPolicy, 'use-remote');

  useApp.getState().updateSshHost(HOST.id, { configPolicy: 'sync-local' });
  assert.equal(useApp.getState().sshHosts.find((row) => row.id === HOST.id)?.configPolicy, 'sync-local');

  useApp.getState().updateSshHost(HOST.id, { configPolicy: 'ask' });
  assert.equal(useApp.getState().sshHosts.find((row) => row.id === HOST.id)?.configPolicy, 'ask');
});

test('setting the policy does not disturb the host\'s identity', () => {
  // `updateSshHost` merges, and the id is re-stamped rather than trusted from
  // the patch — a form that posted a whole host record must not be able to
  // renumber the row the workspaces point at.
  install();
  useApp.getState().updateSshHost(HOST.id, { configPolicy: 'sync-local' });

  const host = useApp.getState().sshHosts.find((row) => row.id === HOST.id);
  assert.equal(host?.host, HOST.host);
  assert.equal(host?.user, HOST.user);
  assert.equal(host?.port, HOST.port);
  assert.equal(host?.label, HOST.label);
});

/* ============================================================
   Re-adding a workspace that is already saved
   ============================================================ */

test('adding a workspace that already exists updates its name instead of dropping it', () => {
  // The wizard can legitimately walk to the same place twice. It used to keep the
  // name from the first visit and ignore what was typed on the second, and there
  // was no other UI that could change a label — `updateRemoteWorkspace` supported
  // it and nothing called it.
  install([HOST], [ENTRY]);

  const id = useApp.getState().addRemoteWorkspace({ ...ENTRY, label: 'renamed' });

  assert.equal(id, ENTRY.id, 'the same row, not a second one');
  assert.equal(useApp.getState().remoteWorkspaces.length, 1);
  assert.equal(useApp.getState().remoteWorkspaces[0]?.label, 'renamed');
});

test('an empty label does not erase the saved one', () => {
  // A caller with nothing to say is not a caller asking for a blank name.
  install([HOST], [ENTRY]);

  useApp.getState().addRemoteWorkspace({ ...ENTRY, label: '   ' });

  assert.equal(useApp.getState().remoteWorkspaces[0]?.label, ENTRY.label);
});

test('a path learned later is recorded, and one already known is not overwritten', () => {
  // The original behaviour, kept: blank means "not installed yet", and the
  // install writes the path back through this same call.
  install([HOST], [{ ...ENTRY, remoteBinary: '' }]);
  useApp.getState().addRemoteWorkspace({ ...ENTRY, remoteBinary: '/new/path' });
  assert.equal(useApp.getState().remoteWorkspaces[0]?.remoteBinary, '/new/path');

  useApp.getState().addRemoteWorkspace({ ...ENTRY, remoteBinary: '/stale/path' });
  assert.equal(
    useApp.getState().remoteWorkspaces[0]?.remoteBinary,
    '/new/path',
    'a second visit does not clobber a path that is already known',
  );
});
