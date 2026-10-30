/**
 * The paste gesture: the chips come first, the paths come later.
 *
 * A pasted picture has two lives. While it is being written there is no path to
 * put in the sentence, so the chip and the placeholder are a **promise**; when
 * the bridge answers, the same chip becomes a stashed picture and the sentence
 * gains a path it can actually send. Both halves are easy to get wrong in ways
 * that look plausible on screen:
 *
 *   - a chip that never becomes a path (the picture silently does not arrive);
 *   - a send that goes out with the placeholder in it (prose where a picture
 *     should be);
 *   - a picture the person removed while it uploaded, coming back when it lands.
 *
 * These tests drive the real store and the real `runtime/tauri.ts` against a fake
 * Tauri host, and stop the bridge's answer in the middle so the pending state can
 * be looked at rather than raced against.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeRuntime, createAppStore, createSessionBucket } from '@/state/store';
import { registerRuntime } from '@/runtime/bus';
import { framePictures } from '@/runtime/paste';

/* ============================================================
   A fake host that holds `image_stash` open until the test answers it
   ============================================================ */

interface Held {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** The call the store is waiting on, and every command it tried. */
let held: Held | null = null;
const calls: { cmd: string; args: unknown; options: unknown }[] = [];

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
    convertFileSrc: (path: string) => path,
    invoke(cmd: string, args: unknown, options: unknown) {
      calls.push({ cmd, args, options });
      if (cmd === 'image_stash') {
        return new Promise((resolve, reject) => {
          held = { resolve, reject };
        });
      }
      return Promise.resolve(null);
    },
  },
};

/** Let the promise chain behind `pasteImages` reach the held call. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The key is numeric because the bridge mints decimal keys — `bridgeKey`
 *  refuses anything else rather than turning it into `null` on the wire. */
const KEY = '7';

/** A PNG's first bytes: enough for `classify` and for the Rust-side sniff. */
function png(width = 10): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, width]);
}

function storeWithSession() {
  const store = createAppStore();
  store.setState({
    sessions: {
      [KEY]: { ...createSessionBucket(KEY, 'C:/work', { ericai: false, maxSteps: null }), ready: true },
    },
    order: [KEY],
    activeKey: KEY,
  });
  return store;
}

const session = (store: ReturnType<typeof storeWithSession>) => store.getState().sessions[KEY];

/* ============================================================
   the frame one gesture sends
   ============================================================ */

test('the frame carries every picture of the gesture, with its length in the header', () => {
  const first = new Uint8Array([1, 2, 3]);
  const second = new Uint8Array([4, 5]);

  const frame = framePictures([first, second]);

  // magic, count, two lengths, then the bytes back to back.
  assert.equal(frame.byteLength, 8 + 4 + 4 * 2 + 3 + 2);
  assert.deepEqual(Array.from(frame.slice(0, 8)), Array.from(new TextEncoder().encode('TUDOIMG1')));
  const view = new DataView(frame.buffer);
  assert.equal(view.getUint32(8, true), 2, 'the count');
  assert.equal(view.getUint32(12, true), 3, 'the first length');
  assert.equal(view.getUint32(16, true), 2, 'the second length');
  assert.deepEqual(Array.from(frame.slice(20)), [1, 2, 3, 4, 5]);
});

/* ============================================================
   the pending chip
   ============================================================ */

test('a paste draws its chips before the bridge has answered', async () => {
  held = null;
  calls.length = 0;
  const store = storeWithSession();

  const done = store.getState().pasteImages(
    [
      { bytes: png(), mime: 'image/png' },
      { bytes: png(), mime: 'image/png' },
    ],
    0,
  );
  await flush();

  // The tokens are in the sentence, and the chips are drawn from the pending
  // list: the picture exists on screen before it exists on disk.
  const pending = session(store);
  assert.equal(pending.draft, '⟦pimg-0⟧ ⟦pimg-1⟧');
  assert.deepEqual(
    pending.pendingImages.map((image) => image.placeholder),
    ['⟦pimg-0⟧', '⟦pimg-1⟧'],
  );
  assert.deepEqual(pending.pastedImages, [], 'nothing is stashed yet');

  // **One call for the gesture**, carrying both pictures in one body and naming
  // the session in the header a raw body leaves room for.
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.cmd, 'image_stash');
  assert.equal((call.options as { headers: Record<string, string> }).headers['x-tudouni-key'], KEY);
  const body = call.args as Uint8Array;
  assert.equal(new DataView(body.buffer).getUint32(8, true), 2);
  assert.deepEqual(Array.from(body.slice(0, 8)), Array.from(new TextEncoder().encode('TUDOIMG1')));

  // The answer promotes the same chips, in order, keeping the tokens.
  held?.resolve([
    { path: '.tudouni/paste/a.png', name: 'paste-1.png', mime: 'image/png', bytes: 11 },
    { path: '.tudouni/paste/b.png', name: 'paste-2.png', mime: 'image/png', bytes: 11 },
  ]);
  const caret = await done;

  const landed = session(store);
  assert.deepEqual(landed.pendingImages, []);
  assert.deepEqual(
    landed.pastedImages.map((image) => [image.placeholder, image.path]),
    [
      ['⟦pimg-0⟧', '.tudouni/paste/a.png'],
      ['⟦pimg-1⟧', '.tudouni/paste/b.png'],
    ],
  );
  assert.equal(landed.draft, '⟦pimg-0⟧ ⟦pimg-1⟧', 'the sentence is not rewritten by the answer');
  assert.equal(caret, landed.draft.length, 'the caret follows the last token');
});

test('a send while the write is in flight is held back, and says why', async () => {
  held = null;
  calls.length = 0;
  const store = storeWithSession();

  // The wire is what matters here, not the transcript: the transcript keeps the
  // placeholder (that is what the person said), and the runtime must receive the
  // path. A fake sink is the only way to see the second string.
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

  const done = store.getState().pasteImages([{ bytes: png(), mime: 'image/png' }], 0);
  await flush();

  store.getState().submitDraft();

  const held_ = session(store);
  assert.deepEqual(held_.entries, [], 'no message may carry a placeholder instead of a path');
  assert.equal(held_.draft, '⟦pimg-0⟧', 'and the draft is left exactly as the person left it');
  assert.equal(held_.composerNotice?.code, 'paste-pending');
  assert.deepEqual(sent, [], 'nothing went out');

  // Once the write lands the same send goes through, with the path in it.
  held?.resolve([{ path: '.tudouni/paste/a.png', name: 'paste-1.png', mime: 'image/png', bytes: 11 }]);
  await done;
  assert.equal(session(store).composerNotice, null, 'the “still uploading” notice is answered');
  store.getState().submitDraft();

  assert.deepEqual(sent, ['.tudouni/paste/a.png'], 'the sentence on the wire carries the path');
  const after = session(store);
  assert.equal(after.entries[0].text, '⟦pimg-0⟧', 'the transcript keeps what the person wrote');
  assert.equal(after.draft, '');
  assert.deepEqual(after.pastedImages, []);
});

test('a failed write takes its chips back out, with the reason', async () => {
  held = null;
  calls.length = 0;
  const store = storeWithSession();

  const done = store.getState().pasteImages(
    [
      { bytes: png(), mime: 'image/png' },
      { bytes: png(), mime: 'image/png' },
    ],
    0,
  );
  await flush();
  held?.reject('the remote host refused the connection');

  assert.equal(await done, null);

  const after = session(store);
  assert.deepEqual(after.pendingImages, [], 'a chip that will never ship is not left on screen');
  assert.equal(after.draft, '', 'and its token comes out of the sentence');
  assert.equal(after.composerNotice?.code, 'paste-failed');
  assert.equal(
    (after.composerNotice as { reason: string }).reason,
    'the remote host refused the connection',
    'the bridge’s own sentence, verbatim',
  );
});

test('a chip the person removes while it uploads does not come back', async () => {
  held = null;
  calls.length = 0;
  const store = storeWithSession();

  const done = store.getState().pasteImages([{ bytes: png(), mime: 'image/png' }], 0);
  await flush();

  store.getState().forgetImage('⟦pimg-0⟧');
  assert.equal(session(store).draft, '', 'dismissing the chip takes the token out');
  assert.deepEqual(session(store).pendingImages, []);

  // The upload was already in flight and cannot be cancelled — what must not
  // happen is the chip reappearing when it finishes.
  held?.resolve([{ path: '.tudouni/paste/a.png', name: 'paste-1.png', mime: 'image/png', bytes: 11 }]);
  await done;

  const after = session(store);
  assert.deepEqual(after.pendingImages, []);
  assert.deepEqual(after.pastedImages, []);
  assert.equal(after.draft, '');
});

test('a picture pasted into another session’s screen does not follow the person', async () => {
  // The list is per session, and the write is keyed: pasting, then switching,
  // must leave the chip on the session that owns it.
  held = null;
  calls.length = 0;
  const store = storeWithSession();
  store.setState({
    sessions: {
      ...store.getState().sessions,
      '8': { ...createSessionBucket('8', 'C:/other', { ericai: false, maxSteps: null }), ready: true },
    },
    order: [KEY, '8'],
  });

  const done = store.getState().pasteImages([{ bytes: png(), mime: 'image/png' }], 0);
  await flush();
  store.setState({ activeKey: '8' });

  held?.resolve([{ path: '.tudouni/paste/a.png', name: 'paste-1.png', mime: 'image/png', bytes: 11 }]);
  await done;

  assert.equal(store.getState().sessions[KEY].pastedImages.length, 1);
  assert.deepEqual(store.getState().sessions['8'].pastedImages, []);
  assert.equal(store.getState().sessions['8'].draft, '');
});

test('a session with no workspace yet is refused before anything is read', () => {
  // The gate itself is `refuseBeforeRead`'s, covered in `paste.test.ts`; what is
  // asserted here is that the store does not invent a bucket or a chip for a
  // session that is not there.
  const store = createAppStore();
  assert.equal(activeRuntime(store.getState()), null);
  return store.getState().pasteImages([{ bytes: png(), mime: 'image/png' }], 0).then((caret) => {
    assert.equal(caret, null);
  });
});
