/**
 * Attaching a file from the **operating system** on a remote screen.
 *
 * The reported bug: dropping a file onto a remote session's composer inserted
 * `C:\Users\me\report.pdf` into the sentence, and the composer explained it with
 * "inserted, but outside this workspace — the file tools cannot read it directly,
 * the model would go through shell". Both halves were wrong there:
 *
 *   - the path is not "outside the remote workspace", it is on a different
 *     machine — the far runtime's `SafePath` refuses it, and
 *   - the *explanation* was false. The far shell cannot see this machine's
 *     `C:\Users\me\report.pdf` either, so the model had no route to the file at
 *     all. On a Linux client with a coincidentally identical path the failure
 *     was quieter and worse: the far end read **its own** file at that path, and
 *     the model answered about a file the person never sent.
 *
 * The fix is not a better sentence. It is to put the bytes where the runtime is
 * and name the **workspace-relative** path — what a pasted picture already does.
 *
 * These assertions pin the routing; the upload itself is the Rust door
 * (`attach.rs`), whose own tests cover the name-collision loop.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';

/* ============================================================
   A fake host that records every attach it was asked for
   ============================================================ */

let uploads: { key: unknown; localPath: string }[] = [];
/** What the fake upload answers with, so the insertion half can be asserted. */
let nextPath = 'attach/k-remote/report.pdf';
let refuse: string | null = null;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'attach_file_remote') {
        uploads.push({ key: args.key, localPath: String(args.localPath ?? '') });
        if (refuse !== null) return Promise.reject(new Error(refuse));
        return Promise.resolve({ path: nextPath, name: 'report.pdf', bytes: 10 });
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

/** The bridge's key for the child in these tests.
 *
 *  A **numeric** string on purpose: the bridge mints `ChildKey = u64` and
 *  `bridgeKey` refuses anything else before the IPC call — so a key like `k-1`
 *  would make every assertion here a statement about the fake host rather than
 *  about the store.
 */
const KEY = '7';

function bucketOf(workspace: string, remoteWorkspaceId: string | null): SessionRuntime {
  const bucket = createSessionBucket(KEY, workspace, { ericai: false, maxSteps: null }, remoteWorkspaceId);
  bucket.ready = true;
  bucket.sessionId = 's-1';
  bucket.session = { ...bucket.session!, resumed: true, id: 's-1' } as never;
  return bucket;
}

function screen(remoteWorkspaceId: string | null): void {
  useApp.setState({
    sessions: {
      [KEY]: bucketOf(remoteWorkspaceId === null ? 'C:/work' : ENTRY.remotePath, remoteWorkspaceId),
    },
    order: [KEY],
    activeKey: KEY,
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    sshHosts: [HOST],
    remoteWorkspaces: [ENTRY],
    lastWorkspace: null,
  });
  uploads = [];
  refuse = null;
  nextPath = 'attach/k-remote/report.pdf';
}

/* ============================================================
   The remote half
   ============================================================ */

test('a dropped file on a remote screen is uploaded, and the relative path is what gets inserted', async () => {
  screen(ENTRY.id);

  const attached = await useApp.getState().attachFiles(['C:\\Users\\me\\report.pdf']);

  assert.equal(attached, 1);
  // The path never reaches the draft. Before the fix it did — as an absolute
  // path on this machine, in a sentence a host would read.
  const bucket = useApp.getState().sessions[KEY];
  assert.ok(!bucket.draft.includes('C:\\Users\\me'), 'the local path must not be in the sentence');
  assert.ok(bucket.draft.includes('⟦file-0⟧'), 'a placeholder stands in for it while the sentence is written');
  assert.equal(bucket.attachedFiles[0]?.path, nextPath, 'and the chip carries the host-relative path');
  // The upload is keyed by the child, never by a destination the UI assembled.
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].localPath, 'C:\\Users\\me\\report.pdf');
  assert.equal(uploads[0].key, 7);
});

test('a remote refusal is said in the composer, and nothing is inserted', async () => {
  screen(ENTRY.id);
  refuse = 'C:\\Users\\me\\big.zip is 90000000 bytes, over the 67108864 byte ceiling for one attached file';

  const attached = await useApp.getState().attachFiles(['C:\\Users\\me\\big.zip']);

  assert.equal(attached, 0);
  const bucket = useApp.getState().sessions[KEY];
  assert.equal(bucket.draft, '', 'a file that did not arrive must not leave a token behind');
  assert.equal(bucket.attachedFiles.length, 0);
  const notice = bucket.composerNotice;
  assert.ok(notice !== null && notice.code === 'attach-remote-failed');
  assert.deepEqual(notice.names, ['big.zip']);
  // The bridge's sentence, verbatim: it is already written for a person, and a
  // second wording here would be a second fact.
  assert.ok(notice.reason.includes('ceiling'));
});

test('one failure does not swallow the file that worked', async () => {
  // A drop can carry several paths, and an upload is a fresh SSH dial each time.
  // Reporting only the last outcome would either hide a failure or discard a
  // file that did arrive.
  screen(ENTRY.id);
  const calls: string[] = [];
  const host = (globalThis as { window: { __TAURI_INTERNALS__: { invoke: unknown } } }).window.__TAURI_INTERNALS__;
  const original = host.invoke as (c: string, a: Record<string, unknown>) => unknown;
  host.invoke = (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'attach_file_remote') {
      const path = String(args.localPath ?? '');
      calls.push(path);
      if (path.endsWith('bad.txt')) return Promise.reject(new Error('it is a directory'));
      return Promise.resolve({ path: 'attach/k-remote/ok.txt', name: 'ok.txt', bytes: 1 });
    }
    return original(cmd, args);
  };
  try {
    const attached = await useApp.getState().attachFiles(['C:\\a\\ok.txt', 'C:\\a\\bad.txt']);
    assert.equal(attached, 1, 'the good one landed');
  } finally {
    host.invoke = original;
  }
  assert.equal(calls.length, 2, 'both were attempted');
  const bucket = useApp.getState().sessions[KEY];
  assert.equal(bucket.attachedFiles.length, 1);
  const notice = bucket.composerNotice;
  assert.ok(notice !== null && notice.code === 'attach-remote-failed');
  assert.deepEqual(notice.names, ['bad.txt']);
});

/* ============================================================
   The local half, unchanged
   ============================================================ */

test('a dropped file on a local screen is inserted as the OS gave it, with no upload', async () => {
  screen(null);

  const attached = await useApp.getState().attachFiles(['C:\\work\\note.md']);

  assert.equal(attached, 1);
  const bucket = useApp.getState().sessions[KEY];
  // The local branch keeps the placeholder too — `attachFilePath` is the same
  // door it always was — and the path it will restore is the local one.
  assert.equal(bucket.attachedFiles[0]?.path, 'C:\\work\\note.md');
  assert.equal(uploads.length, 0, 'nothing is uploaded for a local session');
});

test('with no session open there is nothing to attach to', async () => {
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  const attached = await useApp.getState().attachFiles(['C:\\work\\note.md']);
  assert.equal(attached, 0);
  assert.equal(uploads.length, 0);
});
