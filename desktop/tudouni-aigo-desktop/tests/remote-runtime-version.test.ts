/**
 * Which build is answering this conversation.
 *
 * The reported bug: Audit drew `Runtime version` from the **window**, which is
 * read by running the binary next to this application. On a remote screen that is
 * a different build from the one running the session — the install is a one-off,
 * not an upgrade-on-connect — so the panel showed this machine's version beside a
 * `protocol` that had come from the host, in the one place somebody looks to work
 * out why a field is not being honoured.
 *
 * `init` carries no version to fall back on (`v` is the envelope, `protocol` is
 * the conversation's semantic version), so the host has to be asked by running
 * its binary once. These assertions pin three things about that:
 *
 *   - a **local** session never asks (the window value is already right);
 *   - a remote one asks **once**, and keeps the answer on the bucket;
 *   - "asked and the host did not answer" is a different state from "not asked" —
 *     the panel draws `unknown` for the first and nothing at all would be a lie
 *     about the second.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';

/* ============================================================
   A fake host, so the version probe can be observed
   ============================================================ */

let asks: unknown[] = [];
/** What the host answers with. `null` is "it did not answer". */
let answer: string | null = '4.9.0';

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'remote_runtime_version') {
        asks.push(args.key);
        return Promise.resolve(answer);
      }
      if (cmd === 'runtime_version') {
        asks.push('local');
        return Promise.resolve('4.18.0');
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

function bucketOf(key: string, remoteWorkspaceId: string | null): SessionRuntime {
  // The bridge's key is numeric on purpose: `bridgeKey` refuses anything else
  // before the IPC call, so a `k-…` key would make these assertions be about the
  // fake host rather than about the store.
  const bridgeKey = key.replace(/\D/g, '') || '1';
  const bucket = createSessionBucket(
    bridgeKey,
    remoteWorkspaceId === null ? 'C:/work' : ENTRY.remotePath,
    { ericai: false, maxSteps: null },
    remoteWorkspaceId,
  );
  bucket.ready = true;
  bucket.sessionId = 's-1';
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  return bucket;
}

function screen(remoteWorkspaceId: string | null): string {
  const key = '9';
  useApp.setState({
    sessions: { [key]: bucketOf(key, remoteWorkspaceId) },
    order: [key],
    activeKey: key,
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: null,
    runtimeVersion: '4.18.0',
  });
  asks = [];
  answer = '4.9.0';
  return key;
}

/* ============================================================
   Asking
   ============================================================ */

test('a remote session asks the host for its build, and keeps it on the bucket', async () => {
  const key = screen(ENTRY.id);

  await useApp.getState().resolveRuntimeBuild(key);

  assert.deepEqual(asks, [9], 'one probe, keyed by the child');
  assert.equal(useApp.getState().sessions[key]?.runtimeBuild, '4.9.0');
  // Deliberately **not** the window value: that is this machine's binary, and
  // showing it here is the bug.
  assert.notEqual(useApp.getState().sessions[key]?.runtimeBuild, useApp.getState().runtimeVersion);
});

test('asking twice probes once — a running process cannot change its build', async () => {
  const key = screen(ENTRY.id);

  await useApp.getState().resolveRuntimeBuild(key);
  await useApp.getState().resolveRuntimeBuild(key);

  assert.equal(asks.length, 1, 'the second call is answered from the bucket');
});

test('a host that does not answer is recorded as "asked, no answer"', async () => {
  // `''` rather than `null`: the panel draws "not asked yet" differently from
  // "asked and the host did not answer", and collapsing the two would leave a
  // panel that silently shows nothing where it should say `unknown`.
  const key = screen(ENTRY.id);
  answer = null;

  await useApp.getState().resolveRuntimeBuild(key);

  assert.equal(useApp.getState().sessions[key]?.runtimeBuild, '');
  assert.equal(asks.length, 1, 'the probe was still made');
});

test('a local session never asks the host', async () => {
  // The window-level `runtimeVersion` is already the right answer here, and a
  // probe would be an SSH call for a number this end already has.
  const key = screen(null);

  await useApp.getState().resolveRuntimeBuild(key);

  assert.deepEqual(asks, []);
  assert.equal(useApp.getState().sessions[key]?.runtimeBuild, null, 'and stays unasked');
});

test('a session that closed while the host was answering is left alone', async () => {
  // The probe is a dial; the person can close the conversation before it comes
  // back. Writing to a bucket that is gone would resurrect it under a key
  // nothing owns.
  const key = screen(ENTRY.id);
  const slow = useApp.getState().resolveRuntimeBuild(key);
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  await slow;

  assert.equal(useApp.getState().sessions[key], undefined, 'no bucket was resurrected');
});

/* ============================================================
   The parser, as a property of the output
   ============================================================ */

test('the version is the second field of the output, on either machine', () => {
  // `Describe()` prints name + version. The local and the remote probe share one
  // parser (Rust side), so this pins the shape both rely on: a `dev` build is
  // shown as-is, because prettifying it would hide which binary is running.
  const parse = (text: string): string | null => {
    const parts = text.trim().split(/\s+/);
    return parts[1] ?? null;
  };
  assert.equal(parse('tudouni-aigo 4.18.0'), '4.18.0');
  assert.equal(parse('tudouni-aigo dev'), 'dev');
  assert.equal(parse('tudouni-aigo'), null, 'a bare name carries no version');
});
