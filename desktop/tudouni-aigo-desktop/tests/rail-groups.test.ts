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
  selectLiveOnlyKey,
  selectRowStatus,
  useApp,
  type AppStore,
  type SessionRuntime,
} from '@/state/store';
import { reduceEvent, type Entry } from '@/state/entries';

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
  // A conversation with a file, which is what makes it a **past** session: the
  // runtime's list holds it, so it is drawn from there and not from this group.
  past.sessionList = [
    { id: '20261002-183131', messages: 21, steps: 8, todos: '', preview: 'hi', modifiedAt: 1 },
  ];
  past.listedSessions = true;
  install({ k1: idle, k2: past }, ['k1', 'k2'], 'k1');

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
