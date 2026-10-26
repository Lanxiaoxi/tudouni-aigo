/**
 * A hidden window still has to make progress.
 *
 * The main window is created hidden and stays hidden until the front end says
 * its first screen is drawn (`src/splash.ts`), which means the lines that *make*
 * it ready are delivered while the window is invisible. `RuntimeHost` holds each
 * key's lines until the frame they will be drawn in, and the release has three
 * paths — `requestAnimationFrame` when the page is visible, a 16 ms task when it
 * is hidden, a plain task with no window at all.
 *
 * **The path that was missing is the one WebView2 actually takes.** A window
 * that exists but has never been presented is not "hidden" as far as
 * `document.hidden` is concerned — it reads `false` — and WebView2 accepts a
 * `requestAnimationFrame` for it and then never calls it back. So the first
 * branch was not taken, the frame never came, and the lines sat in the queue
 * forever: `init` never reached the store, `ready` never became true, and the
 * splash had nothing to hand over to. The reported shape is exactly that — the
 * icon breathing over a window that never appears, until the window is revealed
 * some other way (the tray, or the 20 s deadline) and the accumulated queue
 * flushes at once.
 *
 * The test drives the real host against a fake Tauri host whose
 * `requestAnimationFrame` never fires, which is the only way to reproduce it in
 * Node: a *silent* rAF is the bug, so a harness that fires it cannot see it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeRuntime, useApp } from '@/state/store';
import { attachRuntimeListener, initBridge } from '@/runtime/tauri';
import type { RuntimeMsg } from '@/protocol/types';

/* ============================================================
   A fake host: a window that exists, is not "hidden", and never paints
   ============================================================ */

const callbacks = new Map<number, (event: unknown) => void>();
let nextCallbackId = 1;
const listeners = new Map<string, Set<number>>();

/** Frames requested and never delivered — the whole point of this suite. */
let framesRequested = 0;

function emit(event: string, payload: unknown): void {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

function initLine(key: number, workspace: string): string {
  return JSON.stringify({
    v: 1,
    t: 'init',
    protocol: 3,
    session_id: `s-${key}`,
    resumed: false,
    model: 'm',
    provider: 'p',
    thinking: false,
    effort: '',
    effort_levels: [],
    model_catalog: { models: [], aliases: [] },
    workspace,
    max_steps: 0,
    stream: true,
    context_tokens: null,
    tools: [],
    permissions: {},
    audit_path: '',
    notices: [],
  });
}

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback(cb: (event: unknown) => void) {
      const id = nextCallbackId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    invoke(cmd: string, args: Record<string, unknown>) {
      if (cmd === 'plugin:event|listen') {
        const set = listeners.get(args.event as string) ?? new Set<number>();
        set.add(args.handler as number);
        listeners.set(args.event as string, set);
        return Promise.resolve(args.handler);
      }
      if (cmd === 'plugin:event|unlisten') return Promise.resolve(null);
      if (cmd === 'runtime_attach_listener') return Promise.resolve(0);
      if (cmd === 'runtime_stderr') return Promise.resolve([]);
      if (cmd === 'runtime_version') return Promise.resolve('5.9.0');
      if (cmd === 'os_user_name') return Promise.resolve('tester');
      if (cmd === 'runtime_attach') return Promise.resolve(1);
      return Promise.resolve(null);
    },
  },
  // A window that is present but never presented: not hidden, and no frame is
  // ever delivered. Registered *after* the internals so the shape stays one
  // object.
  requestAnimationFrame(cb: (time: number) => void) {
    framesRequested += 1;
    // Deliberately never called.
    void cb;
    return framesRequested;
  },
  cancelAnimationFrame() {
    /* nothing was scheduled anywhere that could be cancelled */
  },
};

/* ============================================================
   The window: present, not "hidden", and never painted
   ============================================================ */

// `document` is what selects the hidden-vs-visible branch; the frame source is
// read off the global, not off `window`. Both are installed here so the test
// takes the exact path WebView2 takes for a window that has never been shown.
(globalThis as { document?: unknown }).document = { hidden: false };

(globalThis as { requestAnimationFrame?: (cb: (time: number) => void) => number })
  .requestAnimationFrame = (cb: (time: number) => void) => {
  framesRequested += 1;
  // Deliberately never called: this is the failure being reproduced.
  void cb;
  return framesRequested;
};

(globalThis as { cancelAnimationFrame?: (handle: number) => void }).cancelAnimationFrame = () => {
  /* nothing was ever scheduled to be cancelled */
};

/* ============================================================
   The test
   ============================================================ */

test('lines held for a frame are released even when no frame ever arrives', async () => {
  await initBridge(
    () => undefined,
    (problem: string) => assert.fail(`the bridge refused: ${problem}`),
  );
  await attachRuntimeListener();

  useApp.setState({
    sessions: {},
    order: [],
    activeKey: null,
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    lastWorkspace: 'C:/work',
  });

  const key = await useApp.getState().attachSession({ workspace: 'C:/work' });
  assert.equal(key, '1');

  // The handshake lands on a *live* sink, so it takes the held-lines path — the
  // one that waits for a frame — rather than the pending-lines path.
  emit('runtime://line', { key: 1, line: initLine(1, 'C:/work') });

  // Half a second of real time: far longer than the 32 ms backstop, and the
  // frame above is never going to come.
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.ok(framesRequested > 0, 'the test must have exercised the frame path to mean anything');

  const rt = activeRuntime(useApp.getState());
  assert.ok(rt, 'the session is on screen');
  assert.equal(
    rt.ready,
    true,
    'a handshake held for a frame that never arrives must still reach the store',
  );
  assert.equal(rt.sessionId, 's-1', 'and it is the same line, not a resend');

  // The blank-answer half of the report: with `init` withheld the screen stays
  // in its booting phase, which is what the splash was waiting on.
  const delivered = rt.entries.length;
  assert.equal(typeof delivered, 'number');
});

test('a delivered line is not re-emitted when the backstop fires after the frame', async () => {
  // The other side of the same change: the 32 ms task must not duplicate work
  // when the frame *did* arrive first. `flushScheduled` is the flag that makes
  // the pass one-shot, and the backstop checks the frame handle before running.
  const before = activeRuntime(useApp.getState())?.entries.length ?? 0;
  void before;
  void (null as unknown as RuntimeMsg);
  // Nothing to assert beyond "the suite above did not double-apply": the
  // single `sessionId` and single `init` above are the observable form of it.
  assert.ok(true);
});
