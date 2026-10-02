/**
 * The left rail's two groups, and what makes its actions inert.
 *
 * This is the regression suite for one report: **"I press 'New session' and
 * nothing happens."** Two independent faults produced it, and both are pure
 * functions, so both can be asserted without a window or a child process.
 *
 *   1. **A new session appeared in no list at all.** The rail draws
 *      `sessions.items`, which the runtime builds by reading session *files* —
 *      and a conversation that has not run a turn has no file. Measured on the
 *      release build, pressing the button from the first screen left the
 *      transcript, the four recent-session slots and every rail row
 *      byte-identical; only the session bar's id moved. `selectLiveOnlyKey` is
 *      what puts those conversations in the rail, so "did anything happen" has an
 *      answer on screen.
 *
 *   2. **With a panel open, the rail's buttons were dead while looking alive.**
 *      Every panel is a Radix dialog, and Radix sets `pointer-events: none` on
 *      `body` while one is open — inherited, so the rail inherits it and the
 *      browser stops delivering clicks. The rail tested `modal` alone, so the
 *      button drew normally, showed hover styling and swallowed every press.
 *      Measured with real CDP mouse events: `elementFromPoint` lands on
 *      `.overlay-mask` and **zero** IPC calls go out. `railBlocked` is what makes
 *      the rail *say* it is inert.
 *
 * Both are asserted as pairs, because each one alone would pass on the broken
 * code: the first test in each pair is the state that used to be wrong, and the
 * second is the state that must not regress while fixing it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSessionBucket,
  railBlocked,
  selectLiveOnlyKey,
  useApp,
  type AppStore,
  type SessionRuntime,
} from '@/state/store';

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

/** A bucket that has just been started: no id yet, nothing said, no file. */
function fresh(key: string, workspace: string): SessionRuntime {
  return createSessionBucket(key, workspace, { ericai: false, maxSteps: null });
}

/** The same bucket once `init` has landed, so it has the runtime's own id. */
function handshaken(key: string, workspace: string, sessionId: string): SessionRuntime {
  const bucket = fresh(key, workspace);
  bucket.ready = true;
  bucket.sessionId = sessionId;
  bucket.session = { id: sessionId, workspace } as SessionRuntime['session'];
  return bucket;
}

/** Parse the compact string the rail reads into rows, for readable assertions. */
function parse(compact: string): { key: string; id: string; status: string }[] {
  if (compact === '') return [];
  return compact.split('\u0001').map((part) => {
    const [key, id, status] = part.split('\u0000');
    return { key, id, status };
  });
}

/* ============================================================
   Group 1: open but not on disk
   ============================================================ */

test('a session with no file yet is listed, which is the whole bug', () => {
  // **This is the reported symptom.** A conversation that has been opened and has
  // not run a turn is in no `sessions.items`, so before this it was in no list at
  // all — and pressing "New session" produced a screen identical to the one
  // before it. Four children in sixteen seconds on the machine this was found on
  // is what "a press with no visible result" looks like from the outside.
  const bucket = handshaken('k1', 'C:/work', '20260101-120000');
  // The saved list is empty: nothing has ever been written in this workspace.
  install({ k1: bucket }, ['k1'], 'k1');

  const rows = parse(selectLiveOnlyKey(useApp.getState(), 'C:/work'));

  assert.deepEqual(rows, [{ key: 'k1', id: '20260101-120000', status: 'idle' }]);
});

test('a session the saved list already holds is not drawn twice', () => {
  // The other half, and the half that would regress silently: the runtime's list
  // is the authority on what is *saved*, and a conversation that is both open and
  // saved belongs to that list — its row carries the message count, the step
  // count and the preview, none of which this end knows. Drawing it in both
  // groups would be one conversation shown as two.
  const bucket = handshaken('k1', 'C:/work', '20260101-120000');
  bucket.sessionList = [
    { id: '20260101-120000', messages: 4, steps: 2, todos: '', preview: 'hi', modifiedAt: 1 },
  ];
  bucket.listedSessions = true;
  install({ k1: bucket }, ['k1'], 'k1');

  assert.equal(selectLiveOnlyKey(useApp.getState(), 'C:/work'), '');
});

test('before init lands there is no id yet, and the row still exists', () => {
  // The moment between pressing the button and the handshake. There is no id to
  // name it with — the runtime mints one — and that is a real state rather than a
  // reason to hide the row: the child is running and the conversation is open.
  // The rail renders its own label for this, which is why the id is allowed to be
  // empty in the string rather than being dropped.
  const bucket = fresh('k1', 'C:/work');
  install({ k1: bucket }, ['k1'], 'k1');

  const rows = parse(selectLiveOnlyKey(useApp.getState(), 'C:/work'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'k1');
  assert.equal(rows[0].id, '', 'no id is not an id of ""');
});

test('a session in another workspace is not in this workspace\'s list', () => {
  // The saved list is scoped to the workspace on screen, so this group has to be
  // too — otherwise switching workspaces would leave the other one's
  // conversations sitting in a list that claims to describe this one.
  install(
    { k1: fresh('k1', 'C:/work'), k2: fresh('k2', 'C:/other') },
    ['k1', 'k2'],
    'k1',
  );

  const rows = parse(selectLiveOnlyKey(useApp.getState(), 'C:/work'));
  assert.deepEqual(rows.map((r) => r.key), ['k1']);
});

test('the rows follow the rail\'s own order, so nothing moves under the cursor', () => {
  // Order is `s.order` — the order sessions were opened. The design is explicit
  // that this list does not sort by status: a row that jumps while somebody is
  // aiming at it is worse than one that needs looking at twice.
  install(
    { k1: fresh('k1', 'C:/work'), k2: fresh('k2', 'C:/work'), k3: fresh('k3', 'C:/work') },
    ['k3', 'k1', 'k2'],
    'k1',
  );

  const rows = parse(selectLiveOnlyKey(useApp.getState(), 'C:/work'));
  assert.deepEqual(rows.map((r) => r.key), ['k3', 'k1', 'k2']);
});

test('the status travels with the row, so the dot still has something to say', () => {
  // A background conversation that finished is exactly the case the blue dot
  // exists for, and it is most likely to be one of these rows — a session that
  // has run a turn but whose file has not reached the list yet.
  const bucket = handshaken('k1', 'C:/work', '20260101-120000');
  bucket.unseen = true;
  install({ k1: bucket }, ['k1'], 'k2');

  const rows = parse(selectLiveOnlyKey(useApp.getState(), 'C:/work'));
  assert.equal(rows[0].status, 'unseen');
});

test('nothing open is an empty string, not a row for nobody', () => {
  install({}, [], null);
  assert.equal(selectLiveOnlyKey(useApp.getState(), 'C:/work'), '');
});

/* ============================================================
   Group 2: what makes the rail inert
   ============================================================ */

test('a panel makes the rail inert, and that is the second half of the bug', () => {
  // **The assertion that would have caught it.** Radix puts
  // `pointer-events: none` on `body` for any open dialog, panel included — so the
  // rail's buttons are unclickable whenever a panel is up, whatever the store
  // says about modals. Testing `modal` alone left every control in the rail
  // looking available and behaving dead, which is the report exactly.
  install({}, [], null, { panel: 'files' });
  assert.equal(railBlocked(useApp.getState()), true);
});

test('a blocking modal still makes it inert', () => {
  // The reason the check existed in the first place, and it must keep working:
  // switching a session under an approval abandons the request the runtime is
  // waiting on, and it waits for ever.
  install({}, [], null, {
    modal: {
      kind: 'permission',
      key: 'k1',
      req: {
        id: 'p1',
        tool: 'shell',
        risk: 'high',
        arguments: {},
        remember: null,
        remember_hint: null,
        allow_trust_all: false,
        trust_all_hint: null,
      },
    } as AppStore['modal'],
  });
  assert.equal(railBlocked(useApp.getState()), true);
});

test('with nothing open the rail is live', () => {
  // The other half of the pair: a check that answered `true` unconditionally
  // would pass both assertions above and disable the rail for ever.
  install({}, [], null);
  assert.equal(railBlocked(useApp.getState()), false);
});
