/**
 * A session's opening handshake must survive the race it exists to defeat.
 *
 * The bridge forwards a child's lines as soon as it has read them, and
 * `runtime_attach` mints the key and returns it — so a line can reach the WebView
 * **before** the store has built either the handle or the bucket for that key.
 * Three layers hold such a line (`RuntimeHost.pendingLines`, the handle's own
 * `queue`, and `subscribe` is what flushes the second), and the whole point of
 * that machinery is the opening `init` -> `session_load` -> `ui(state)` triple.
 *
 * `attachSession` subscribed **before** installing the bucket, so the flush ran
 * `applyRuntimeMessage` for a key that did not exist yet — and that function
 * drops such a message, correctly, because from a key alone "this session is
 * gone" and "this session has not been installed yet" are the same statement.
 * The triple was therefore thrown away by the very code that queued it.
 *
 * What makes it quiet rather than loud, and what this test pins:
 *
 *   - the child is healthy, and every **later** reply lands — `session_list` is
 *     sent after the bucket exists, so the rail fills with saved conversations;
 *   - with `init` gone there is no `session_id`, so the rail cannot mark the row
 *     current and the session bar shows "Session —";
 *   - with `ui(state)` gone the right rail has no snapshot and says "loading…";
 *   - `ready` never becomes true, so the screen shows "Starting the runtime…"
 *     over a process that is running and answering. Nothing reports a failure,
 *     because nothing failed.
 *
 * That is the reported symptom exactly: a **new** session opened while another
 * was running, which loading and never coming up.
 *
 * The test drives the real `runtime/tauri.ts` and the real store against a fake
 * Tauri host, and it is the *ordering* that is under test — so the same payloads
 * are delivered twice, once after the handle exists (which always worked) and
 * once before it (which did not).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeRuntime, useApp } from '@/state/store';
import { attachRuntimeListener, initBridge } from '@/runtime/tauri';
import type { RuntimeMsg } from '@/protocol/types';

/* ============================================================
   A fake Tauri host: enough of `__TAURI_INTERNALS__` for the real modules
   ============================================================ */

/** Callbacks handed to the WebView by `transformCallback`, by id. */
const callbacks = new Map<number, (event: unknown) => void>();
let nextCallbackId = 1;
/** Which callback ids are listening to which event name. */
const listeners = new Map<string, Set<number>>();
/** Invoked with the minted key whenever `runtime_attach` is called. */
let onAttach: ((key: number) => void) | null = null;
let attachCount = 0;

/** Deliver one bridge event, the way `app.emit` does. */
function emit(event: string, payload: unknown): void {
  for (const id of listeners.get(event) ?? []) {
    callbacks.get(id)?.({ event, id, payload });
  }
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
      if (cmd === 'runtime_attach') {
        const key = ++attachCount;
        // The child can answer before the caller has finished building the
        // handle to receive it — which is precisely the race.
        onAttach?.(key);
        return Promise.resolve(key);
      }
      return Promise.resolve(null);
    },
  },
};

/* ============================================================
   The opening triple, as the real runtime sends it
   ============================================================ */

function openingTriple(key: number, workspace: string): { key: number; line: string }[] {
  return [
    {
      key,
      line: JSON.stringify({
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
      }),
    },
    { key, line: JSON.stringify({ v: 1, t: 'session_load', messages: [] }) },
    {
      key,
      line: JSON.stringify({
        v: 1,
        t: 'ui',
        kind: 'state',
        todos: [],
        skills: [],
        jobs: [],
        subagents: [],
        mcp: [],
        risk_scope: [],
        goal: {},
      }),
    },
  ];
}

function deliver(events: { key: number; line: string }[]): void {
  for (const { key, line } of events) emit('runtime://line', { key, line });
}

/* ============================================================
   The tests
   ============================================================ */

test('a handshake that arrives before the handle exists still lands', async () => {
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

  // ---- the ordinary order: the child answers after the caller has returned ----
  onAttach = null;
  const first = await useApp.getState().attachSession({ workspace: 'C:/work' });
  assert.equal(first, '1');
  deliver(openingTriple(1, 'C:/work'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(activeRuntime(useApp.getState())?.ready, true, 'the first session is up');

  // ---- the race: the child is already on the wire when `runtime_attach` returns ----
  onAttach = (key) => deliver(openingTriple(key, 'C:/work'));
  const second = await useApp.getState().attachSession({ workspace: 'C:/work' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const rt = activeRuntime(useApp.getState());
  assert.ok(rt, 'the session that was asked for is the one on screen');
  assert.equal(second, '2');

  // **The assertion this test exists for.** `ready` stays false for the rest of
  // the session's life when `init` is dropped, and the screen never leaves
  // "Starting the runtime…".
  assert.equal(rt.ready, true, 'a handshake delivered before the handle existed still lands');

  // The rest is what the boot loop's absence looks like from a component: no id,
  // so the rail cannot mark the row current; no snapshot, so the right rail has
  // nothing to draw.
  assert.equal(rt.sessionId, 's-2', 'init landed, so the session has its runtime id');
  assert.equal(rt.session?.workspace, 'C:/work');
  assert.ok(rt.uiState, 'ui(state) landed, so the right rail is not stuck loading');
  assert.equal(rt.problem, null, 'nothing failed, and that is what made this quiet');
});

test('a line for a session that is gone is still dropped, not resurrected', async () => {
  // The other half of the rule the fix relies on: installing the bucket earlier
  // must not turn `applyRuntimeMessage` into something that invents one. A stale
  // key is never reused, so a line for it has to stay on the floor —
  // `attachSession` drops the bucket on detach and the host drops its queue.
  await initBridge(
    () => undefined,
    () => undefined,
  );
  await attachRuntimeListener();

  const before = Object.keys(useApp.getState().sessions).length;
  deliver(openingTriple(999, 'C:/gone'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    Object.keys(useApp.getState().sessions).length,
    before,
    'a message must not create a bucket for a key nothing owns',
  );
});

test('every RuntimeMsg the bridge forwards is one the decoder accepts', async () => {
  // A guard on the fake host above: if the opening triple drifts from what the
  // decoder expects, the two tests above would pass by feeding the store
  // messages the real bridge would have dropped — and the test would be
  // measuring the fixture rather than the ordering.
  const { decodeLine } = await import('@/protocol/types');
  for (const { key, line } of openingTriple(1, 'C:/work')) {
    const decoded = decodeLine(line);
    assert.notEqual(decoded.msg, null, `line for key ${key} must decode`);
    assert.equal(decoded.fatal, undefined);
    assert.ok((decoded.msg as RuntimeMsg).t, 'and carry a type');
  }
});
