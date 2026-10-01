/**
 * Which workspace a launch opens, and what happens when there is not one.
 *
 * This is a regression suite for one specific bug: a launch that came up in a
 * directory **nobody chose**, silently. The chain was:
 *
 *   `attachSession({})` computed no workspace, left the field out of the IPC
 *   call, and the bridge read "absent" as `std::env::current_dir()` — the
 *   application's own working directory, which for a packaged app is its install
 *   folder. Nothing failed loudly, because a session id with no file in that
 *   directory is read by the runtime as *a new session with that name*. So the
 *   screen simply moved somewhere else.
 *
 * Two things are asserted here, and they are the two halves of the fix:
 *
 *   1. **The precedence, and its floor.** Caller, then the active session, then
 *      the remembered one — and then *nothing*, which callers must treat as "do
 *      not start a child" rather than as a value to pass on. The floor is the
 *      half that used to be a fallback, and a fallback here is always wrong.
 *   2. **What gets remembered.** `init.workspace` — the runtime's own answer —
 *      and the workspace of the session on screen. Never a path this front end
 *      assembled, and never a background session's.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeRuntime,
  createSessionBucket,
  resolveAttachWorkspace,
  useApp,
  type AppStore,
  type SessionRuntime,
} from '@/state/store';

/* ============================================================
   The precedence, as a pure function
   ============================================================ */

test('the workspace is the caller\'s when a caller named one', () => {
  // Pressing a workspace row, or `/resume` on a session in another directory.
  // The most direct statement a person can make, so it wins outright.
  assert.equal(resolveAttachWorkspace('C:/picked', 'C:/active', 'C:/remembered'), 'C:/picked');
});

test('otherwise it is the active session\'s own answer', () => {
  // "New conversation" almost always means "here", and the runtime's
  // `init.workspace` is the only thing entitled to say where here is.
  assert.equal(resolveAttachWorkspace(undefined, 'C:/active', 'C:/remembered'), 'C:/active');
});

test('otherwise it is the remembered one', () => {
  assert.equal(resolveAttachWorkspace(undefined, undefined, 'C:/remembered'), 'C:/remembered');
});

test('with nothing named anywhere there is no workspace — never the cwd', () => {
  // The assertion this whole suite exists for. An empty return is the signal to
  // *not start a child*; the tempting alternative — letting it through so the
  // bridge picks something — is the bug, because the bridge's choice is the
  // application's own install directory.
  assert.equal(resolveAttachWorkspace(undefined, undefined, null), '');
});

test('a blank string is "not named", not a directory', () => {
  // The store leaves an empty workspace *out* of the IPC call rather than
  // sending it, because the two mean different things to the bridge: absent is
  // the cwd fallback, while `Some("")` is refused as "not a directory". Either
  // way it is not an answer, so it must not outrank a real one — including a
  // whitespace-only path, which is not a directory on any platform.
  assert.equal(resolveAttachWorkspace('', 'C:/active', 'C:/remembered'), 'C:/active');
  assert.equal(resolveAttachWorkspace(undefined, '', 'C:/remembered'), 'C:/remembered');
  assert.equal(resolveAttachWorkspace('   ', undefined, undefined), '');
});

/* ============================================================
   What gets remembered
   ============================================================ */

/** A store with the given sessions and nothing else carried over. */
function install(
  sessions: Record<string, SessionRuntime>,
  order: string[],
  activeKey: string | null,
  overrides: Partial<AppStore> = {},
): void {
  useApp.setState({
    sessions,
    order,
    activeKey,
    modal: null,
    pendingModals: [],
    panel: null,
    startupProblem: null,
    startupNotice: null,
    lastWorkspace: null,
    ...overrides,
  });
}

/** Minimal `init`, with only the fields this suite is about. */
function initMessage(workspace: string): Record<string, unknown> {
  return {
    v: 1,
    t: 'init',
    protocol: 3,
    session_id: 's-1',
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
  };
}

test('rememberWorkspace keeps the latest, and ignores an empty path', () => {
  install({}, [], null);

  useApp.getState().rememberWorkspace('C:/work');
  assert.equal(useApp.getState().lastWorkspace, 'C:/work');

  useApp.getState().rememberWorkspace('C:/other');
  assert.equal(useApp.getState().lastWorkspace, 'C:/other');

  // An empty string is a caller passing through a value it did not have, not a
  // statement that the remembered workspace should be forgotten. Honouring it
  // would wipe the default on any attach that had no workspace to report — and
  // a default that can be wiped by accident is not a default.
  useApp.getState().rememberWorkspace('');
  assert.equal(useApp.getState().lastWorkspace, 'C:/other');
});

test('the session on screen is the one remembered, not the one just opened', () => {
  // Two sessions in two workspaces. `init` lands for the one being watched, so
  // that is where the next launch goes.
  const a = createSessionBucket('k-a', 'C:/a', { ericai: false, maxSteps: null });
  const b = createSessionBucket('k-b', 'C:/b', { ericai: false, maxSteps: null });
  install({ 'k-a': a, 'k-b': b }, ['k-a', 'k-b'], 'k-a');

  useApp.getState().applyRuntimeMessage('k-a', initMessage('C:/a') as never);
  assert.equal(useApp.getState().lastWorkspace, 'C:/a');

  useApp.getState().applyRuntimeMessage('k-b', initMessage('C:/b') as never);
  assert.equal(
    useApp.getState().lastWorkspace,
    'C:/a',
    'a background session must not move the workspace out from under the person',
  );

  // Focusing it is a deliberate statement that this is where work is happening,
  // and that is exactly how somebody changes which workspace comes back.
  useApp.getState().focusSession('k-b');
  assert.equal(useApp.getState().lastWorkspace, 'C:/b');
});

test('a session with no workspace yet is not remembered', () => {
  // `init` has not landed, so the bucket's workspace is still the one the caller
  // named — here, nothing. Recording that would overwrite a good default with a
  // blank, which is the failure this helper exists to prevent.
  install({}, [], null, { lastWorkspace: 'C:/keep' });
  const fresh = createSessionBucket('k-x', '', { ericai: false, maxSteps: null });
  install({ 'k-x': fresh }, ['k-x'], 'k-x', { lastWorkspace: 'C:/keep' });

  useApp.getState().focusSession('k-x');
  assert.equal(useApp.getState().lastWorkspace, 'C:/keep');
});

/* ============================================================
   Nothing to go on
   ============================================================ */

test('with no workspace to go on, no child is started and the reason is said', async () => {
  // No active session and nothing remembered — a first launch. This used to be
  // where the bridge was handed nothing and invented the install directory.
  install({}, [], null);

  const key = await useApp.getState().attachSession({});

  assert.equal(key, null, 'no child may be started without a workspace');
  assert.equal(useApp.getState().order.length, 0, 'and no session may be recorded');
  // Silent failure is the failure mode this change exists to remove: `/new` and
  // the rail's button both land here, so it has to be said somewhere.
  assert.deepEqual(useApp.getState().startupNotice, { code: 'no-workspace' });
});

test('a session\'s own workspace outranks having nothing, so the refusal is not over-eager', async () => {
  // The refusal above must be about *having no workspace*, not about the call
  // shape. With a session open, `attachSession({})` has somewhere to go — it
  // simply cannot get there without a bridge, which returns no key.
  const a = createSessionBucket('k-a', 'C:/a', { ericai: false, maxSteps: null });
  install({ 'k-a': a }, ['k-a'], 'k-a');

  const before = useApp.getState().lastWorkspace;
  const key = await useApp.getState().attachSession({});

  // Null because there is no bridge in a plain Node process — not because the
  // workspace was missing, which is why the notice must be absent.
  assert.equal(key, null);
  assert.equal(useApp.getState().startupNotice, null);
  assert.equal(useApp.getState().lastWorkspace, before);
});

/* ============================================================
   A child that would not start
   ============================================================ */

/**
 * Run `body` against a fake Tauri host whose `runtime_attach` **fails**.
 *
 * The refusal this simulates is the Rust side's own: a workspace the runtime
 * will not take, a binary that is present but will not execute. It is a rejected
 * promise rather than an exit code, because that is what the bridge does — every
 * failure it can describe is returned as a sentence.
 *
 * `isHosted()` is what makes `attachRuntime` a real call rather than an
 * immediate null, so the host exists only for the length of the test.
 */
async function withFailingAttach<T>(reason: string, body: () => Promise<T>): Promise<T> {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke(cmd: string) {
        if (cmd === 'runtime_attach') return Promise.reject(reason);
        if (cmd === 'runtime_stderr') return Promise.resolve([]);
        return Promise.resolve(null);
      },
    },
  };
  try {
    return await body();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test('a child that would not start is recorded on its own session, with the reason', async () => {
  // **This is the regression the "nothing happened" report was about.** The
  // store always wrote `SessionRuntime.problem` here; nothing read it. So the
  // failure produced no sentence anywhere, and because a session whose child
  // failed never becomes `ready`, the screen sat on "Starting the runtime…"
  // over a process that had already given up. Both halves are asserted: the
  // reason is recorded where a component can find it, and it is recorded on the
  // *session* rather than on the window.
  install({}, [], null, { lastWorkspace: 'C:/work' });

  const reason = 'the workspace C:/work cannot be used (it is the home directory)';
  await withFailingAttach(reason, async () => {
    const key = await useApp.getState().attachSession({});
    assert.equal(key, null, 'a failed attach hands back no key');
  });

  const s = useApp.getState();
  const bucket = s.sessions[s.activeKey ?? ''];
  assert.ok(bucket, 'the session that failed is recorded, or the reason has nowhere to live');
  assert.equal(bucket.problem, reason, 'the bridge\'s own sentence, verbatim');
  assert.equal(bucket.workspace, 'C:/work', 'and it names the directory that was refused');
  // `ready` stays false — which is *why* the render order in `App` matters:
  // testing `!ready` before `problem` would print the booting sentence over a
  // child that is not booting.
  assert.equal(bucket.ready, false);
  // **Not a window-level problem.** Another conversation may be running happily
  // beside this one, and a panel that covers the window would hide it.
  assert.equal(s.startupProblem, null);
});

/* ============================================================
   A key that names no child must never mean "all of them"
   ============================================================ */

/**
 * Every `runtime_shutdown` / `runtime_kill` the front end makes, against a fake
 * host, with the payload as the Rust side receives it.
 *
 * The payload matters because of what `null` means there: both commands take
 * `Option<ChildKey>`, and `None` is documented as **every session**. JSON has no
 * NaN, so `JSON.stringify({ key: Number('failed-abc') })` is `{"key":null}` —
 * which is why `Number(key)` on a key the bridge never minted silently escalates
 * a per-session act into a window-wide one.
 */
async function withRecordingHost<T>(
  body: () => Promise<T>,
): Promise<{ result: T; calls: { cmd: string; key: unknown }[] }> {
  const calls: { cmd: string; key: unknown }[] = [];
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke(cmd: string, args: Record<string, unknown>) {
        if (cmd === 'runtime_shutdown' || cmd === 'runtime_kill') {
          // The wire form, not the JS value: `undefined` disappears from the
          // object entirely, which is a third thing again.
          calls.push({ cmd, key: args?.key === undefined ? '<absent>' : args.key });
        }
        return Promise.resolve(null);
      },
    },
  };
  try {
    const result = await body();
    return { result, calls };
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test('a session that never started does not shut down every other one', async () => {
  // **The regression this pins.** `attachSession` names the bucket for a child
  // that refused to start `failed-<stamp>`. That bucket's "Try again" button
  // calls `retrySession`, which detaches it first — and `Number('failed-…')` is
  // `NaN`, which reaches the bridge as `null`, which means **every session**. So
  // one click on a failed session would have ended every conversation the person
  // had open. Reachable the moment `SessionProblem` started rendering that
  // button, which is this same change.
  const { shutdownRuntime, killRuntime } = await import('@/runtime/tauri');

  const { calls } = await withRecordingHost(async () => {
    await shutdownRuntime('failed-muoy2dpe');
    await killRuntime('failed-muoy2dpe');
  });

  assert.deepEqual(
    calls,
    [],
    'a key the bridge never minted names no child, so nothing may be sent',
  );
});

test('an absent key still means every session, and a real key stays per-session', async () => {
  // The other half: the guard must not break the two acts that are legitimate.
  // Closing the window asks for all of them, and that path is `undefined`.
  const { shutdownRuntime } = await import('@/runtime/tauri');

  const { calls } = await withRecordingHost(async () => {
    await shutdownRuntime();
    await shutdownRuntime('7');
  });

  assert.deepEqual(calls, [
    { cmd: 'runtime_shutdown', key: null },
    { cmd: 'runtime_shutdown', key: 7 },
  ]);
});
