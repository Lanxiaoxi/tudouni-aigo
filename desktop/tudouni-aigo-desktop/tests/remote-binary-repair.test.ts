/**
 * A recorded `remoteBinary` that no longer works.
 *
 * The reported shape: a saved remote workspace whose host had been reinstalled
 * (or whose `~/.tudouni` was cleaned) still had a path recorded. Pressing the row
 * dialled that path, failed with "No such file or directory", and left a failure
 * row — while the rail's install button was hover-only and the entry still said
 * "installed". The only way back was to remember that the install button existed.
 *
 * The **two** halves of the repair are asserted here, because either one alone
 * leaves the button dead:
 *
 *   1. the front end clears the stale `remoteBinary` and retries **once**, which
 *      is what makes the automatic install path run at all;
 *   2. the Rust side stops trusting a version match on its own — a symlink whose
 *      target is gone still resolves to a version name, so
 *      `install_or_upgrade` used to answer "already at this version" and return
 *      a path that does not exist. That half is `remote_binary_usable`
 *      (`remote_install.rs`), asserted by its own unit tests; what this file
 *      pins is the front end's decision to reinstall, and that it happens once.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, looksLikeMissingBinary, useApp } from '@/state/store';

/* ============================================================
   The decision itself
   ============================================================ */

test('a shell saying the binary is gone is recognised as that, not as a network failure', () => {
  // The phrases the far side actually produces.
  assert.equal(looksLikeMissingBinary('could not start the remote runtime: sh: 1: /home/x/.tudouni/runtime/current/tudouni-aigo: not found'), true);
  assert.equal(looksLikeMissingBinary('/home/x/.tudouni/runtime/current/tudouni-aigo: No such file or directory'), true);
  assert.equal(looksLikeMissingBinary('bash: /home/x/bin/rt: Permission denied'), true);
  assert.equal(looksLikeMissingBinary(': cannot execute binary file'), true);
});

test('a connection or credential refusal is not a missing binary', () => {
  // Installing again cannot fix any of these, and doing so would waste an upload
  // on every open of a host that is simply down.
  assert.equal(looksLikeMissingBinary('could not connect to the remote host: connection refused'), false);
  assert.equal(looksLikeMissingBinary('authentication failed for user deploy'), false);
  assert.equal(looksLikeMissingBinary('the SSH handshake timed out after 15s'), false);
});

/* ============================================================
   The repair, end to end
   ============================================================ */

let attaches: Record<string, unknown>[] = [];
let installs: Record<string, unknown>[] = [];
/** What the fake `runtime_attach_remote` does, in order. */
let dialOutcomes: ('ok' | 'missing' | 'refused')[] = [];

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'runtime_attach_remote') {
        attaches.push((args.options ?? {}) as Record<string, unknown>);
        const outcome = dialOutcomes.shift() ?? 'ok';
        if (outcome === 'missing') {
          return Promise.reject(
            new Error(
              '/home/deploy/.tudouni/runtime/current/tudouni-aigo: No such file or directory',
            ),
          );
        }
        if (outcome === 'refused') {
          return Promise.reject(new Error('could not connect to the remote host: connection refused'));
        }
        return Promise.resolve(400 + attaches.length);
      }
      if (cmd === 'install_remote_runtime') {
        installs.push(args as Record<string, unknown>);
        // A successful install writes the path back, which is the fact the next
        // dial uses.
        return Promise.resolve('/home/deploy/.tudouni/runtime/current/tudouni-aigo');
      }
      if (cmd === 'app_version') return Promise.resolve('4.18.0');
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  },
};

const HOST = { id: 'ssh-1', label: 'prod', host: '10.2.0.4', port: 22, user: 'deploy', identityFiles: [] };
const STALE = '/home/deploy/.tudouni/runtime/current/tudouni-aigo';

function window(remoteBinary: string): void {
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
    remoteWorkspaces: [
      { id: 'rw-1', hostId: HOST.id, remotePath: '/srv/app', remoteBinary, label: 'prod:app' },
    ],
    lastWorkspace: null,
    ericaiDefault: false,
    maxStepsDefault: null,
    configSyncPrompt: null,
    pendingRemoteOpen: null,
    openingRemote: null,
    installStatus: {},
  });
  attaches = [];
  installs = [];
  dialOutcomes = [];
}

test('a dial refused because the binary is gone reinstalls and reconnects, once', async () => {
  window(STALE);
  dialOutcomes = ['missing', 'ok'];

  await useApp.getState().connectRemoteWorkspace('rw-1');

  // The stale path was tried first — the record says "installed", and nothing
  // before the dial can know better. That is the reported failure, not a bug.
  assert.equal(attaches.length, 2, 'one repair, then one successful dial');
  assert.equal(String(attaches[0].remoteBinary), STALE);
  // The install ran, and that is what the entry's `remoteBinary` had to be
  // cleared for: a non-empty path tells `connectRemoteWorkspace` there is
  // nothing to install.
  assert.equal(installs.length, 1);
  // The second dial uses the path the install wrote back, never the stale one.
  assert.equal(String(attaches[1].remoteBinary), STALE);
  const s = useApp.getState();
  assert.equal(s.remoteWorkspaces[0]?.remoteBinary, STALE, 'and the entry carries it');
  assert.ok(s.sessions[s.activeKey ?? ''] !== undefined, 'a session landed on screen');
});

test('a network refusal is not "repaired" by installing', async () => {
  // Installing cannot fix a host that is down, and an upload on every open of a
  // genuinely unreachable host is a worse failure than the sentence it produces.
  window(STALE);
  dialOutcomes = ['refused'];

  await useApp.getState().connectRemoteWorkspace('rw-1');

  assert.equal(attaches.length, 1, 'one attempt, no repair');
  assert.equal(installs.length, 0, 'nothing was uploaded');
  const s = useApp.getState();
  const row = s.sessions[s.activeKey ?? ''];
  assert.ok(row !== undefined && row.problem !== null, 'the refusal has a row of its own');
  assert.equal(row.remoteWorkspaceId, 'rw-1', 'and it knows which host it belongs to');
});

test('a broken binary is not repaired twice — a host that cannot run it says so', async () => {
  // The guard against a loop: install, dial, still broken, install again. Each
  // round trip is an upload, and a person watching sees a row that never settles.
  window(STALE);
  dialOutcomes = ['missing', 'missing', 'missing'];

  await useApp.getState().connectRemoteWorkspace('rw-1');

  assert.equal(attemptCount(), 2, 'the repair happens once, then the refusal is reported');
  assert.equal(installs.length, 1, 'and only one upload');
  const s = useApp.getState();
  const row = s.sessions[s.activeKey ?? ''];
  assert.ok(row?.problem != null, 'the second refusal is on screen, with its own reason');
});

test('a workspace with no recorded binary installs first, with no wasted dial', async () => {
  // The ordinary first open. This path already existed and must not regress: an
  // empty `remoteBinary` means "not installed yet", and the install runs before
  // any dial.
  window('');
  dialOutcomes = ['ok'];

  await useApp.getState().connectRemoteWorkspace('rw-1');

  assert.equal(installs.length, 1);
  assert.equal(attaches.length, 1, 'and the dial happens after the install, not before');
});

/** How many dials the fake host was asked for. */
function attemptCount(): number {
  return attaches.length;
}
