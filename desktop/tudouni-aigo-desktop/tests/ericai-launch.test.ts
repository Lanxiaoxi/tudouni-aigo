/**
 * The start-up arguments the settings panel owns have to reach the child's command
 * line — and the record the panel draws has to be the same two facts.
 *
 * The runtime decides both at open, so neither can be sent later as a message:
 * `--ericai` gates every path in `internal/runtime/auth_session.go` (with it, the
 * token is refreshed before the first turn and again before any later request that
 * would otherwise carry a stale one; without it, `initAuth` builds nothing and an
 * expired token is an ordinary fatal 401 **on every turn, forever**), and
 * `--max-steps` is read while the agent is assembled.
 *
 * The desktop keeps two things about them, and they must not disagree:
 *
 *   - `launch`, per session: "the arguments this session's child was **actually
 *     given**" — what the settings panel draws;
 *   - `ericaiDefault` / `maxStepsDefault`, per window: the remembered defaults the
 *     **next** child should be started with.
 *
 * `attachSession` resolves the default for any caller that names nothing, which is
 * every open path except `applyLaunch` and `retrySession` — the launch at app start
 * (`openFirstSession`), a saved session from the rail (`openSession`), a workspace
 * from the sidebar (`enterWorkspace`). Those resolved values were recorded in
 * `launch` but dropped from the bridge payload, so those sessions ran without
 * `--ericai` while the panel reported it as in force. That is the reported symptom:
 * the setting reads as ON, the session works until the token it was opened with
 * expires, and then every message is a 401 with nothing left to repair it.
 *
 * This suite drives the real store and the real `runtime/tauri.ts` against a fake
 * Tauri host, and asserts on the payload the bridge is handed — which is the command
 * line, one layer up from `spawn`'s `command.arg("--ericai")`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeRuntime, useApp } from '@/state/store';
import { attachRuntimeListener, initBridge } from '@/runtime/tauri';

/* ============================================================
   A fake Tauri host that remembers what it was asked to start
   ============================================================ */

const callbacks = new Map<number, (event: unknown) => void>();
let nextCallbackId = 1;
const listeners = new Map<string, Set<number>>();

/** The `options` of every `runtime_attach`, in order. */
const attachArgs: Record<string, unknown>[] = [];

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
        attachArgs.push((args.options ?? {}) as Record<string, unknown>);
        return Promise.resolve(attachArgs.length);
      }
      return Promise.resolve(null);
    },
  },
};

/* ============================================================
   The window as it is the moment after somebody ticks the box
   ============================================================ */

/**
 * A window with the settings remembered and nothing running.
 *
 * `ericaiDefault: true` is the state `applyLaunch` leaves behind — it persists the
 * preference before it restarts, so this is exactly what the next app launch reads
 * back out of `localStorage`.
 */
async function freshWindow(defaults: { ericai: boolean; maxSteps: number | null }) {
  await initBridge(
    () => undefined,
    (problem: string) => assert.fail(`the bridge refused: ${problem}`),
  );
  await attachRuntimeListener();
  attachArgs.length = 0;
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
    ericaiDefault: defaults.ericai,
    maxStepsDefault: defaults.maxSteps,
  });
}

/** The payload of the most recent `runtime_attach`. */
function lastAttach(): Record<string, unknown> {
  assert.ok(attachArgs.length > 0, 'no child was asked for');
  return attachArgs[attachArgs.length - 1];
}

/* ============================================================
   The tests
   ============================================================ */

test('the launch at app start starts the child with --ericai', async () => {
  await freshWindow({ ericai: true, maxSteps: null });

  // Exactly what `openFirstSession` does when the remembered workspace still
  // exists: it names a workspace and nothing else.
  await useApp.getState().attachSession({ workspace: 'C:/work' });

  assert.equal(attachArgs.length, 1, 'one child was asked for');
  assert.equal(
    lastAttach().ericai,
    true,
    'the session the app came up on has to manage its token, or it 401s forever once the token expires',
  );
  // And the record the panel draws says the same thing, which is what makes the
  // panel worth reading.
  const runtime = activeRuntime(useApp.getState());
  assert.equal(runtime?.launch.ericai, true, 'the panel reports what the child was given');
});

test('a saved session opened from the rail starts the child with --ericai', async () => {
  await freshWindow({ ericai: true, maxSteps: null });

  await useApp.getState().openSession('ses_saved', 'C:/work');

  assert.equal(lastAttach().ericai, true, 'opening a conversation from the list keeps the setting');
});

test('a workspace opened from the sidebar starts the child with --ericai', async () => {
  await freshWindow({ ericai: true, maxSteps: null });

  await useApp.getState().enterWorkspace('C:/work');

  assert.equal(lastAttach().ericai, true, 'opening a workspace keeps the setting');
});

test('applying the setting passes it, which is the path that already worked', async () => {
  await freshWindow({ ericai: true, maxSteps: null });

  // A window has to have something on screen for `applyLaunch` to restart — it
  // reads the workspace off the active session.
  await useApp.getState().attachSession({ workspace: 'C:/work' });
  attachArgs.length = 0;

  await useApp.getState().applyLaunch({ ericai: true, maxSteps: null });

  assert.equal(lastAttach().ericai, true);
});

test('a window that never asked for it does not get the flag', async () => {
  // The other direction, and it is not a formality: this is the one flag that lets
  // the runtime rewrite `providers.ericai.api_key` in the person's own
  // configuration file, so a default that leaked into every launch would be a
  // worse bug than the one above.
  //
  // Asserted as "not on" rather than "absent" because the two are the same thing to
  // the bridge — `AttachOptions.ericai` is an `Option<bool>` whose `None` and
  // `Some(false)` both mean "no flag" — and the store now resolves the setting for
  // every caller, so it always has an answer to send.
  await freshWindow({ ericai: false, maxSteps: null });

  await useApp.getState().attachSession({ workspace: 'C:/work' });

  assert.notEqual(lastAttach().ericai, true, 'no setting, no flag');
});

test('the remembered --max-steps reaches the command line too', async () => {
  // The same shape and the same rule: the runtime reads `--max-steps` while it is
  // being assembled, so a value that never reaches the command line is not a limit
  // anybody is under.
  await freshWindow({ ericai: false, maxSteps: 40 });

  await useApp.getState().attachSession({ workspace: 'C:/work' });

  assert.equal(lastAttach().maxSteps, 40, 'the remembered step budget was dropped');
  const runtime = activeRuntime(useApp.getState());
  assert.equal(runtime?.launch.maxSteps, 40, 'and the record agrees with the payload');
});

test('a caller that names a step budget still outranks the remembered one', async () => {
  await freshWindow({ ericai: false, maxSteps: 40 });

  await useApp.getState().attachSession({ workspace: 'C:/work', maxSteps: 7 });

  assert.equal(lastAttach().maxSteps, 7, 'an explicit value is not overwritten by the default');
  assert.equal(activeRuntime(useApp.getState())?.launch.maxSteps, 7);
});
