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
 * A file now behaves like a picture in the other respects too, and these tests
 * pin each of them, because every failure here is silent:
 *
 *   - the chip and its token are drawn **before** the upload, not after;
 *   - one drop is **one call** (one SSH connection on the Rust side), with an
 *     answer per file, so one bad path does not swallow the good one;
 *   - a send while the upload is in flight is held back, rather than going out
 *     without the file and leaving the path to land in an emptied draft;
 *   - a chip dismissed mid-upload does not come back, and a late answer is not
 *     promoted onto a *later* chip that reuses the same token.
 *
 * These assertions drive the real store and the real `runtime/tauri.ts` against a
 * fake host that holds each answer open; the upload itself is the Rust door
 * (`attach.rs`), whose own tests cover the per-path checks and the name loop.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp, type SessionRuntime } from '@/state/store';
import { registerRuntime } from '@/runtime/bus';

/* ============================================================
   A fake host that holds every attach open until the test answers it
   ============================================================ */

interface Call {
  args: { key: unknown; localPaths: string[] };
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Every `attach_files_remote` the store made, in order. */
let calls: Call[] = [];

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
    convertFileSrc: (path: string) => path,
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'attach_files_remote') {
        return new Promise((resolve, reject) => {
          calls.push({
            args: { key: args.key, localPaths: (args.localPaths as string[]) ?? [] },
            resolve,
            reject,
          });
        });
      }
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      return Promise.resolve(null);
    },
  },
};

/** Let the promise chain behind `attachFiles` reach the held call. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ok = (localPath: string, path: string, name: string) => ({
  localPath,
  file: { path, name, bytes: 10 },
  error: null,
});
const bad = (localPath: string, error: string) => ({ localPath, file: null, error });

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
  calls = [];
}

const bucket = () => useApp.getState().sessions[KEY];

/* ============================================================
   The remote half: the upload
   ============================================================ */

test('a dropped file on a remote screen is uploaded, and the relative path is what gets inserted', async () => {
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\Users\\me\\report.pdf']);
  await flush();

  // The upload is keyed by the child, never by a destination the UI assembled.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { key: 7, localPaths: ['C:\\Users\\me\\report.pdf'] });

  calls[0].resolve([ok('C:\\Users\\me\\report.pdf', 'attach/k-remote/report.pdf', 'report.pdf')]);
  const attached = await done;

  assert.equal(attached, 1);
  // The path never reaches the draft. Before the fix it did — as an absolute
  // path on this machine, in a sentence a host would read.
  assert.ok(!bucket().draft.includes('C:\\Users\\me'), 'the local path must not be in the sentence');
  assert.ok(bucket().draft.includes('⟦file-0⟧'), 'a placeholder stands in for it while the sentence is written');
  assert.equal(bucket().attachedFiles[0]?.path, 'attach/k-remote/report.pdf', 'and the chip carries the host-relative path');
  assert.deepEqual(bucket().pendingFiles, []);
});

test('the chip and its token are drawn before the host has answered', async () => {
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\a\\one.txt', 'C:\\a\\two.txt']);
  await flush();

  // The tokens are in the sentence and the chips are drawn from the pending
  // list: the file exists on screen before it exists on the host.
  assert.equal(bucket().draft, '⟦file-0⟧ ⟦file-1⟧');
  assert.deepEqual(
    bucket().pendingFiles.map((entry) => [entry.placeholder, entry.name]),
    [
      ['⟦file-0⟧', 'one.txt'],
      ['⟦file-1⟧', 'two.txt'],
    ],
  );
  assert.deepEqual(bucket().attachedFiles, [], 'nothing is attached yet');

  calls[0].resolve([
    ok('C:\\a\\one.txt', 'attach/7/one.txt', 'one.txt'),
    ok('C:\\a\\two.txt', 'attach/7/two.txt', 'two.txt'),
  ]);
  assert.equal(await done, 2);

  // The same chips, in order, keeping their tokens; the sentence is untouched.
  assert.deepEqual(bucket().pendingFiles, []);
  assert.deepEqual(
    bucket().attachedFiles.map((file) => [file.placeholder, file.path]),
    [
      ['⟦file-0⟧', 'attach/7/one.txt'],
      ['⟦file-1⟧', 'attach/7/two.txt'],
    ],
  );
  assert.equal(bucket().draft, '⟦file-0⟧ ⟦file-1⟧');
});

test('a drop is inserted at the caret it was given, now that the insertion is synchronous', async () => {
  screen(ENTRY.id);
  useApp.setState({
    sessions: { [KEY]: { ...bucket(), draft: 'look at  please' } },
  });

  const done = useApp.getState().attachFiles(['C:\\a\\one.txt'], 'look at '.length);
  await flush();

  assert.equal(bucket().draft, 'look at ⟦file-0⟧ please', 'it landed where the caret was, not at the end');

  calls[0].resolve([ok('C:\\a\\one.txt', 'attach/7/one.txt', 'one.txt')]);
  await done;
});

test('a name the host numbered is the name the chip shows', async () => {
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\a\\report.pdf']);
  await flush();
  calls[0].resolve([ok('C:\\a\\report.pdf', 'attach/7/report-2.pdf', 'report-2.pdf')]);
  await done;

  assert.equal(bucket().attachedFiles[0]?.name, 'report-2.pdf');
});

/* ============================================================
   One call per drop, one answer per file
   ============================================================ */

test('several files are one call, and one failure does not swallow the file that worked', async () => {
  // The whole point of the batch: a drop is one gesture, so the Rust side dials
  // once. And a directory in the drop says nothing about the file beside it.
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\a\\ok.txt', 'C:\\a\\bad.txt']);
  await flush();

  assert.equal(calls.length, 1, 'one call for the whole gesture');
  assert.deepEqual(calls[0].args.localPaths, ['C:\\a\\ok.txt', 'C:\\a\\bad.txt']);

  calls[0].resolve([
    ok('C:\\a\\ok.txt', 'attach/7/ok.txt', 'ok.txt'),
    bad('C:\\a\\bad.txt', 'C:\\a\\bad.txt is a directory — attach a file, or put it in the workspace first'),
  ]);
  assert.equal(await done, 1, 'the good one landed');

  assert.equal(bucket().attachedFiles.length, 1);
  assert.equal(bucket().attachedFiles[0].path, 'attach/7/ok.txt');
  // The one that will never ship comes out with its token: a pending chip left on
  // screen would promise a file that is not coming.
  assert.equal(bucket().draft, '⟦file-0⟧');
  assert.deepEqual(bucket().pendingFiles, []);
  const notice = bucket().composerNotice;
  assert.ok(notice !== null && notice.code === 'attach-remote-failed');
  assert.deepEqual(notice.names, ['bad.txt']);
  // The bridge's sentence, verbatim: it is already written for a person, and a
  // second wording here would be a second fact.
  assert.ok(notice.reason.includes('is a directory'));
});

test('a remote refusal is said in the composer, and nothing is left behind', async () => {
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\Users\\me\\big.zip']);
  await flush();
  calls[0].resolve([
    bad('C:\\Users\\me\\big.zip', 'C:\\Users\\me\\big.zip is 90000000 bytes, over the 67108864 byte ceiling for one attached file'),
  ]);

  assert.equal(await done, 0);
  assert.equal(bucket().draft, '', 'a file that did not arrive must not leave a token behind');
  assert.equal(bucket().attachedFiles.length, 0);
  assert.equal(bucket().pendingFiles.length, 0);
  const notice = bucket().composerNotice;
  assert.ok(notice !== null && notice.code === 'attach-remote-failed');
  assert.deepEqual(notice.names, ['big.zip']);
  assert.ok(notice.reason.includes('ceiling'));
});

test('a failure of the whole call fails every file of it, with the bridge’s sentence', async () => {
  // The session is gone, or the link is: nothing was uploaded, and every chip of
  // the gesture shares the reason.
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\a\\one.txt', 'C:\\a\\two.txt']);
  await flush();
  calls[0].reject('could not open a TCP connection to 10.2.0.4:22');

  assert.equal(await done, 0);
  assert.equal(bucket().draft, '');
  assert.deepEqual(bucket().pendingFiles, []);
  const notice = bucket().composerNotice;
  assert.ok(notice !== null && notice.code === 'attach-remote-failed');
  assert.deepEqual(notice.names, ['one.txt', 'two.txt']);
  assert.equal(notice.reason, 'could not open a TCP connection to 10.2.0.4:22');
});

test('an answer for fewer files than were sent is a failure, not a chip that spins for ever', async () => {
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\a\\one.txt', 'C:\\a\\two.txt']);
  await flush();
  calls[0].resolve([ok('C:\\a\\one.txt', 'attach/7/one.txt', 'one.txt')]);

  assert.equal(await done, 0);
  assert.deepEqual(bucket().pendingFiles, [], 'no chip is left saying “Uploading…”');
  assert.equal(bucket().composerNotice?.code, 'attach-remote-failed');
});

/* ============================================================
   Sending while the upload is in flight
   ============================================================ */

test('a send while the upload is in flight is held back, and says why', async () => {
  // This is the report: the message used to leave without the file, and the path
  // then landed in a draft that had already been emptied.
  screen(ENTRY.id);
  const sent: string[] = [];
  registerRuntime({
    key: KEY,
    send(msg) {
      if (msg.t === 'user_message') sent.push(msg.text);
    },
    subscribe() {
      return () => undefined;
    },
    dispose() {
      /* nothing to release in a sink */
    },
  });

  const done = useApp.getState().attachFiles(['C:\\a\\notes.md']);
  await flush();
  useApp.getState().setDraft(`read ${bucket().draft}`);

  useApp.getState().submitDraft();

  assert.deepEqual(sent, [], 'nothing went out');
  assert.equal(bucket().draft, 'read ⟦file-0⟧', 'and the draft is left exactly as the person left it');
  assert.equal(bucket().composerNotice?.code, 'attach-pending');
  assert.deepEqual(bucket().entries, []);

  // Once the host answers, the same send goes through, with the path in it.
  calls[0].resolve([ok('C:\\a\\notes.md', 'attach/7/notes.md', 'notes.md')]);
  await done;
  assert.equal(bucket().composerNotice, null, 'the “still uploading” notice is answered');
  useApp.getState().submitDraft();

  assert.deepEqual(sent, ['read attach/7/notes.md'], 'the sentence on the wire carries the path');
  assert.equal(bucket().entries[0].text, 'read ⟦file-0⟧', 'the transcript keeps what the person wrote');
  assert.equal(bucket().draft, '');
  assert.deepEqual(bucket().attachedFiles, []);
  assert.deepEqual(bucket().pendingFiles, []);
});

test('a pending chip whose token the person deleted does not hold the send', async () => {
  // Only a *referenced* pending chip refuses: a marker that is gone from the
  // sentence is a file the person decided not to send.
  screen(ENTRY.id);
  const sent: string[] = [];
  registerRuntime({
    key: KEY,
    send(msg) {
      if (msg.t === 'user_message') sent.push(msg.text);
    },
    subscribe() {
      return () => undefined;
    },
    dispose() {
      /* nothing to release in a sink */
    },
  });

  const done = useApp.getState().attachFiles(['C:\\a\\notes.md']);
  await flush();
  useApp.getState().setDraft('just words');

  useApp.getState().submitDraft();
  assert.deepEqual(sent, ['just words']);

  calls[0].resolve([ok('C:\\a\\notes.md', 'attach/7/notes.md', 'notes.md')]);
  await done;
  assert.deepEqual(bucket().attachedFiles, [], 'a file sent past does not reappear as a chip');
});

/* ============================================================
   Dismissing, and tokens that get reused
   ============================================================ */

test('a chip the person removes while it uploads does not come back', async () => {
  screen(ENTRY.id);

  const done = useApp.getState().attachFiles(['C:\\a\\notes.md']);
  await flush();

  useApp.getState().forgetPendingFile('⟦file-0⟧');
  assert.equal(bucket().draft, '', 'dismissing the chip takes the token out');
  assert.deepEqual(bucket().pendingFiles, []);

  // The upload was already in flight and cannot be cancelled — what must not
  // happen is the chip reappearing when it finishes.
  calls[0].resolve([ok('C:\\a\\notes.md', 'attach/7/notes.md', 'notes.md')]);
  await done;

  assert.deepEqual(bucket().attachedFiles, []);
  assert.equal(bucket().draft, '');
});

test('a late answer is not promoted onto a later chip that reuses the same token', async () => {
  // `⟦file-0⟧` is only unique within the draft as it is *now*. Dismiss the first
  // chip, drop another file, and the same token is minted again while the first
  // upload is still in flight. Matched by token the first answer would hand the
  // second chip the wrong file's path — a message that quietly sends something
  // else, which is the worst thing this feature can do.
  screen(ENTRY.id);

  const first = useApp.getState().attachFiles(['C:\\a\\first.txt']);
  await flush();
  useApp.getState().forgetPendingFile('⟦file-0⟧');

  const second = useApp.getState().attachFiles(['C:\\a\\second.txt']);
  await flush();
  assert.equal(bucket().draft, '⟦file-0⟧', 'the token is minted again');

  calls[0].resolve([ok('C:\\a\\first.txt', 'attach/7/first.txt', 'first.txt')]);
  await first;
  assert.deepEqual(bucket().attachedFiles, [], 'the first file’s path went to nobody');
  assert.equal(bucket().pendingFiles.length, 1, 'and the second chip is still waiting for its own answer');

  await flush();
  assert.equal(calls.length, 2);
  calls[1].resolve([ok('C:\\a\\second.txt', 'attach/7/second.txt', 'second.txt')]);
  await second;
  assert.equal(bucket().attachedFiles[0]?.path, 'attach/7/second.txt');
});

test('two drops are uploaded one after the other, never together', async () => {
  // The host's name check is a stat followed by a create — not atomic. Two
  // uploads at once could both be told `report.pdf` is free. Chips are drawn
  // immediately, so a second drop mid-upload is an ordinary thing to do; it waits
  // its turn with its chip already on screen.
  screen(ENTRY.id);

  const first = useApp.getState().attachFiles(['C:\\a\\report.pdf']);
  const second = useApp.getState().attachFiles(['C:\\b\\report.pdf']);
  await flush();

  assert.equal(calls.length, 1, 'the second drop has not started');
  assert.equal(bucket().pendingFiles.length, 2, 'but both chips are drawn');
  assert.equal(bucket().draft, '⟦file-0⟧ ⟦file-1⟧');

  calls[0].resolve([ok('C:\\a\\report.pdf', 'attach/7/report.pdf', 'report.pdf')]);
  await first;
  await flush();

  assert.equal(calls.length, 2, 'now it has');
  calls[1].resolve([ok('C:\\b\\report.pdf', 'attach/7/report-2.pdf', 'report-2.pdf')]);
  await second;

  assert.deepEqual(
    bucket().attachedFiles.map((file) => file.path),
    ['attach/7/report.pdf', 'attach/7/report-2.pdf'],
  );
});

test('a chip dismissed while its drop waits its turn is never uploaded', async () => {
  screen(ENTRY.id);

  const first = useApp.getState().attachFiles(['C:\\a\\one.txt']);
  const second = useApp.getState().attachFiles(['C:\\a\\two.txt']);
  await flush();
  useApp.getState().forgetPendingFile('⟦file-1⟧');

  calls[0].resolve([ok('C:\\a\\one.txt', 'attach/7/one.txt', 'one.txt')]);
  await first;
  assert.equal(await second, 0);

  assert.equal(calls.length, 1, 'nothing was started for the dismissed file');
  assert.equal(bucket().attachedFiles.length, 1);
});

test('a failed drop does not wedge the queue behind it', async () => {
  screen(ENTRY.id);

  const first = useApp.getState().attachFiles(['C:\\a\\one.txt']);
  const second = useApp.getState().attachFiles(['C:\\a\\two.txt']);
  await flush();

  calls[0].reject('the remote host refused the connection');
  assert.equal(await first, 0);
  await flush();

  assert.equal(calls.length, 2, 'the next drop still runs');
  calls[1].resolve([ok('C:\\a\\two.txt', 'attach/7/two.txt', 'two.txt')]);
  assert.equal(await second, 1);
});

/* ============================================================
   The local half, unchanged
   ============================================================ */

test('a dropped file on a local screen is inserted as the OS gave it, with no upload', async () => {
  screen(null);

  const attached = await useApp.getState().attachFiles(['C:\\work\\note.md']);

  assert.equal(attached, 1);
  // The local branch keeps the placeholder too — `attachFilePath` is the same
  // door it always was — and the path it will restore is the local one.
  assert.equal(bucket().attachedFiles[0]?.path, 'C:\\work\\note.md');
  assert.deepEqual(bucket().pendingFiles, [], 'a local file has nothing to wait for');
  assert.equal(calls.length, 0, 'nothing is uploaded for a local session');
});

test('with no session open there is nothing to attach to', async () => {
  useApp.setState({ sessions: {}, order: [], activeKey: null });
  calls = [];
  const attached = await useApp.getState().attachFiles(['C:\\work\\note.md']);
  assert.equal(attached, 0);
  assert.equal(calls.length, 0);
});
