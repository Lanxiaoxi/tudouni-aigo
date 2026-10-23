/**
 * The left rail's groups, what makes its actions inert, and what a launch leaves
 * behind.
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
 * Group 3 belongs to the same group of facts and was reported next: the session a
 * **launch** opens, left behind when the person opens a past conversation
 * instead. Listing it was right for the second it was the screen; keeping it for
 * the life of the window was not, and neither was the alternative of simply not
 * drawing it — a session with no file has no delete button, so a live child drawn
 * nowhere is a process nobody can reach or end. `isUntouchedSession` is the rule
 * that separates it from a conversation, and `abandonIfUntouched` closes it.
 *
 * All three are asserted as pairs, because each one alone would pass on the
 * broken code: the first test in each pair is the state that used to be wrong,
 * and the second is the state that must not regress while fixing it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSessionBucket,
  railBlocked,
  selectBoardAvailable,
  selectLiveOnlyKey,
  selectLiveSessionIds,
  selectModalVisible,
  selectRowStatus,
  selectSavedSessions,
  useApp,
  type AppStore,
  type SessionRuntime,
} from '@/state/store';
import { registerRuntime } from '@/runtime/bus';
import { reduceEvent, type Entry } from '@/state/entries';
import { savedSessionsKey } from '@/state/savedSessionsKey';
import type { FrontendMsg } from '@/protocol/types';

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
    // The saved session list is **window-level** now, keyed by workspace, so a
    // test that wants one has to file it under the workspace it describes —
    // `savedFor` below. An empty record is the state a fresh window is in.
    savedSessions: {},
    modal: null,
    pendingModals: [],
    panel: null,
    // The two window facts the archive work added, reset here so one test cannot
    // hand a borrowed filter or an open board to the next — neither is persisted,
    // so a fresh window is exactly this.
    boardOpen: false,
    sessionFilter: 'active',
    startupProblem: null,
    startupNotice: null,
    lastWorkspace: null,
    ...overrides,
  });
}

/** Capture what the store sends to `k1`, the shape `captureOutbound` has in the
 *  projection suite: a handle per key, because the real bridge addresses one. */
function captureSent(): FrontendMsg[] {
  const sent: FrontendMsg[] = [];
  registerRuntime({
    key: 'k1',
    send(msg) {
      sent.push(msg);
    },
    subscribe() {
      return () => undefined;
    },
    dispose() {
      return undefined;
    },
  });
  return sent;
}

/**
 * File a saved-session list under one workspace, the way the `sessions` reply
 * does.
 *
 * Written through the **store action path** rather than by hand-building the
 * record: the key is `normPath(workspace)` and the lookup is too, so a test that
 * spelled the key itself would be asserting its own arithmetic instead of the
 * store's. The runtime's own `session_list` answer goes through
 * `noteSavedSessions`, and this is that call with the same arguments.
 */
function savedFor(
  workspace: string,
  items: { id: string; messages?: number; steps?: number; preview?: string; archived?: boolean }[],
  remoteWorkspaceId: string | null = null,
): void {
  const rows = items.map((row) => ({
    id: row.id,
    messages: row.messages ?? 0,
    steps: row.steps ?? 0,
    todos: '',
    preview: row.preview ?? '',
    modifiedAt: 1,
    archived: row.archived ?? false,
  }));
  useApp.setState((s) => ({
    savedSessions: {
      ...s.savedSessions,
      [savedSessionsKey(workspace, remoteWorkspaceId)]: {
        workspace,
        remoteWorkspaceId,
        items: rows,
        // The same derivation the store does on write — `SavedSessions.active`.
        // A hand-built record that omitted this would make every `.active`
        // reader crash on `undefined`, which is exactly the kind of gap that
        // hides until a component finally reads the field.
        active: rows.filter((row) => !row.archived),
        listed: true,
      },
    },
  }));
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
  // `resumed: false` is what the runtime says about a session it minted itself,
  // and `isUntouchedSession` reads it: an id with a file behind it is a
  // conversation the person picked, whatever its transcript happens to hold.
  bucket.session = { id: sessionId, workspace, resumed: false } as SessionRuntime['session'];
  return bucket;
}

/** The same, for a conversation loaded from its file. */
function resumed(key: string, workspace: string, sessionId: string): SessionRuntime {
  const bucket = handshaken(key, workspace, sessionId);
  bucket.session = { id: sessionId, workspace, resumed: true } as SessionRuntime['session'];
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
  //
  // The list is filed under the **workspace**, not under the child: that is the
  // change this suite was extended for. A row in the wrong group was one of the
  // two visible symptoms, and it was caused by the same per-child copy.
  install({ k1: handshaken('k1', 'C:/work', '20260101-120000') }, ['k1'], 'k1');
  savedFor('C:/work', [{ id: '20260101-120000', messages: 4, steps: 2, preview: 'hi' }]);

  assert.equal(selectLiveOnlyKey(useApp.getState(), 'C:/work'), '');
});

test('a remote conversation the saved list holds is not drawn twice either', () => {
  // **The reported shape.** A remote workspace's rail showed every open
  // conversation twice: once as "open now / Nothing has run in it yet" and once
  // with its preview. The sidebar scopes the live group by `currentWorkspace`,
  // which is **blanked** for a remote session — a remote path must not enter the
  // *local* workspace rows below, which is what that value also feeds. Under the
  // blank every guard in `selectLiveOnlyKey` switched off: the saved set read
  // back empty and the workspace filter never applied, so the dedup that works
  // locally never ran remotely.
  //
  // The same-path guards in `selectLiveOnlyKey` are string comparisons; a remote
  // path is as safe to compare as a local one. The fix scopes the group by the
  // session's own workspace — which this asserts by calling the selector the way
  // the fixed sidebar does. A `resumed` bucket, so the conversation is one with
  // a file behind it, and `remoteWorkspaceId` set, since that is what made the
  // sidebar blank the value.
  const bucket = resumed('k1', '/home/deploy/repo', '20261015-180810');
  bucket.remoteWorkspaceId = 'rw-1';
  install({ k1: bucket }, ['k1'], 'k1');
  // The saved list carries the **same machine** as the bucket: a list filed
  // under `rw-1` is what the remote row's own `session_list` answer writes, and
  // a test that filed it as a local path would be asserting a state the app
  // cannot produce.
  savedFor(
    '/home/deploy/repo',
    [{ id: '20261015-180810', messages: 80, steps: 38, preview: 'hi 你有些什么技能和工具' }],
    'rw-1',
  );

  const rows = parse(selectLiveOnlyKey(useApp.getState(), '/home/deploy/repo', 'rw-1'));
  assert.deepEqual(rows, [], 'the saved row is the only one drawn for this conversation');
});

test('a remote conversation with no file yet is still listed', () => {
  // The pair, so the fix does not over-correct. The live group exists because a
  // conversation that has not run a turn has no file — and that is as true on a
  // remote host as here. A remote path reaching this selector is a string being
  // compared, not a directory being touched, so the remote row must survive.
  const bucket = handshaken('k1', '/home/deploy/repo', '20261015-190009');
  bucket.remoteWorkspaceId = 'rw-1';
  install({ k1: bucket }, ['k1'], 'k1');

  const rows = parse(selectLiveOnlyKey(useApp.getState(), '/home/deploy/repo', 'rw-1'));
  assert.deepEqual(rows, [{ key: 'k1', id: '20261015-190009', status: 'idle' }]);
});

test('a local and a remote workspace at the same path do not draw each other\'s rows', () => {
  // The reason `selectLiveOnlyKey` takes the machine at all. `/srv/app` here and
  // `/srv/app` on the host are two places that compare equal as strings; before
  // the id was part of the guard, each one's "open now" group drew the other's
  // conversations — the same list-shows-someone-else's-session shape the
  // `savedSessions` key fix is about, one layer up.
  const local = resumed('k-local', '/srv/app', 's-local');
  const remote = resumed('k-remote', '/srv/app', 's-remote');
  remote.remoteWorkspaceId = 'rw-1';
  install({ 'k-local': local, 'k-remote': remote }, ['k-local', 'k-remote'], 'k-local');

  const onLocal = parse(selectLiveOnlyKey(useApp.getState(), '/srv/app', null));
  assert.deepEqual(onLocal.map((r) => r.key), ['k-local'], 'only this machine\'s conversation');

  const onRemote = parse(selectLiveOnlyKey(useApp.getState(), '/srv/app', 'rw-1'));
  assert.deepEqual(onRemote.map((r) => r.key), ['k-remote'], 'and only the host\'s');
});

/* ============================================================
   Group 1b: the list is the workspace's, not the focused child's
   ============================================================ */

test('the same row lands in the same group whichever session is focused', () => {
  // **This is the reported symptom, in one assertion.** Two children in one
  // workspace: `k1` is the focused one and its copy of the files is stale, `k2`
  // is a second conversation whose copy happens to be newer. Before this change
  // the "open now" test read `activeRuntime(s)?.sessionList`, so focusing `k1`
  // drew the saved conversation as a live row reading "Nothing has run in it
  // yet" — and clicking `k2` moved it back into the saved list. One list that
  // changed when nobody asked it to.
  //
  // The list now lives in `savedSessions`, keyed by workspace, so it does not
  // depend on which row is selected at all.
  //
  // Both buckets are **resumed** conversations, deliberately: a `handshaken`
  // bucket is a session that never became a conversation, and switching away
  // from one closes it (`abandonIfUntouched`, Group 3) — which would make this
  // test pass for the wrong reason, with `k1` gone rather than merely not drawn.
  const saved = [{ id: '20261010-120142', messages: 244, steps: 78, preview: 'a topic' }];
  install(
    {
      k1: resumed('k1', 'C:/work', '20261010-124807'),
      k2: resumed('k2', 'C:/work', '20261010-135118'),
    },
    ['k1', 'k2'],
    'k1',
  );
  savedFor('C:/work', saved);

  const first = selectLiveOnlyKey(useApp.getState(), 'C:/work');

  useApp.getState().focusSession('k2');
  const second = selectLiveOnlyKey(useApp.getState(), 'C:/work');

  assert.equal(first, second, 'the rail does not change when the focus does');
  // And the saved conversation is not duplicated into the live group by either.
  assert.ok(!first.includes('20261010-120142'));
});

test('two children in one workspace read one and the same list', () => {
  // The other half, stated as the fact rather than as the symptom: the list is
  // **one** value for the workspace, so the count a row shows does not depend on
  // which of the workspace's children answered last. A `sessions` reply from
  // either is filed under the workspace.
  install(
    {
      k1: handshaken('k1', 'C:/work', '20261010-124807'),
      k2: handshaken('k2', 'C:/work', '20261010-135118'),
    },
    ['k1', 'k2'],
    'k1',
  );
  savedFor('C:/work', [{ id: '20261010-120142', messages: 244, steps: 78, preview: 'a topic' }]);

  // Both children's own `init.workspace` names the same directory, so both read
  // the one entry — and a selector does not allocate a fresh object per call, or
  // the rail would re-render forever.
  const a = selectSavedSessions(useApp.getState(), 'C:/work');
  const b = selectSavedSessions(useApp.getState(), 'c:/work/');
  assert.equal(a, b, 'case and trailing separator name the same workspace');
  assert.equal(a.items[0]?.messages, 244);
});

test('a workspace nothing has answered for reads "loading", not "empty"', () => {
  // `listed: false` and `items: []` are different statements, and the rail draws
  // them differently: "no runtime has told me yet" versus "this workspace has no
  // saved sessions". Collapsing them would put "no past session" on screen for
  // the second before the reply lands.
  install({ k1: handshaken('k1', 'C:/work', '20260101-120000') }, ['k1'], 'k1');

  const nothing = selectSavedSessions(useApp.getState(), 'C:/elsewhere');
  assert.equal(nothing.listed, false);
  assert.deepEqual(nothing.items, []);
  // A shared constant, so this does not re-render the rail forever.
  assert.equal(nothing, selectSavedSessions(useApp.getState(), 'C:/elsewhere'));
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
   Group 3: the session a launch leaves behind
   ============================================================ */

test('the idle session a launch opened is closed when the person moves on', () => {
  // **The reported shape.** A launch opens a session in the workspace last
  // worked in, so the window always comes up with one. Opening a past
  // conversation instead leaves that first one behind: a live child, no file,
  // and a rail row reading "open now / Nothing has run in it yet" for the rest
  // of the window's life — with no delete button, because there is no file.
  const idle = handshaken('k1', 'C:/work', '20261002-183456');
  const past = handshaken('k2', 'C:/work', '20261002-183131');
  install({ k1: idle, k2: past }, ['k1', 'k2'], 'k1');
  // A conversation with a file, which is what makes it a **past** session: the
  // runtime's list holds it, so it is drawn from there and not from this group.
  // Filed under the workspace, since that is what the list describes.
  savedFor('C:/work', [{ id: '20261002-183131', messages: 21, steps: 8, preview: 'hi' }]);

  useApp.getState().focusSession('k2');

  const s = useApp.getState();
  assert.equal(s.activeKey, 'k2');
  assert.equal(s.sessions.k1, undefined, 'the session that was left is closed, not merely unlisted');
  assert.deepEqual(s.order, ['k2']);
  // And the consequence the person actually sees: no row, from either group.
  assert.equal(selectLiveOnlyKey(s, 'C:/work'), '');
});

test('a session with something in it is left exactly where it is', () => {
  // The other half, and the half that would make this rule dangerous: the check
  // must be about a session that never became a conversation, not about one that
  // is merely not on screen. Each case below is a reason somebody would come
  // back to it — so each is a reason to keep the child alive.
  const cases: { what: string; mutate: (rt: SessionRuntime) => void }[] = [
    {
      what: 'a message has been sent',
      mutate: (rt) => {
        rt.hasSpoken = true;
      },
    },
    {
      what: 'a turn is running',
      mutate: (rt) => {
        rt.activeRunId = 'run-1';
      },
    },
    {
      what: 'a draft is half-typed',
      mutate: (rt) => {
        rt.draft = 'let me think about';
      },
    },
    {
      what: 'a shell was opened from it',
      mutate: (rt) => {
        rt.activeTerminalId = 'term-1';
      },
    },
    {
      what: 'its child died',
      mutate: (rt) => {
        rt.runtimeExit = { code: 1, requested: false };
      },
    },
    {
      what: 'the runtime said something worth reading',
      mutate: (rt) => {
        rt.problem = 'the workspace C:/work cannot be used';
      },
    },
  ];

  for (const { what, mutate } of cases) {
    const busy = handshaken('k1', 'C:/work', '20261002-183456');
    mutate(busy);
    install({ k1: busy, k2: handshaken('k2', 'C:/work', '20261002-183131') }, ['k1', 'k2'], 'k1');

    useApp.getState().focusSession('k2');

    assert.ok(useApp.getState().sessions.k1, `kept open when ${what}`);
  }
});

test('a conversation loaded from its file is not an idle session', () => {
  // `resumed` is the runtime's own answer, and it is the one fact that separates
  // "a child I just started for you" from "a conversation you picked". The gap
  // between `init` and `session_load` is why this cannot be read off the
  // transcript: the history has not been rebuilt yet, so a resumed session looks
  // empty for that one frame — and closing it in that frame would throw away a
  // conversation the person had just asked for.
  const past = resumed('k1', 'C:/work', '20261002-183131');
  install({ k1: past, k2: handshaken('k2', 'C:/work', '20261002-183456') }, ['k1', 'k2'], 'k1');

  useApp.getState().focusSession('k2');

  assert.ok(useApp.getState().sessions.k1, 'a resumed session is never closed by switching away');
});

test('a session still holding a request is never closed', () => {
  // The runtime blocks on the request id with no timeout, so a session that is
  // waiting on a person may not be ended by anything but that person — the same
  // rule the rail's own inertness follows.
  const asking = handshaken('k1', 'C:/work', '20261002-183456');
  install({ k1: asking, k2: handshaken('k2', 'C:/work', '20261002-183131') }, ['k1', 'k2'], 'k1', {
    pendingModals: [
      {
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
      },
    ] as AppStore['pendingModals'],
  });

  useApp.getState().focusSession('k2');

  assert.ok(useApp.getState().sessions.k1, 'the prompt is still on screen to be answered');
});

/**
 * Run `body` against a fake Tauri host that will start a child.
 *
 * `attachSession` returns null before it touches the store when there is no
 * bridge, so the path a launch-plus-click actually takes — the conversation was
 * not open, so a child is started for it — can only be exercised with one. The
 * host is the smallest that answers `runtime_attach`; `runtime_stderr` is the
 * one other command the attach path calls, and `ensureHost` tolerates never
 * having been wired (`initBridge`) because nothing here subscribes to events.
 */
async function withFakeAttach<T>(body: () => Promise<T>): Promise<T> {
  const previous = (globalThis as { window?: unknown }).window;
  let minted = 0;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke(cmd: string) {
        if (cmd === 'runtime_attach') {
          minted += 1;
          return Promise.resolve(minted);
        }
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

test('opening a closed past conversation closes the idle session it displaces', async () => {
  // **The path the report actually took.** The launch opens a session in the
  // workspace last worked in; clicking a past conversation that no child has
  // open goes through `attachSession`, not `focusSession` — so the abandonment
  // has to live on both, or the row this whole change is about survives exactly
  // the click that produced it.
  const idle = handshaken('k1', 'C:/work', '20261002-183456');
  install({ k1: idle }, ['k1'], 'k1');

  await withFakeAttach(() =>
    useApp.getState().attachSession({ workspace: 'C:/work', sessionId: '20261002-183131' }),
  );

  const s = useApp.getState();
  assert.equal(s.activeKey, '1', 'the conversation that was asked for is the one on screen');
  assert.equal(s.sessions.k1, undefined, 'and the idle session it displaced is closed');
  assert.deepEqual(s.order, ['1']);
});

test('the handshake\'s own notices are not a conversation', () => {
  // The boundary that decides whether the rule ever fires at all. Every session
  // is handed runtime notices ("no ripgrep", "this MCP server did not attach"),
  // and they are session content the design says must not be pushed out — but a
  // row of them is still not something anybody comes back to. If they counted,
  // the idle session would be kept for ever on any machine with a warning.
  const noticed = handshaken('k1', 'C:/work', '20261002-183456');
  noticed.entries = [
    { kind: 'note', id: 'n1', tone: 'warn', code: 'grep.missing_binary', text: 'no ripgrep' },
  ];
  install({ k1: noticed, k2: handshaken('k2', 'C:/work', '20261002-183131') }, ['k1', 'k2'], 'k1');

  useApp.getState().focusSession('k2');

  assert.equal(useApp.getState().sessions.k1, undefined);
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

test('a drawn blocking prompt still makes it inert', () => {
  // The reason the check existed in the first place, and it must keep working:
  // switching a session under an approval on screen abandons the request the
  // runtime is waiting on, and it waits for ever.
  install({ k1: handshaken('k1', 'C:/work', '20261002-183456') }, ['k1'], 'k1', {
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

test('a request held for another session leaves the rail usable', () => {
  // **The half that is new, and the reason the check is asked of visibility.**
  // A request from a conversation that is not on screen has drawn nothing — so
  // the rail must stay live, because clicking that session's row is now the act
  // that surfaces the prompt (`focusSession` re-aims the drawn slot) and
  // `focusSession` sends the runtime nothing a held request could be disturbed
  // by. Disabling the rail here would be the old "a button that does nothing"
  // with a prompt nobody can reach behind it.
  install(
    {
      k1: handshaken('k1', 'C:/work', '20261002-183456'),
      k2: handshaken('k2', 'C:/work', '20261002-183131'),
    },
    ['k1', 'k2'],
    'k1',
    {
      // Both halves, because that is what `enqueueModal` writes and the two are
      // read by different things: `pendingModals` is what `selectRowStatus`
      // counts as `asking`, and `modal` is the slot `selectModalVisible` judges.
      pendingModals: [
        {
          kind: 'permission',
          key: 'k2',
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
        },
      ] as AppStore['pendingModals'],
      modal: {
        kind: 'permission',
        key: 'k2',
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
    },
  );
  assert.equal(selectModalVisible(useApp.getState()), false, 'nothing is drawn');
  assert.equal(railBlocked(useApp.getState()), false, 'so the rail is not inert');
  assert.equal(selectRowStatus(useApp.getState(), 'k2'), 'asking', 'the row says who is asking');
});

test('with nothing open the rail is live', () => {
  // The other half of the pair: a check that answered `true` unconditionally
  // would pass both assertions above and disable the rail for ever.
  install({}, [], null);
  assert.equal(railBlocked(useApp.getState()), false);
});

/* ============================================================
   Group 3: a request the session board is holding
   ============================================================ */

/**
 * The two modals gate their render on `selectModalVisible`, so the interesting
 * inputs are the two places a held request can sit: behind a board whose card
 * carries the "click to reply" nudge, and behind a board that is not actually
 * what the column is showing — where holding would strand the request with no
 * surface to surface it from.
 */

test('a request arriving while the board is up is held, not rendered', () => {
  // The board is the surface that names the waiting session — its card has
  // moved into Needs you — so the prompt does not cover it. Nothing answers
  // the request and nothing drops it; the click on the card is what surfaces
  // it, by closing the board.
  const bucket = handshaken('k1', 'C:/work', '20261002-183456');
  install({ k1: bucket }, ['k1'], 'k1', {
    boardOpen: true,
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
  assert.equal(selectModalVisible(useApp.getState()), false);
  // And the same request becomes visible the moment the board closes — the
  // click, or Esc.
  useApp.setState({ boardOpen: false });
  assert.equal(selectModalVisible(useApp.getState()), true);
});

test('a held request becomes visible when the terminal outranks the board', () => {
  // The deadlock guard. With a shell attached, the conversation column shows
  // the terminal, not the board — so nothing would be carrying the "click to
  // reply" nudge, and holding the prompt there is holding it with no way to
  // reach it. Holding happens **only** in the exact state where the board
  // holds the column.
  const bucket = handshaken('k1', 'C:/work', '20261002-183456');
  bucket.activeTerminalId = 'term-01';
  install({ k1: bucket }, ['k1'], 'k1', {
    boardOpen: true,
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
  assert.equal(selectModalVisible(useApp.getState()), true);
});

test('a board with no request under it renders nothing to hold', () => {
  // The other half of the pair: `selectModalVisible` also answers for the two
  // components' `open`, so a board that is up **without** a request must yield
  // a dead modal rather than a phantom one.
  const bucket = handshaken('k1', 'C:/work', '20261002-183456');
  install({ k1: bucket }, ['k1'], 'k1', { boardOpen: true });
  assert.equal(selectModalVisible(useApp.getState()), false);
});

/* ============================================================
   Group 3b: the board's gate, and the two doors that read it
   ============================================================ */

/**
 * The board is reached from two places — the left rail's foot and the session
 * bar's leading edge — and this is the one question both must ask.
 *
 * `selectBoardAvailable` was lifted out of `WorkspaceSidebar` for that: the
 * gate cannot be "the session on screen is ready" (that is Files and
 * Terminal's), and a second hand-written copy of it in the session bar would
 * eventually be written differently, leaving one door open and the other dead
 * on the same screen. So the assertions below are as much about the *shape* of
 * the answer as about the answer: it is a pure function of the workspace, and
 * both surfaces call it.
 */

test('the board is available while any child in this workspace is alive', () => {
  // The ordinary case, and the one the design's §3.4 relies on: the rail stays
  // usable under the board, so `focusSession` can move between conversations —
  // and with two children in one workspace the question is answered by the
  // workspace, not by the focused bucket.
  install(
    {
      k1: handshaken('k1', 'C:/work', '20261002-183456'),
      k2: handshaken('k2', 'C:/work', '20261002-183131'),
    },
    ['k1', 'k2'],
    'k1',
  );
  assert.equal(selectBoardAvailable(useApp.getState()), true);
});

test('a failed session on screen does not close the board', () => {
  // **The case the gate exists for, and the reason it is not `hasSession`.**
  // The session on screen is the one whose child never came up — so Files and
  // Terminal are correctly unavailable — while the other conversation in the
  // workspace is running fine. The board is about the whole workspace, so it
  // must open here more than anywhere: this is exactly the screen where a
  // person needs to see that the other sessions are alive.
  const broken = handshaken('k1', 'C:/work', '20261002-183456');
  broken.ready = false;
  broken.problem = 'the workspace C:/work cannot be used';
  install(
    { k1: broken, k2: handshaken('k2', 'C:/work', '20261002-183131') },
    ['k1', 'k2'],
    'k1',
  );
  assert.equal(selectBoardAvailable(useApp.getState()), true);
});

test('a child whose workspace is unknown yet still counts as live', () => {
  // The second before `init` lands. It is in the store because this end just
  // started it, and answering "no" here would make the board's button dead for
  // the first second of every session — the "a press that does nothing"
  // failure this whole suite is about.
  const fresh_ = fresh('k1', '');
  install({ k1: fresh_ }, ['k1'], 'k1');
  assert.equal(selectBoardAvailable(useApp.getState()), true);
});

test('nothing open means no board, which is the other half', () => {
  // A gate that answered `true` unconditionally would pass every test above
  // and offer a board over a workspace with nothing in it to report.
  install({}, [], null);
  assert.equal(selectBoardAvailable(useApp.getState()), false);
});

test('the gate is the workspace\'s, and the screen\'s own child answers for it', () => {
  // **What the gate can and cannot say**, pinned because the workspace clause
  // reads like a filter and is worth being honest about. `activeWorkspaceOf`
  // reads `init.workspace` off the session **on screen**, so once a session is
  // open its own bucket is necessarily inside the set being scanned and
  // necessarily matches — which means the gate is `false` exactly when nothing
  // is open, and its workspace clause is a statement of *scope* rather than a
  // filter that can currently exclude anything.
  //
  // Asserted rather than argued because it constrains the selector's future: the
  // day `activeWorkspaceOf` answers from somewhere else (a remembered path, a
  // workspace row), that clause becomes load-bearing and this test's second
  // assertion is what says so.
  install(
    {
      k1: handshaken('k1', 'C:/work', '20261002-183456'),
      k2: handshaken('k2', 'C:/other', '20261002-183131'),
    },
    ['k1', 'k2'],
    'k1',
  );
  assert.equal(selectBoardAvailable(useApp.getState()), true, 'the screen\'s own child answers');

  // And it is asked of the **screen's** workspace, not of the workspace that
  // happens to sort first: focusing the other conversation changes which bucket
  // answers, and not the answer.
  useApp.getState().focusSession('k2');
  assert.equal(selectBoardAvailable(useApp.getState()), true);
});

test('a drawn prompt does not close the board, but it does disable the door', () => {
  // The two facts `` disabled={blocked || (!boardAvailable && !boardOpen)} ``
  // combines, asserted separately because they are different questions. A
  // prompt makes every control on the surface inert (`railBlocked` — the body
  // inherits `pointer-events: none`), and it does **not** make the board
  // unavailable: `setBoardOpen` is local, sends nothing and disturbs no
  // pending request, so the board is still openable from the keyboard chain
  // once the prompt is answered. A gate that folded the prompt in would have
  // written "the prompt is showing" into the workspace's answer.
  const bucket = handshaken('k1', 'C:/work', '20261002-183456');
  install({ k1: bucket }, ['k1'], 'k1', {
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
  assert.equal(selectBoardAvailable(useApp.getState()), true, 'the workspace is still able to answer');
  assert.equal(railBlocked(useApp.getState()), true, 'but the control must say it is inert');
});

test('the board stays openable from the bar once the children are gone', () => {
  // The escape hatch, and the half that has to survive the fix: while the board
  // is up its button must not be disabled by its own gate, or the view would be
  // a room with no door — the rail's foot being the other one, and also gone
  // with the rail. `disabled` is `!boardAvailable && !boardOpen`, so the open
  // board answers for itself.
  install({}, [], null, { boardOpen: true });
  assert.equal(selectBoardAvailable(useApp.getState()), false);
  assert.equal(
    !selectBoardAvailable(useApp.getState()) && !useApp.getState().boardOpen,
    false,
    'an open board is still closable from its own button',
  );
});

/* ============================================================
   Group 4: a red dot that would not go away
   ============================================================ */

/**
 * Feed one audit record through the same path the store's `event` case uses.
 *
 * The status is a pure function of the transcript, so the interesting input is
 * the **sequence of turns** that produced it — and replaying the real events is
 * the only way to assert a state that depends on there having been two turns.
 * `lookup` is the one option the reducer takes that needs no store: no tool row
 * is drawn here.
 */
function replay(bucket: SessionRuntime, events: Record<string, unknown>[]): void {
  for (const ev of events) {
    const result = reduceEvent(bucket.entries, ev as never, {
      activeRunId: bucket.activeRunId,
      lastRunId: bucket.lastRunId,
      lookup: () => null,
      maxSteps: 100,
    });
    assert.ok(!result.stale, `the replay dropped ${ev.kind} as stale`);
    bucket.entries = result.entries;
    bucket.activeRunId =
      result.startedRunId ?? (result.runEnded ? null : bucket.activeRunId);
    bucket.lastRunId =
      result.startedRunId ?? (result.runEnded ? (ev.run_id as string) : bucket.lastRunId);
  }
}

/** The turn heads of a bucket, which is what the status is read off. */
function heads(bucket: SessionRuntime): string[] {
  return bucket.entries.flatMap((e: Entry) => (e.kind === 'turn' ? [e.status] : []));
}

test('a turn in flight is not outranked by a failure that is already history', () => {
  // **The reported symptom: "it failed once and the red dot never went away."**
  // `lastStopReason` reads the most recent *finished* turn, so after a
  // `model_error` it kept answering `broken` — including while the next turn was
  // running. The recovered turn below is exactly the real sequence from
  // `.tudouni/logs/20261010-120142.jsonl`: `cancelled`, `answered`, `model_error`,
  // then a turn that ran to completion. The retry ran for four minutes under a red
  // dot while the status bar beside it read "running" — two surfaces of one window
  // disagreeing about one session.
  const bucket = handshaken('k1', 'C:/work', '20261010-120142');
  install({ k1: bucket }, ['k1'], 'k1');

  replay(bucket, [
    { kind: 'run_started', run_id: 'r1', step: 0 },
    { kind: 'run_finished', run_id: 'r1', step: 1, stop_reason: 'cancelled' },
    { kind: 'run_started', run_id: 'r2', step: 0 },
    { kind: 'run_finished', run_id: 'r2', step: 1, stop_reason: 'answered' },
    { kind: 'run_started', run_id: 'r3', step: 0 },
    { kind: 'run_finished', run_id: 'r3', step: 1, stop_reason: 'model_error' },
  ]);

  assert.equal(selectRowStatus(useApp.getState(), 'k1'), 'broken', 'the failure is reported');

  // The person sends the next message, and it is working.
  replay(bucket, [{ kind: 'run_started', run_id: 'r4', step: 0 }]);
  install({ k1: bucket }, ['k1'], 'k1');

  const status = selectRowStatus(useApp.getState(), 'k1');
  assert.equal(heads(bucket).at(-1), 'running', 'the newest turn is the live one');
  assert.equal(status, 'running', 'a session that is demonstrably working is not red');

  // And it stays that way for the whole turn, not just its first frame.
  replay(bucket, [
    { kind: 'model_call', run_id: 'r4', step: 1, status: 'ok', duration_ms: 10 },
    { kind: 'model_call', run_id: 'r4', step: 2, status: 'ok', duration_ms: 10 },
  ]);
  install({ k1: bucket }, ['k1'], 'k1');
  assert.equal(selectRowStatus(useApp.getState(), 'k1'), 'running');
});

test('a turn that ends badly earns the red dot back', () => {
  // The other half, and the half that makes the rule safe: the failure must still
  // be reported for as long as it is the latest thing that happened. A fix that
  // simply deleted `model_error` from the check would pass the test above and
  // silently stop reporting the one state the dot exists for.
  const bucket = handshaken('k1', 'C:/work', '20261010-120142');
  replay(bucket, [
    { kind: 'run_started', run_id: 'r1', step: 0 },
    { kind: 'run_finished', run_id: 'r1', step: 1, stop_reason: 'model_error' },
    { kind: 'run_started', run_id: 'r2', step: 0 },
    { kind: 'run_finished', run_id: 'r2', step: 1, stop_reason: 'model_error' },
  ]);
  install({ k1: bucket }, ['k1'], 'k1');

  assert.equal(selectRowStatus(useApp.getState(), 'k1'), 'broken');
});

test('a child that died unasked is red even with no live turn', () => {
  // `runtimeExit` is the other failure the dot reports, and it is not in the
  // transcript: `settleAbandonedTurn` closes the turn such a child was in, so
  // there is no running turn for it to be outranked by. Asserted here because the
  // reordered check must not have swallowed it.
  const bucket = handshaken('k1', 'C:/work', '20261010-120142');
  bucket.runtimeExit = { code: 1, requested: false };
  install({ k1: bucket }, ['k1'], 'k1');

  assert.equal(selectRowStatus(useApp.getState(), 'k1'), 'broken');
});

test('a failure outranks an unread finished turn, and asking outranks both', () => {
  // The priority order is the point of the selector, so the pair that does **not**
  // change is asserted too: a failure nobody has seen is still red rather than
  // blue, and a session waiting on an approval is amber however it got there.
  const bucket = handshaken('k1', 'C:/work', '20261010-120142');
  bucket.unseen = true;
  replay(bucket, [
    { kind: 'run_started', run_id: 'r1', step: 0 },
    { kind: 'run_finished', run_id: 'r1', step: 1, stop_reason: 'model_error' },
  ]);
  install({ k1: bucket }, ['k1'], 'k2');
  assert.equal(selectRowStatus(useApp.getState(), 'k1'), 'broken', 'red over blue');

  install({ k1: bucket }, ['k1'], 'k2', {
    pendingModals: [
      {
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
      },
    ] as AppStore['pendingModals'],
  });
  assert.equal(selectRowStatus(useApp.getState(), 'k1'), 'asking', 'amber over red');
});

/* ============================================================
   Group 4: archive, and the two lists that must not disagree
   ============================================================ */

test('the rail never shows an archived row, even when the connection asks for all', () => {
  // **The whole reason the rail reads `active` and not `items`.** The library's
  // Archived tab needs the archived rows, and the runtime's list is one per
  // connection — so while the library is open the connection is asking for
  // `all`. If the rail drew `items`, an archived conversation would reappear in
  // it for exactly as long as somebody had `/resume` open, and *which rows the
  // rail shows* would depend on an unrelated panel.
  install({}, [], null, { sessionFilter: 'all' });
  savedFor('C:/work', [
    { id: 'kept', preview: 'still here' },
    { id: 'gone', preview: 'put away', archived: true },
  ]);

  const saved = selectSavedSessions(useApp.getState(), 'C:/work');
  assert.deepEqual(saved.items.map((r) => r.id), ['kept', 'gone'], 'the library sees both');
  assert.deepEqual(saved.active.map((r) => r.id), ['kept'], 'the rail sees only the active one');
});

test('the library borrows the connection filter, and hands it back on close', () => {
  // The steady state is `active` — the desktop archives, and archiving only
  // frees one of the runtime's fifty slots if the runtime is the one that drops
  // the row. Opening the library has to widen it, because its Archived tab draws
  // rows the steady request excludes; closing it has to narrow it again, or the
  // rail keeps reporting archived sessions for the rest of the window's life.
  const sent = captureSent();
  install({ k1: handshaken('k1', 'C:/work', 's-1') }, ['k1'], 'k1');

  useApp.getState().openPanel('resume');
  assert.equal(useApp.getState().sessionFilter, 'all');
  assert.equal(useApp.getState().panel, 'resume');
  const widened = sent.filter((m) => m.t === 'session_list');
  assert.deepEqual(widened[widened.length - 1], { v: 1, t: 'session_list', filter: 'all' });

  useApp.getState().closePanel();
  assert.equal(useApp.getState().sessionFilter, 'active');
  const narrowed = sent.filter((m) => m.t === 'session_list');
  assert.deepEqual(narrowed[narrowed.length - 1], { v: 1, t: 'session_list', filter: 'active' });
});

test('closing a panel that is not the library leaves the filter alone', () => {
  // The other half, and the half that would make this a message per panel close:
  // every other panel has nothing to do with archived sessions, so restoring the
  // filter on their way out would be a request nobody asked for.
  const sent = captureSent();
  install({ k1: handshaken('k1', 'C:/work', 's-1') }, ['k1'], 'k1');

  useApp.getState().openPanel('skills');
  const before = sent.filter((m) => m.t === 'session_list').length;
  useApp.getState().closePanel();

  assert.equal(useApp.getState().sessionFilter, 'active');
  assert.equal(sent.filter((m) => m.t === 'session_list').length, before);
});

test('archiving is refused while a live child holds the id', () => {
  // **The one gate the runtime cannot keep.** Whether a session file is being
  // written is a fact about this end's connections; the runtime sees no other
  // process, so it neither can nor should refuse. The store refuses on this
  // end's behalf, and sends nothing — the visible half of the same rule is the
  // disabled button in the library.
  const sent = captureSent();
  install({ k1: handshaken('k1', 'C:/work', 's-live') }, ['k1'], 'k1');

  useApp.getState().archiveSession('s-live', true);
  assert.equal(sent.filter((m) => m.t === 'session_archive').length, 0);

  // A file nobody has open is a plain request, and an absolute state rather than
  // a toggle — so re-sending it is idempotent.
  useApp.getState().archiveSession('s-old', true);
  assert.deepEqual(
    sent.find((m) => m.t === 'session_archive'),
    { v: 1, t: 'session_archive', session_id: 's-old', archived: true },
  );
});

test('the live-id lookup is the same answer the gate and the button read', () => {
  // One rule, one source: the library disables the action from this, and
  // `archiveSession` refuses from the same set, so the claim and the check
  // cannot drift apart.
  install({ k1: handshaken('k1', 'C:/work', 's-live'), k2: fresh('k2', 'C:/work') }, ['k1', 'k2'], 'k1');

  const ids = selectLiveSessionIds(useApp.getState());
  assert.equal(ids.has('s-live'), true);
  // A child whose `init` has not landed has no id, which is not the empty-string
  // session — `has('')` would make every unknown id look live.
  assert.equal(ids.has(''), false);
  assert.equal(ids.size, 1);
});

