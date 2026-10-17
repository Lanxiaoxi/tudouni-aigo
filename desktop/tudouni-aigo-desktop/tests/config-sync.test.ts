/**
 * Which config-sync question is worth asking, and which is not.
 *
 * This is the half of §9.4/§9.5 that **cannot be seen in a rendered dialog**:
 * the prompt looks identical whether it was necessary or not, and the report
 * this file exists for is exactly that — "I rewrote the server five minutes ago
 * and it is asking me the same thing again".
 *
 * The rules below are corrections, and each of them used to produce an
 * interruption with nothing behind it:
 *
 *   1. **A host with no local config.json was asked on every single open.** The
 *      old comparison stood `''` in for "there is no local file", so it could
 *      never equal a baseline recorded from the remote: every open flagged
 *      `local_changed`, the only enabled answer was "use remote" (which writes
 *      nothing), and the next open asked again — a loop with no exit.
 *   2. **Answering "use remote" made the next open ask again.** The local file
 *      is *deliberately* left different from the remote in that pair, so a
 *      comparison of both sides against the single synced baseline reported a
 *      local change forever. Each side now records the value it was last seen
 *      at, which is a question a person can settle once.
 *   3. **Two absent files were a question with both buttons disabled.**
 *
 * The comparison itself is over content fingerprints, never modification times
 * (§9.5) — which is why "five minutes ago" is not an argument here, and why the
 * prompt now names the side whose bytes moved instead of claiming both did.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configConflict, decideConfigSync, type ConfigSyncInput } from '@/state/configSync';
import { useApp } from '@/state/store';

/** Two arbitrary, distinct fingerprints — the values carry no meaning. */
const LOCAL = 'a'.repeat(64);
const REMOTE = 'b'.repeat(64);

function input(overrides: Partial<ConfigSyncInput> = {}): ConfigSyncInput {
  return {
    baseline: LOCAL,
    localBaseline: LOCAL,
    localFingerprint: LOCAL,
    remoteFingerprint: LOCAL,
    remoteStatus: 'valid',
    policy: 'ask',
    ...overrides,
  };
}

/* ============================================================
   The comparison
   ============================================================ */

test('neither side moved: nothing changed', () => {
  assert.equal(
    configConflict({ baseline: LOCAL, localBaseline: LOCAL, localFingerprint: LOCAL, remoteFingerprint: LOCAL }),
    'none',
  );
});

test('no baseline at all is a conflict, never a silent overwrite', () => {
  // §9.5: "when an accurate comparison is not possible, treat it as a conflict".
  // The first sync of a host is the ordinary case.
  assert.equal(
    configConflict({ baseline: '', localBaseline: '', localFingerprint: LOCAL, remoteFingerprint: REMOTE }),
    'both_changed',
  );
});

test('a missing local file is not a local change', () => {
  // The loop this fixes: `null` used to be compared as `''`, so this host
  // re-flagged itself on every open no matter what the person answered.
  assert.equal(
    configConflict({ baseline: REMOTE, localBaseline: REMOTE, localFingerprint: null, remoteFingerprint: REMOTE }),
    'none',
  );
});

test('the four outcomes are attributable to a side', () => {
  const base = { baseline: LOCAL, localBaseline: LOCAL };
  assert.equal(configConflict({ ...base, localFingerprint: LOCAL, remoteFingerprint: REMOTE }), 'remote_changed');
  assert.equal(configConflict({ ...base, localFingerprint: REMOTE, remoteFingerprint: LOCAL }), 'local_changed');
  assert.equal(configConflict({ ...base, localFingerprint: REMOTE, remoteFingerprint: REMOTE }), 'both_changed');
});

test('a remote that disappeared reads as a remote change', () => {
  // `''` is "no remote file", and it is not the baseline — the remote side moved
  // by going away, which is exactly the kind of thing not to overwrite blindly.
  assert.equal(
    configConflict({ baseline: LOCAL, localBaseline: LOCAL, localFingerprint: LOCAL, remoteFingerprint: '' }),
    'remote_changed',
  );
});

test('a host saved with only the one baseline still compares', () => {
  // Records written before the local side was kept have no `localBaseline`. They
  // fall back to the remote baseline rather than reading every one of them as a
  // local change, and settle themselves on the next decision.
  assert.equal(
    configConflict({ baseline: LOCAL, localBaseline: '', localFingerprint: LOCAL, remoteFingerprint: LOCAL }),
    'none',
  );
});

/* ============================================================
   What an `ask` host is actually asked about
   ============================================================ */

test('a first sync is asked', () => {
  const decision = decideConfigSync(input({ baseline: '', localBaseline: '', localFingerprint: LOCAL, remoteFingerprint: REMOTE }));
  assert.deepEqual(decision, { kind: 'ask', conflict: 'both_changed' });
});

test('a changed remote is asked', () => {
  const decision = decideConfigSync(input({ remoteFingerprint: REMOTE }));
  assert.deepEqual(decision, { kind: 'ask', conflict: 'remote_changed' });
});

test('nothing to compare is not a question — both answers would be disabled', () => {
  assert.deepEqual(
    decideConfigSync(input({ baseline: '', localBaseline: '', localFingerprint: null, remoteFingerprint: '', remoteStatus: 'missing' })),
    { kind: 'nothing' },
  );
});

test('a local-only change is asked, because pushing it up is a real choice', () => {
  // The remote is stale but intact, and the new key exists only on this machine.
  // Asking is not noise: "use local" is the only path from here to a remote that
  // has it. What made it *repeat* was the missing local baseline, not the ask.
  assert.deepEqual(
    decideConfigSync(input({ localFingerprint: REMOTE, remoteFingerprint: LOCAL })),
    { kind: 'ask', conflict: 'local_changed' },
  );
});

test('answering "use remote" does not make the next open ask again', () => {
  // The stale mode of the loop: "use remote" records the remote as the baseline,
  // which the local file now differs from by design. Comparing both sides against
  // that one baseline read as `local_changed` on every later open — the same
  // question, from an answer already given. The answer records the local side's
  // own last-seen value, so the pair is settled.
  const afterAnswer: Partial<ConfigSyncInput> = {
    baseline: REMOTE,
    localBaseline: LOCAL,
    localFingerprint: LOCAL,
    remoteFingerprint: REMOTE,
  };
  assert.deepEqual(decideConfigSync(input(afterAnswer)), { kind: 'nothing' });

  // And it is settled for the *remote* direction too: when the remote moves
  // afterwards, that is a genuinely new fact and is asked about once more.
  assert.deepEqual(decideConfigSync(input({ ...afterAnswer, remoteFingerprint: 'c'.repeat(64) })), {
    kind: 'ask',
    conflict: 'remote_changed',
  });
});

test('an untouched remote template with no local file is not a decision', () => {
  // §9.3: the first screen a fresh account always starts from. Adopting it
  // writes nothing and stops it coming back.
  const decision = decideConfigSync(
    input({ baseline: '', localBaseline: '', localFingerprint: null, remoteFingerprint: REMOTE, remoteStatus: 'empty_template' }),
  );
  assert.deepEqual(decision, { kind: 'adopt-remote', fingerprint: REMOTE });
});

/* ============================================================
   The two automatic policies
   ============================================================ */

test('sync-local uploads when there is something to upload', () => {
  assert.deepEqual(decideConfigSync(input({ policy: 'sync-local', localFingerprint: REMOTE })), {
    kind: 'upload-local',
  });
  // No local file: nothing to push, and the remote is left exactly as it is.
  assert.deepEqual(
    decideConfigSync(input({ policy: 'sync-local', localFingerprint: null, remoteFingerprint: REMOTE })),
    { kind: 'nothing' },
  );
});

test('use-remote only ever moves the baseline, and never writes', () => {
  const decision = decideConfigSync(input({ policy: 'use-remote', localFingerprint: REMOTE, remoteFingerprint: REMOTE }));
  assert.deepEqual(decision, { kind: 'adopt-remote', fingerprint: REMOTE });
});

test('use-remote against a missing file records nothing rather than an empty baseline', () => {
  // `''` is not a baseline — storing it would make every later check read as a
  // first sync, and the host would never leave the "no comparison" state.
  const decision = decideConfigSync(
    input({ policy: 'use-remote', localFingerprint: LOCAL, remoteFingerprint: '', remoteStatus: 'missing' }),
  );
  assert.deepEqual(decision, { kind: 'nothing' });
});

/* ============================================================
   One answer at a time
   ============================================================ */

function promptFor(hostId: string) {
  return {
    hostId,
    conflict: 'both_changed' as const,
    firstSync: true,
    remoteStatus: 'valid' as const,
    localText: '{}',
    localFingerprint: LOCAL,
    remoteFingerprint: REMOTE,
  };
}

test('a second answer is ignored while one is being written', () => {
  // The write is a fresh SSH connection plus an SFTP round trip, so the dialog
  // is on screen for a second or two with the buttons live. Two presses used to
  // mean two uploads of the same file.
  const store = useApp.getState();
  for (const host of store.sshHosts) useApp.getState().removeSshHost(host.id);

  const hostId = useApp.getState().addSshHost({
    label: 'config-sync-test',
    host: '192.0.2.10',
    port: 22,
    user: 'tester',
    identityFiles: [],
  });

  useApp.setState({ configSyncPrompt: promptFor(hostId), configSyncBusy: 'use-local' });

  // No await: the guard returns before the promise ever reaches the bridge.
  void useApp.getState().resolveConfigSync('use-remote', { remember: true });

  assert.notEqual(useApp.getState().configSyncPrompt, null, 'the prompt must survive an answer it ignored');
  assert.equal(
    useApp.getState().sshHosts.find((h) => h.id === hostId)?.configBaselineFingerprint,
    undefined,
    'an ignored answer must not touch the baseline',
  );

  // Leave the store as it was found: this suite shares one module instance.
  useApp.setState({ configSyncPrompt: null, configSyncBusy: null });
  useApp.getState().removeSshHost(hostId);
});

test('Cancel cannot abandon an open while its answer is being written', () => {
  // The write has already been committed as far as the store is concerned:
  // `resolveConfigSync` resumes the parked open once it returns. Letting the
  // prompt go in between would start a session that nothing on screen asked for.
  const hostId = useApp.getState().addSshHost({
    label: 'config-sync-cancel-test',
    host: '192.0.2.11',
    port: 22,
    user: 'tester',
    identityFiles: [],
  });

  useApp.setState({
    configSyncPrompt: promptFor(hostId),
    configSyncBusy: 'use-local',
    pendingRemoteOpen: 'rw-under-test',
  });

  useApp.getState().dismissConfigSync();

  assert.notEqual(useApp.getState().configSyncPrompt, null, 'a mid-write prompt stays up');
  assert.equal(useApp.getState().pendingRemoteOpen, 'rw-under-test', 'and keeps the open it blocks');

  useApp.setState({ configSyncPrompt: null, configSyncBusy: null, pendingRemoteOpen: null });
  useApp.getState().removeSshHost(hostId);
});
