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
