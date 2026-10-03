/**
 * Tests for the protocol layer, the projection layer and the stream reducer.
 *
 * These exist for one reason, stated in the design (§11): **the protocol
 * mismatches are the easiest thing to get wrong and the hardest to see**. A
 * wrong key name does not throw — it renders as blank or as 0, and the screen
 * looks plausible. So the assertions here are about the mapping itself.
 *
 * Payloads are shaped like what the Go runtime actually emits, with the field
 * names read off `internal/runtime/composition.go`, `internal/agent/agent.go`
 * and `internal/subagent/board.go`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeLine, ENVELOPE_VERSION, PROTOCOL_VERSION } from '@/protocol/types';
import { isTypingTarget, listKeyAction } from '@/hooks/useListKeys';
import { appendPaths, isInsideWorkspace, partitionDrop } from '@/runtime/dragdrop';
import {
  cacheHitRate,
  mergeSkills,
  phaseFromStopReason,
  projectContext,
  projectHistory,
  projectInit,
  projectJobs,
  projectMcp,
  projectSessionList,
  projectState,
  projectStatus,
  projectTools,
} from '@/runtime/adapt';
import {
  applyDelta,
  applyFinalAnswer,
  clearStream,
  hasRunningTurn,
  lastStopReason,
  reduceEvent,
  settleAbandonedTurn,
  type Entry,
  type LooseEvent,
} from '@/state/entries';
import { registerRuntime, sendTo } from '@/runtime/bus';
import {
  activeRuntime,
  createSessionBucket,
  selectModalOrigin,
  selectQueuedModals,
  selectTurnMs,
  selectUsage,
  useApp,
  type SessionRuntime,
} from '@/state/store';
import type { FrontendMsg } from '@/protocol/types';

/* ============================================================
   list keys and the keyboard guards
   ============================================================ */

test('a digit typed into a field is a character, not a command pick', () => {
  const base = { ctrl: false, meta: false, alt: false, count: 17 };

  // The palette's search box has focus and the listener is on `window`, so
  // without the guard `1` ran `/new` (wiping the stream) and `4` ran `/exit`
  // (shutting the runtime down) before the character ever reached the field.
  assert.equal(listKeyAction({ ...base, key: '1', typing: true }), null);
  assert.equal(listKeyAction({ ...base, key: '4', typing: true }), null);

  // Outside a field the numeric pick still works.
  assert.deepEqual(listKeyAction({ ...base, key: '1', typing: false }), {
    kind: 'pick',
    index: 0,
  });
  // And an index past the end of a short list is not a pick.
  assert.equal(listKeyAction({ ...base, key: '9', typing: false, count: 3 }), null);
  assert.deepEqual(listKeyAction({ ...base, key: '3', typing: false, count: 3 }), {
    kind: 'pick',
    index: 2,
  });
});

test('movement and confirm still work from a field', () => {
  const base = { ctrl: false, meta: false, alt: false, count: 3, typing: true };
  // A person typing in the palette expects ↑/↓/Enter to drive the list.
  assert.deepEqual(listKeyAction({ ...base, key: 'ArrowDown' }), { kind: 'move', delta: 1 });
  assert.deepEqual(listKeyAction({ ...base, key: 'ArrowUp' }), { kind: 'move', delta: -1 });
  assert.deepEqual(listKeyAction({ ...base, key: 'Enter' }), { kind: 'confirm' });

  // Esc closes from anywhere, including from a field.
  assert.deepEqual(listKeyAction({ ...base, key: 'Escape' }), { kind: 'close' });
  // A modified digit is a browser shortcut, never a pick.
  assert.equal(listKeyAction({ ...base, key: '1', typing: false, ctrl: true }), null);
});

test('a text field is recognised as a typing target', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget('INPUT'), false);
});

/* ============================================================
   dropped paths
   ============================================================ */

test('a dropped path is only accepted from inside the workspace', () => {
  const ws = 'C:\\work\\proj';

  // Inside, both separators, and the workspace itself.
  assert.equal(isInsideWorkspace('C:\\work\\proj\\shot.png', ws), true);
  assert.equal(isInsideWorkspace('C:/work/proj/shot.png', ws), true);
  assert.equal(isInsideWorkspace('C:\\work\\proj\\docs\\a.png', ws), true);
  assert.equal(isInsideWorkspace(ws, ws), true);

  // Windows filesystems are case-insensitive, so refusing a different case would
  // be a false rejection of a file the runtime can read.
  assert.equal(isInsideWorkspace('c:\\WORK\\proj\\a.png', ws), true);

  // Outside: a sibling directory, the parent, and a path that merely starts
  // with the same letters must not pass a naive `startsWith` check.
  assert.equal(isInsideWorkspace('C:\\work\\other\\a.png', ws), false);
  assert.equal(isInsideWorkspace('C:\\work\\a.png', ws), false);
  assert.equal(isInsideWorkspace('C:\\work\\project2\\a.png', ws), false);
  assert.equal(isInsideWorkspace('D:\\a.png', ws), false);
});

test('a drop is partitioned, and a workspace-less drop is refused outright', () => {
  const ws = '/home/u/proj';
  const out = partitionDrop(['/home/u/proj/a.png', '/tmp/b.png'], ws);
  assert.deepEqual(out.accepted, ['/home/u/proj/a.png']);
  assert.deepEqual(out.rejected, ['/tmp/b.png']);
  assert.equal(out.unknownWorkspace, false);

  // No workspace yet: nothing can be checked, so nothing is inserted. Inserting
  // anyway would put a word in the sentence that the runtime cannot resolve.
  const none = partitionDrop(['/home/u/proj/a.png'], '');
  assert.deepEqual(none.accepted, []);
  assert.deepEqual(none.rejected, ['/home/u/proj/a.png']);
  assert.equal(none.unknownWorkspace, true);
});

test('an inserted path stays a separate word', () => {
  // The runtime finds pictures by scanning the sentence for path-shaped words
  // (`content.FindImagePaths`), so a path glued to the previous word is a word
  // it will not recognise.
  assert.equal(appendPaths('', ['a.png']), 'a.png ');
  assert.equal(appendPaths('look at this', ['a.png']), 'look at this a.png ');
  // Trailing whitespace means the caret is already at a word boundary.
  assert.equal(appendPaths('look at this ', ['a.png']), 'look at this a.png ');
  assert.equal(appendPaths('x', ['a.png', 'b.png']), 'x a.png b.png ');
  // Nothing accepted changes nothing.
  assert.equal(appendPaths('unchanged', []), 'unchanged');
});

/* ============================================================
   Envelope
   ============================================================ */

test('the envelope version is the one hard failure point', () => {
  assert.equal(ENVELOPE_VERSION, 1);
  // 4 adds the workspace's two capabilities (Files and Terminal) to 3. It is a
  // **semantic** version and not the hard one: a front end that does not know
  // the new kinds ignores them and still gets the whole answer from
  // `ui(run_finished).answer`, which is exactly why `protocol` is separate from
  // `v` in the first place.
  assert.equal(PROTOCOL_VERSION, 4);

  // Decoding an `init` from a **3** runtime still works: the field is documented
  // as survivable, and the capture in `tests/fixtures/opening.jsonl` is one, so
  // this is the real case rather than a hypothetical one.
  const ok = decodeLine(`{"v":1,"t":"init","protocol":3}`);
  assert.equal(ok.msg?.t, 'init');
  assert.equal(ok.fatal, undefined);

  // A missing `v` is not a message: without it there is no way to know which
  // envelope this is.
  assert.equal(decodeLine(`{"t":"init"}`).msg, null);
  assert.equal(decodeLine(`{"t":"init"}`).reason, 'missing-envelope-version');

  // A different `v` is the one thing that stops the stream — and it is marked
  // fatal, because every following line will fail the same check. Counting them
  // one at a time would turn "these two ends cannot talk" into a plausible
  // tally.
  const mismatch = decodeLine(`{"v":2,"t":"init"}`);
  assert.equal(mismatch.msg, null);
  assert.match(mismatch.reason ?? '', /version-mismatch/);
  assert.equal(mismatch.fatal, true);
  assert.equal(mismatch.reason, 'envelope-version-mismatch:2');
});

test('a malformed line is skipped and counted, never fatal', () => {
  // Half a line is a real thing: the writer was killed mid-write.
  assert.equal(decodeLine('{"v":1,"t":"ui"').reason, 'unparseable');
  assert.equal(decodeLine('{"v":1,"t":"ui"').fatal, undefined);
  assert.equal(decodeLine('').reason, 'empty');
  assert.equal(decodeLine('   ').reason, 'empty');
  assert.equal(decodeLine('[1,2,3]').reason, 'not-an-object');

  // A mistyped flag makes the child print usage prose to stdout, so prose must
  // not be treated as a broken stream either.
  assert.equal(decodeLine('Usage: tudouni-aigo [flags]').reason, 'unparseable');
  assert.equal(decodeLine('Usage: tudouni-aigo [flags]').fatal, undefined);
});

test('an unknown type is ignored, and a known one survives extra fields', () => {
  assert.equal(decodeLine('{"v":1,"t":"from_the_future"}').msg, null);
  assert.equal(decodeLine('{"v":1,"t":"from_the_future"}').reason, 'unknown-type:from_the_future');
  // An unknown *type* is survivable too: the envelope still parses, so the
  // stream is fine and this is one message we do not know.
  assert.equal(decodeLine('{"v":1,"t":"from_the_future"}').fatal, undefined);

  // Messages are maps, not structs: both ends upgrade independently, and the
  // rule is "ignore what you do not know, keep going".
  const withExtras = decodeLine('{"v":1,"t":"notice","level":"info","code":"x","text":"y","later":42}');
  assert.equal(withExtras.msg?.t, 'notice');
});

/* ============================================================
   init
   ============================================================ */

const INIT_PAYLOAD = {
  v: 1,
  t: 'init',
  protocol: 3,
  session_id: 's-1',
  resumed: false,
  model: 'deepseek-chat',
  provider: 'deepseek',
  thinking: true,
  effort: 'high',
  effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  model_catalog: {
    models: [
      {
        provider: 'deepseek',
        id: 'deepseek-chat',
        label: 'DeepSeek Chat',
        window: 65536,
        summary: 'general purpose',
        note: '',
        vision: false,
        current: true,
        effort: 'high',
        effort_levels: ['low', 'high'],
      },
      {
        provider: 'acme',
        id: 'deepseek-chat',
        label: 'DeepSeek Chat (acme)',
        window: null,
        summary: '',
        note: '',
        vision: false,
        current: false,
        effort: 'medium',
        effort_levels: [],
      },
    ],
    aliases: [{ id: 'deepseek-reasoner', of: 'deepseek-chat' }],
  },
  workspace: 'C:/work/proj',
  max_steps: 120,
  stream: true,
  context_tokens: 65536,
  tools: [
    { name: 'shell', risk: 'high', parallel_safe: false, interactive: false },
    { name: 'read_file', risk: 'low', parallel_safe: true, interactive: false },
  ],
  permissions: {},
  audit_path: 'C:/work/proj/.tudouni/audit/s-1.jsonl',
  notices: [{ level: 'warn', code: 'grep.missing_binary', text: 'grep is not registered' }],
};

test('init projects flat fields, and keeps provider separate from model', () => {
  const init = projectInit(INIT_PAYLOAD as never);

  assert.equal(init.sessionId, 's-1');
  assert.equal(init.resumed, false);
  assert.equal(init.model, 'deepseek-chat');
  // Two routes can carry the same name; "where the request went" is its own fact.
  assert.equal(init.provider, 'deepseek');
  assert.equal(init.workspace, 'C:/work/proj');
  assert.equal(init.maxSteps, 120);
  assert.equal(init.stream, true);
  assert.equal(init.contextTokens, 65536);
  assert.equal(init.protocol, 3);

  // The levels come from the runtime; the front end never hard-codes them.
  assert.deepEqual(init.effortLevels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

  assert.equal(init.tools.length, 2);
  assert.equal(init.tools[0].name, 'shell');
  assert.equal(init.tools[0].risk, 'high');
  assert.equal(init.tools[0].parallelSafe, false);

  assert.equal(init.notices.length, 1);
  assert.equal(init.notices[0].code, 'grep.missing_binary');

  // Same name, two routes: both survive and stay distinguishable.
  assert.equal(init.models.length, 2);
  assert.equal(init.models[0].provider, 'deepseek');
  assert.equal(init.models[1].provider, 'acme');
  assert.equal(init.models[1].window, null);

  // Aliases are accepted names outside the list; they are data, so they travel.
  assert.deepEqual(init.modelAliases, [{ id: 'deepseek-reasoner', of: 'deepseek-chat' }]);
});

test('init has no product version, locale, user name or theme list', () => {
  const init = projectInit(INIT_PAYLOAD as never) as unknown as Record<string, unknown>;
  for (const absent of ['version', 'locale', 'user_name', 'themes']) {
    assert.equal(absent in init, false, `${absent} must not be invented`);
  }
});

/* ============================================================
   skills: four facts, two lists
   ============================================================ */

test('the loaded set is `active`, not the catalogue', () => {
  const pointers = [
    { name: 'pdf-tools', digest: 'ab12', description: 'work with PDFs' },
    { name: 'web-search', digest: 'cd34', description: null },
  ];
  const catalog = [
    { name: 'pdf-tools', description: 'work with PDFs' } as never,
    { name: 'web-search', description: 'search the web' } as never,
  ];
  // The catalogue this session *can* load — deliberately wider than `active`.
  const available = [
    { name: 'pdf-tools', digest: '', description: null },
    { name: 'web-search', digest: '', description: null },
    { name: 'pptx', digest: '', description: 'build decks' },
  ];

  const merged = mergeSkills(pointers, catalog, available, ['pdf-tools', 'web-search']);

  // Loaded = `active`, in load order, enriched from the pointer + catalog.
  assert.deepEqual(merged.loaded.map((s) => s.name), ['pdf-tools', 'web-search']);
  assert.equal(merged.loaded[0].digest, 'ab12');
  assert.equal(merged.loaded[0].description, 'work with PDFs');
  // A missing pointer description falls back to the catalogue's.
  assert.equal(merged.loaded[1].description, 'search the web');

  // What is left is the difference — which used to always be empty, because
  // "loaded" was derived from the catalogue itself.
  assert.deepEqual(merged.available.map((s) => s.name), ['pptx']);
});

test('a skill loaded but not in the catalogue is still listed', () => {
  // `active` is authoritative: the runtime loaded it, so it is loaded.
  const merged = mergeSkills([], [], [], ['not-in-catalog']);
  assert.deepEqual(merged.loaded.map((s) => s.name), ['not-in-catalog']);
  // No digest and no description were sent, so both are "unset" rather than
  // invented — the panel renders that as unknown.
  assert.equal(merged.loaded[0].digest, '');
  assert.equal(merged.loaded[0].description, null);
});

test('with nothing loaded, the catalogue is entirely available', () => {
  const available = [{ name: 'a', digest: '', description: null }];
  const merged = mergeSkills([], [], available, []);
  assert.deepEqual(merged.loaded, []);
  assert.deepEqual(merged.available.map((s) => s.name), ['a']);
});

/* ============================================================
   ui(state)
   ============================================================ */

const STATE_PAYLOAD = {
  v: 1,
  t: 'ui',
  kind: 'state',
  todos: [
    { content: 'read the spec', status: 'completed' },
    { content: 'write the adapter', status: 'in_progress' },
  ],
  skills: [{ name: 'pdf-tools', digest: 'ab12' }],
  skill_catalog: [{ name: 'pdf-tools', description: 'work with PDFs' }],
  jobs: [
    { id: 'j1', command: 'npm test', state: 'uncollected', seconds: 45, exit_code: 0 },
    { id: 'j2', command: 'sleep 900', state: 'running', seconds: 12, exit_code: null },
    { id: 'j3', command: 'ls', state: 'done', seconds: 1, exit_code: 0 },
    { id: 'j4', command: 'bad', state: 'killed', seconds: 3, exit_code: null },
  ],
  subagents: [
    {
      id: 'sub-1',
      label: 'survey',
      model: 'deepseek-chat',
      provider: 'deepseek',
      depth: 1,
      seconds: 7,
      steps: 3,
      tool_calls: 5,
      activity: 'reading files',
    },
  ],
  messages: 42,
  steps: 11,
  model: 'deepseek-chat',
  model_provider: 'deepseek',
  model_window: 65536,
  thinking: false,
  effort: 'high',
  effort_levels: ['low', 'high'],
  autopilot: true,
  granted_tools: ['read_file'],
  granted_prefixes: ['git add'],
  denied_tools: ['shell'],
  risk_scope: [
    { risk: 'low', disposition: 'auto' },
    { risk: 'medium', disposition: 'ask' },
    { risk: 'high', disposition: 'ask' },
  ],
  agents_md: [{ path: 'AGENT.md', lines: 12, status: 'loaded' }],
  mcp: [
    { name: 'fs', state: 'loaded', tools: 12, where: 'npx fs-server' },
    { name: 'web', state: 'unload', tools: 0, where: 'https://example.test' },
    { name: 'db', state: 'failed', tools: 0, where: 'npx db-server', error: 'handshake failed' },
  ],
  goal: {
    id: 'g1',
    objective: 'fix the reconnect',
    phase: 'active',
    revision: 2,
    rounds: 3,
    max_rounds: 60,
    rounds_text: '3/60',
    limit_reached: false,
    armed: true,
    blocked_code: '',
    blocked_message: '',
  },
  // The workspace's terminals ride on **every** snapshot, and this one carries a
  // row so the projection has something to pass through.
  terminals: [
    {
      id: 'term-01',
      workspace: '/ws',
      cwd: '',
      shell: 'powershell',
      pid: 1234,
      status: 'running',
      exit_code: null,
      created_at: 0,
      cols: 80,
      rows: 24,
    },
  ],
};

test('ui(state) projects every block the sidebar and the bar read', () => {
  const state = projectState(STATE_PAYLOAD as never);

  assert.equal(state.todos.length, 2);
  assert.equal(state.todos[1].status, 'in_progress');

  // Two sources merged: pointers from the snapshot, description from the catalog.
  assert.equal(state.skills.length, 1);
  assert.equal(state.skills[0].name, 'pdf-tools');
  assert.equal(state.skills[0].digest, 'ab12');
  assert.equal(state.skills[0].description, 'work with PDFs');

  assert.equal(state.messages, 42);
  assert.equal(state.steps, 11);
  assert.equal(state.model, 'deepseek-chat');
  assert.equal(state.modelProvider, 'deepseek');
  assert.equal(state.modelWindow, 65536);
  assert.equal(state.thinking, false);
  // Present even though thinking is off: that is the user's intent.
  assert.equal(state.effort, 'high');
  assert.equal(state.autopilot, true);

  assert.equal(state.goal.present, true);
  assert.equal(state.goal.roundsText, '3/60');
  assert.equal(state.goal.armed, true);

  // The runtime computed which risks are asked about; nothing here assumes that
  // "low is the default".
  assert.deepEqual(
    state.riskScope.map((row) => `${row.risk}:${row.disposition}`),
    ['low:auto', 'medium:ask', 'high:ask'],
  );

  // **The workspace's terminals ride on the snapshot too**, and this assertion is
  // the whole point of the field. `ui(state)` carries the full list precisely so
  // that a front end which started *after* a shell existed — or which simply lost
  // a message — learns about it from the next snapshot instead of never. The
  // field was declared on the wire type and projected nowhere, so the promise was
  // empty: the bucket's list only ever changed when somebody opened the panel.
  assert.equal(state.terminals.length, 1);
  assert.equal(state.terminals[0].id, 'term-01');
  assert.equal(state.terminals[0].status, 'running');
});

test('job states are carried through, and `uncollected` is the loud one', () => {
  const jobs = projectJobs(STATE_PAYLOAD.jobs as never);
  assert.equal(jobs.length, 4);

  const byId = new Map(jobs.map((job) => [job.id, job]));
  // The two that mean "somebody still has to look at this".
  assert.equal(byId.get('j1')?.outstanding, true);
  assert.equal(byId.get('j1')?.uncollected, true);
  assert.equal(byId.get('j2')?.outstanding, true);
  assert.equal(byId.get('j2')?.uncollected, false);
  assert.equal(byId.get('j3')?.outstanding, false);
  assert.equal(byId.get('j4')?.outstanding, false);

  // A null exit code stays null: the process has not exited, which is not 0.
  assert.equal(byId.get('j2')?.exitCode, null);
  assert.equal(byId.get('j3')?.exitCode, 0);
});

test('the three MCP states stay three, and `where` is not invented', () => {
  const servers = projectMcp(STATE_PAYLOAD.mcp as never);
  assert.deepEqual(
    servers.map((server) => server.state),
    ['loaded', 'unload', 'failed'],
  );
  assert.equal(servers[0].tools, 12);
  assert.equal(servers[1].where, 'https://example.test');
  // `error` only exists on a failed row.
  assert.equal(servers[0].error, null);
  assert.equal(servers[2].error, 'handshake failed');
});

test('an empty goal shape is how the runtime says "there is none"', () => {
  const state = projectState({
    ...STATE_PAYLOAD,
    goal: { id: '', objective: '', phase: '', armed: false },
  } as never);
  assert.equal(state.goal.present, false);
  assert.equal(state.goal.objective, '');
});

/* ============================================================
   status / context / tools / sessions
   ============================================================ */

test('status is grouped, and usage lives there rather than in the snapshot', () => {
  const status = projectStatus({
    v: 1,
    t: 'ui',
    kind: 'status',
    status: {
      session: { id: 's-1', resumed: false, workspace: 'C:/w', messages: 42, steps: 11 },
      model: {
        provider: 'deepseek',
        current: 'deepseek-chat',
        selected: 'deepseek-chat',
        last_used: 'deepseek-chat',
        since: 0,
        window: 65536,
        base_url: 'https://api',
        reasoning: { thinking: true, effort: 'high' },
      },
      counters: { runs: 3, model_calls: 9, model_ok: 8, tool_calls: 12, permission_waits: 1, asks: 0 },
      usage: { prompt: 1000, cached: 750, miss: 250, completion: 300, model_ms: 4200 },
      context: null,
      meta: {
        max_steps: 120,
        stream: true,
        autopilot: false,
        tool_count: 9,
        audit_path: 'C:/w/.tudouni/a.jsonl',
        permissions: {},
        started: 'started: new',
        catalog: 'C:/w/.tudouni/models.json',
      },
    },
    last_prompt_tokens: 1000,
    context_tokens: 65536,
  } as never);

  assert.equal(status.counters.tool_calls, 12);
  assert.equal(status.usage.prompt, 1000);
  assert.equal(status.lastPromptTokens, 1000);
  assert.equal(status.window, 65536);
  assert.equal(status.meta?.tool_count, 9);

  // The cache rate is computed from usage, and an em dash when nothing has been
  // sent: "no lookup yet" and "the cache is broken" are different statements.
  assert.equal(cacheHitRate(status.usage), 0.75);
  assert.equal(cacheHitRate({ prompt: 0, cached: 0 }), null);
});

test('the whole context payload is nested, ledger and window alike', () => {
  // The real payload (`internal/runtime/composition.go` `contextPayload`), as
  // captured in `tests/fixtures/opening.jsonl`: the message carries one
  // `context` container, the ledger is `context.context`, and `window` /
  // `messages` sit **beside the ledger on that same container**.
  //
  // The fixture here used to be flat, which is how the implementation and its
  // test managed to agree on a shape the runtime never sends. An earlier attempt
  // at this fix put `window`/`messages` on the message itself — also wrong, and
  // the contract test caught it.
  const withWindow = projectContext({
    v: 1,
    t: 'ui',
    kind: 'context',
    context: {
      context: {
        estimated_tokens: 32768,
        limit_tokens: 60000,
        artifacts: 4,
        items: 9,
        degraded: 2,
      },
      window: 65536,
      messages: 42,
      active: false,
      folded: 3,
    },
  } as never);
  assert.equal(withWindow.present, true);
  assert.equal(withWindow.used, 32768);
  assert.equal(withWindow.limitTokens, 60000);
  assert.equal(withWindow.artifacts, 4);
  // `degraded` is a count on the wire, not a flag.
  assert.equal(withWindow.degraded, 2);
  assert.equal(withWindow.window, 65536);
  assert.equal(withWindow.messages, 42);
  assert.equal(withWindow.active, false);
  assert.equal(withWindow.folded, 3);
  assert.equal(withWindow.percent, 0.5);

  const withoutWindow = projectContext({
    v: 1,
    t: 'ui',
    kind: 'context',
    context: { context: { estimated_tokens: 32768 } },
  } as never);
  assert.equal(withoutWindow.used, 32768);
  // A wrong percentage is worse than no percentage.
  assert.equal(withoutWindow.percent, null);
  assert.equal(withoutWindow.window, null);
  // The ledger did not say, so it is unknown — not "nothing was degraded".
  // (`Stats()` always sends the key; a fixture that omits it must read as null.)
  assert.equal(withoutWindow.degraded, null);
});

test('a missing context object is not a row of zeroes', () => {
  const context = projectContext({ v: 1, t: 'ui', kind: 'context' } as never);
  assert.equal(context.present, false);
  assert.equal(context.used, null);
  assert.equal(context.artifacts, null);
  assert.equal(context.degraded, null);

  // An empty container is the other way the runtime says the same thing: the
  // feature object is present but carries no ledger.
  const emptyFeature = projectContext({
    v: 1,
    t: 'ui',
    kind: 'context',
    context: { window: 1048576, messages: 1 },
  } as never);
  assert.equal(emptyFeature.present, false);
  assert.equal(emptyFeature.used, null);
  // The container's own facts still travel, so window/messages stay readable.
  assert.equal(emptyFeature.window, 1048576);
  assert.equal(emptyFeature.messages, 1);
});

test('tools carry the runtime-computed disposition', () => {
  const tools = projectTools([
    {
      name: 'shell',
      risk: 'high',
      disposition: 'ask',
      parallel_safe: false,
      interactive: false,
      external: false,
      granted: false,
      command: 'command',
    },
    {
      name: 'read_file',
      risk: 'low',
      disposition: 'auto',
      parallel_safe: true,
      interactive: false,
      external: false,
      granted: true,
      command: null,
    },
  ] as never);

  assert.equal(tools[0].disposition, 'ask');
  assert.equal(tools[0].command, 'command');
  assert.equal(tools[1].disposition, 'auto');
  assert.equal(tools[1].granted, true);
  assert.equal(tools[1].command, null);
});

test('session rows keep the runtime order and read modified_at as seconds', () => {
  const items = projectSessionList([
    { session_id: 's-2', messages: 10, steps: 3, todos: '1/4', preview: 'hi', modified_at: 1790000000 },
    { session_id: 's-1', messages: 0, steps: 0, todos: '', preview: '', modified_at: null },
  ] as never);

  // The order is the runtime's (creation time, newest first) and is not re-sorted:
  // `modified_at` is a different fact from the sort key.
  assert.deepEqual(items.map((item) => item.id), ['s-2', 's-1']);
  assert.equal(items[0].modifiedAt, 1790000000);
  assert.equal(items[1].modifiedAt, null);
  assert.equal(items[1].todos, '');
});

/* ============================================================
   events -> stream entries
   ============================================================ */

function freshOptions(overrides: Partial<Parameters<typeof reduceEvent>[2]> = {}) {
  return {
    activeRunId: 'r1' as string | null,
    lastRunId: null as string | null,
    lookup: () => ({ risk: 'high' as const, parallelSafe: false, interactive: false, external: false }),
    maxSteps: 120,
    ...overrides,
  };
}

function ev(kind: string, extra: Record<string, unknown> = {}): LooseEvent {
  return {
    v: 1,
    t: 'event',
    kind,
    session_id: 's-1',
    run_id: 'r1',
    step: 0,
    ts: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

test('run_started opens a turn; run_finished closes it with its stop reason', () => {
  let entries: Entry[] = [];
  let result = reduceEvent(entries, ev('run_started', { model: 'm', provider: 'p' }), freshOptions({ activeRunId: null }));
  entries = result.entries;
  assert.equal(result.startedRunId, 'r1');
  assert.equal(entries[0].kind, 'turn');
  assert.equal((entries[0] as Extract<Entry, { kind: 'turn' }>).status, 'running');

  // The turn head's step follows the events arriving for it.
  result = reduceEvent(entries, ev('model_call', { status: 'ok', duration_ms: 900, prompt_tokens: 1000, cached_tokens: 700 }), freshOptions());
  entries = result.entries;
  assert.equal((entries[0] as Extract<Entry, { kind: 'turn' }>).step, 0);

  result = reduceEvent(entries, ev('model_call', { status: 'ok', step: 2 }), freshOptions());
  entries = result.entries;
  assert.equal((entries[0] as Extract<Entry, { kind: 'turn' }>).step, 2);

  result = reduceEvent(entries, ev('run_finished', { stop_reason: 'max_steps', duration_ms: 5000, step: 2 }), freshOptions());
  entries = result.entries;
  assert.equal(result.runEnded, true);
  assert.equal(result.stopReason, 'max_steps');
  assert.equal(lastStopReason(entries), 'max_steps');
});

test('a late event is dropped and counted, not drawn', () => {
  const entries: Entry[] = [];
  // The current run is r1; this belongs to r0.
  const result = reduceEvent(entries, ev('model_call', { status: 'ok', run_id: 'r0' }), freshOptions());
  assert.equal(result.stale, true);
  assert.equal(result.entries.length, 0);
});

/**
 * The guard only applies to the kinds whose `run_id` identifies a turn.
 *
 * The session-level records carry `""` (pictures, compaction, goal rounds) or
 * the **child's** id (delegation, being the parent's account of having
 * delegated). From the second turn on, `"" !== lastRunId` is always true — so
 * applying the turn rule to them silently deleted every one of these rows.
 */
test('session-level events survive the second turn, where turn-scoped ones do not', () => {
  // The state the store is in between turns: no active run, one just finished.
  const between: Partial<Parameters<typeof reduceEvent>[2]> = {
    activeRunId: null,
    lastRunId: 'r1',
  };

  const sessionLevel: Array<[string, Record<string, unknown>]> = [
    ['image_attached', { status: 'skipped', path: 'a.png', reason: 'too large' }],
    ['image_attached', { status: 'refused', names: ['a.png'], model: 'gpt-x' }],
    ['image_attached', { status: 'over_limit', limit: 8, rest: 3, paths: ['b.png'] }],
    ['context_compacted', { folded: 4, folded_total: 9, step: 3 }],
    ['goal_round', { goal_present: true, goal_phase: 'active', round: 2 }],
    ['delegation_started', { child_id: 'c1' }],
    ['delegation_finished', { child_id: 'c1' }],
    ['subagent_started', { id: 'c1' }],
    ['subagent_problem', { id: 'c1', problem: 'could not write its session' }],
  ];

  for (const [kind, extra] of sessionLevel) {
    const result = reduceEvent([], ev(kind, { run_id: '', ...extra }), freshOptions(between));
    assert.equal(result.stale, undefined, `${kind} was wrongly counted as late`);
  }

  // The delegation records carry the child's id, not the parent's turn.
  for (const kind of ['delegation_started', 'delegation_finished']) {
    const result = reduceEvent([], ev(kind, { run_id: 'child-9' }), freshOptions(between));
    assert.equal(result.stale, undefined, `${kind} with a child id was wrongly dropped`);
  }

  // A turn-scoped kind from another turn is still late, so the rule is not gone.
  const late = reduceEvent([], ev('model_call', { status: 'ok', run_id: 'r0' }), freshOptions(between));
  assert.equal(late.stale, true);
});

test('tool_call and tool_result pair by run_id + step + tool_index', () => {
  let entries: Entry[] = [];
  entries = reduceEvent(
    entries,
    ev('tool_call', { tool: 'shell', call_id: 'c1', tool_index: 2, arguments: '{"command":"rm -rf /"}' }),
    freshOptions(),
  ).entries;

  const tool = entries[0] as Extract<Entry, { kind: 'tool' }>;
  assert.equal(tool.index, 2);
  assert.equal(tool.callId, 'c1');
  // The risk is a registry fact looked up by name, not a field on the event.
  assert.equal(tool.risk, 'high');
  assert.equal(tool.result, null);

  entries = reduceEvent(
    entries,
    ev('tool_result', { tool: 'shell', call_id: 'c1', tool_index: 2, status: 'ok', chars: 12, duration_ms: 40, exit_code: 0 }),
    freshOptions(),
  ).entries;

  const withResult = entries[0] as Extract<Entry, { kind: 'tool' }>;
  assert.equal(withResult.result?.status, 'ok');
  assert.equal(withResult.result?.exitCode, 0);
  assert.equal(entries.length, 1);
});

test('a denial becomes its own row, separate from a failure', () => {
  let entries: Entry[] = [];
  entries = reduceEvent(
    entries,
    ev('tool_call', { tool: 'shell', call_id: 'c1', tool_index: 0, arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { tool: 'shell', call_id: 'c1', tool_index: 0, status: 'denied', chars: 0, duration_ms: 0 }),
    freshOptions(),
  ).entries;

  // Both rows exist: the call row shows nothing ran, and the denial says so in
  // its own line.
  assert.equal(entries.filter((entry) => entry.kind === 'tool').length, 1);
  const denied = entries.find((entry) => entry.kind === 'denied');
  assert.ok(denied);
  assert.equal((denied as Extract<Entry, { kind: 'denied' }>).tool, 'shell');
});

test('a tool_result with no matching call still becomes a row', () => {
  const entries = reduceEvent(
    [],
    ev('tool_result', { tool: 'read_file', call_id: 'c9', tool_index: 0, status: 'error', chars: 3, duration_ms: 1 }),
    freshOptions(),
  ).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'tool');
  assert.equal((entries[0] as Extract<Entry, { kind: 'tool' }>).result?.status, 'error');
});

test('a permission verdict without waited_ms means nobody was asked', () => {
  const entries = reduceEvent(
    [],
    ev('permission', { tool: 'shell', risk: 'high', decision: 'allow', outcome: 'auto_allowed', arguments: '{}' }),
    freshOptions(),
  ).entries;
  const perm = entries[0] as Extract<Entry, { kind: 'perm' }>;
  // A verdict is written for every call; `waited_ms` is the field that says a
  // person was actually interrupted.
  assert.equal(perm.waitedMs, null);
  assert.equal(perm.outcome, 'auto_allowed');
  assert.equal(perm.rule, null);
});

test('model_call.reasoning replaces a streamed thinking block in full', () => {
  let entries: Entry[] = [];
  // Streamed first, in pieces.
  entries = applyDelta(entries, 'r1', 0, 'reasoning', 'let me ', 'r1', null).entries;
  entries = applyDelta(entries, 'r1', 0, 'reasoning', 'think', 'r1', null).entries;
  assert.equal((entries[0] as Extract<Entry, { kind: 'reason' }>).text, 'let me think');
  assert.equal((entries[0] as Extract<Entry, { kind: 'reason' }>).streaming, true);

  // Then the audit's complete copy arrives.
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', reasoning: 'let me think carefully' }),
    freshOptions(),
  ).entries;

  const reasons = entries.filter((entry) => entry.kind === 'reason');
  assert.equal(reasons.length, 1, 'the streamed block is replaced, not duplicated');
  assert.equal((reasons[0] as Extract<Entry, { kind: 'reason' }>).text, 'let me think carefully');
  assert.equal((reasons[0] as Extract<Entry, { kind: 'reason' }>).streaming, false);
});

/* ============================================================
   delta
   ============================================================ */

test('delta is routed by channel, never guessed', () => {
  let entries: Entry[] = [];
  entries = applyDelta(entries, 'r1', 0, 'text', 'the answer', 'r1', null).entries;
  entries = applyDelta(entries, 'r1', 0, 'reasoning', 'the thinking', 'r1', null).entries;

  const stream = entries.find((entry) => entry.kind === 'stream') as Extract<Entry, { kind: 'stream' }>;
  const reason = entries.find((entry) => entry.kind === 'reason') as Extract<Entry, { kind: 'reason' }>;
  // Crossing them would put the model thinking out loud into the answer.
  assert.equal(stream.text, 'the answer');
  assert.equal(reason.text, 'the thinking');
});

test('delta text accumulates: each piece is the new part, not the whole', () => {
  let entries: Entry[] = [];
  entries = applyDelta(entries, 'r1', 0, 'text', 'Hello', 'r1', null).entries;
  entries = applyDelta(entries, 'r1', 0, 'text', ', world', 'r1', null).entries;
  const stream = entries[0] as Extract<Entry, { kind: 'stream' }>;
  assert.equal(stream.text, 'Hello, world');
});

test('a late delta is dropped', () => {
  const result = applyDelta([], 'r0', 0, 'text', 'stale', 'r1', null);
  assert.equal(result.stale, true);
  assert.equal(result.entries.length, 0);
});

test('delta_reset clears one step and leaves the earlier ones alone', () => {
  let entries: Entry[] = [];
  entries = applyDelta(entries, 'r1', 0, 'text', 'step zero', 'r1', null).entries;
  entries = applyDelta(entries, 'r1', 1, 'text', 'step one', 'r1', null).entries;
  assert.equal(entries.length, 2);

  entries = clearStream(entries, 'r1', 1, 'text');
  // Step 0 was already settled and a retry of step 1 must not erase it.
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as Extract<Entry, { kind: 'stream' }>).text, 'step zero');
});

/* ============================================================
   the answer's two exits
   ============================================================ */

test('the final answer replaces the streamed body instead of doubling it', () => {
  let entries: Entry[] = [];
  entries = applyDelta(entries, 'r1', 0, 'text', 'partial', 'r1', null).entries;
  entries = applyDelta(entries, 'r1', 0, 'reasoning', 'thinking', 'r1', null).entries;

  entries = applyFinalAnswer(entries, 'r1', 'the complete answer');

  // One answer row, and no leftover streamed body to render twice.
  assert.equal(entries.filter((entry) => entry.kind === 'answer').length, 1);
  assert.equal(entries.filter((entry) => entry.kind === 'stream').length, 0);
  // The reasoning block survives, folded.
  const reason = entries.find((entry) => entry.kind === 'reason') as Extract<Entry, { kind: 'reason' }>;
  assert.equal(reason.text, 'thinking');
  assert.equal(reason.streaming, false);
});

test('an empty answer leaves the streamed body on screen', () => {
  // Every abnormal exit produces an empty answer: Esc, the step limit, a model
  // error, an empty response. The runtime forwards the empty string unchanged
  // (`internal/agent/agent.go`), and deleting the streamed rows here used to
  // erase half a written answer at exactly the moment the reader wanted it.
  let entries: Entry[] = [];
  entries = reduceEvent(entries, ev('run_started'), freshOptions({ activeRunId: null })).entries;
  entries = applyDelta(entries, 'r1', 0, 'text', 'I was halfway through explain', 'r1', null).entries;

  const after = applyFinalAnswer(entries, 'r1', '');

  const stream = after.find((entry) => entry.kind === 'stream') as Extract<Entry, { kind: 'stream' }>;
  assert.equal(stream.text, 'I was halfway through explain');
  // The caret stops, so the row does not keep claiming to be live.
  assert.equal(stream.streaming, false);
  // No empty answer row is appended — a row with nothing in it is not content.
  assert.equal(after.filter((entry) => entry.kind === 'answer').length, 0);
  // The head is still closed, so the phase does not stay "Running".
  assert.equal(hasRunningTurn(after), false);
});

test('an empty answer settles the streamed thinking too', () => {
  let entries: Entry[] = [];
  entries = applyDelta(entries, 'r1', 0, 'reasoning', 'still thinking', 'r1', null).entries;
  const after = applyFinalAnswer(entries, 'r1', '');
  const reason = after.find((entry) => entry.kind === 'reason') as Extract<Entry, { kind: 'reason' }>;
  assert.equal(reason.text, 'still thinking');
  assert.equal(reason.streaming, false);
});

test('a runtime that dies mid-turn does not leave the turn running', () => {
  let entries: Entry[] = [];
  entries = reduceEvent(entries, ev('run_started'), freshOptions({ activeRunId: null })).entries;
  entries = applyDelta(entries, 'r1', 0, 'text', 'half an answer', 'r1', null).entries;
  assert.equal(hasRunningTurn(entries), true);

  const settled = settleAbandonedTurn(entries);
  assert.equal(hasRunningTurn(settled), false);
  // The reason is the runtime's disappearance, which reads as its own phase
  // rather than as "Done" or "Failed".
  assert.equal(lastStopReason(settled), 'runtime_exited');
  assert.equal(phaseFromStopReason(lastStopReason(settled) ?? ''), 'runtime_gone');
  // The text is kept: only the caret stops.
  const stream = settled.find((entry) => entry.kind === 'stream') as Extract<Entry, { kind: 'stream' }>;
  assert.equal(stream.text, 'half an answer');
  assert.equal(stream.streaming, false);
});

test('an answer closes a turn the event did not close', () => {
  // The two `run_finished` messages are not ordered, so an answer can arrive
  // with no matching event. Leaving the head open would make the status bar read
  // "Running" over a finished answer.
  let entries: Entry[] = [];
  entries = reduceEvent(entries, ev('run_started'), freshOptions({ activeRunId: null })).entries;
  assert.equal((entries[0] as Extract<Entry, { kind: 'turn' }>).status, 'running');

  entries = applyFinalAnswer(entries, 'r1', 'done');
  assert.equal((entries[0] as Extract<Entry, { kind: 'turn' }>).status, 'answered');
  assert.equal(lastStopReason(entries), 'answered');
  assert.equal(hasRunningTurn(entries), false);

  // And the real reason still wins when the event does land, in either order.
  entries = reduceEvent(entries, ev('run_finished', { stop_reason: 'max_steps' }), freshOptions()).entries;
  assert.equal(lastStopReason(entries), 'max_steps');
});

/* ============================================================
   the status bar's live figures
   ============================================================ */

/**
 * The bar's usage numbers move per **step**, not per turn.
 *
 * They used to come only from `ui(status)`, which is requested when a turn ends
 * (decision 5 — `status` reads the audit log and must not become a heartbeat), so
 * a long turn sat on the previous turn's figures and then jumped; a turn that
 * grew to 300k tokens showed the whole jump at once. The `model_call` event
 * carries the same four fields, so the last successful call is read off the
 * stream as it lands. `status` stays the fallback for a session whose calls this
 * window never saw.
 */
test('a successful model call feeds the bar directly, before any status arrives', () => {
  captureOutbound();
  resetStore();
  applyInit();
  assert.equal(rt().status, null, 'nothing has been asked for yet');

  useApp.getState().applyRuntimeMessage(KEY, ev('run_started'));
  useApp.getState().applyRuntimeMessage(
    KEY,
    ev('model_call', {
      status: 'ok',
      prompt_tokens: 12400,
      cached_tokens: 10900,
      completion_tokens: 190,
      duration_ms: 5000,
    }),
  );

  const usage = selectUsage(useApp.getState(), KEY);
  // The provider's own count for that call — no `status` round trip involved.
  assert.equal(usage.used, 12400);
  assert.equal(usage.cacheHitRate, 10900 / 12400);
  // And it says which question the ratio answers: one call's, not the session's.
  assert.equal(usage.cacheScope, 'call');

  // And the next step's figures replace them whole.
  useApp.getState().applyRuntimeMessage(
    KEY,
    ev('model_call', { status: 'ok', step: 2, prompt_tokens: 20000, cached_tokens: 20000 }),
  );
  const next = selectUsage(useApp.getState(), KEY);
  assert.equal(next.used, 20000);
  assert.equal(next.cacheHitRate, 1);
});

/**
 * A retry attempt carries no usage block, and it must not blank the bar.
 *
 * The same rule the reference front end states for its own four fields
 * (`TestAFailedAttemptLeavesTheLastGoodMeasurementStanding`): all four are "the
 * last **successful** call", so a backoff between two attempts leaves the
 * previous figures standing rather than replacing a real measurement with
 * nothing.
 */
test('a failed attempt leaves the last good measurement standing', () => {
  captureOutbound();
  resetStore();
  applyInit();

  useApp.getState().applyRuntimeMessage(
    KEY,
    ev('model_call', { status: 'ok', prompt_tokens: 12400, cached_tokens: 10900 }),
  );
  const good = selectUsage(useApp.getState(), KEY);

  useApp.getState().applyRuntimeMessage(
    KEY,
    ev('model_call', { status: 'error', attempt: 1, backoff_ms: 500 }),
  );
  assert.deepEqual(selectUsage(useApp.getState(), KEY), good);
});

/**
 * A **successful** call that reports no usage clears the figure.
 *
 * This is what makes the record describe one call by construction. A gateway that
 * refuses `stream_options` reports no usage on a streamed call, and recycling the
 * previous step's count into this step's row would be a number nothing measured.
 */
test('a successful call with no usage block clears the figure rather than reusing one', () => {
  captureOutbound();
  resetStore();
  applyInit();

  useApp.getState().applyRuntimeMessage(
    KEY,
    ev('model_call', { status: 'ok', prompt_tokens: 12400, cached_tokens: 10900 }),
  );
  assert.equal(selectUsage(useApp.getState(), KEY).used, 12400);

  useApp.getState().applyRuntimeMessage(
    KEY,
    ev('model_call', { status: 'ok', step: 2, duration_ms: 4000 }),
  );
  const usage = selectUsage(useApp.getState(), KEY);
  assert.equal(usage.used, null, 'the previous call\'s count must not be recycled');
  assert.equal(usage.cacheHitRate, null);
});

/**
 * A session whose calls this window never saw still reports from `status`.
 *
 * A `/resume`d conversation rebuilds its transcript from the session file rather
 * than replaying the events, so there is no `model_call` to read — and the
 * `status` screen is the only thing that knows what the last request sent.
 */
test('with no call seen this session, the numbers fall back to status', () => {
  captureOutbound();
  resetStore();
  applyInit();
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'status',
    status: {
      session: { id: 's-1', resumed: true, workspace: 'C:/w', messages: 42, steps: 11 },
      model: { provider: 'p', current: 'm', selected: 'm', last_used: 'm', since: 0, window: 65536, base_url: '', reasoning: { thinking: true, effort: 'high' } },
      counters: {},
      usage: { prompt: 1000, cached: 750 },
      context: null,
      meta: { max_steps: 120, stream: true, autopilot: false, tool_count: 9, audit_path: 'a.jsonl', permissions: {}, started: '', catalog: '' },
    },
    last_prompt_tokens: 1000,
    context_tokens: 65536,
  } as never);

  const usage = selectUsage(useApp.getState(), KEY);
  assert.equal(usage.used, 1000);
  // The session totals' ratio, which is the shape `status.usage` has — and it is
  // reported as such, so the chip cannot label a session average "last call".
  assert.equal(usage.cacheHitRate, 0.75);
  assert.equal(usage.cacheScope, 'session');
});

/**
 * The elapsed figure moves **while** a turn runs, and freezes when it ends.
 *
 * The runtime sends no duration until `run_finished`, so a running turn is timed
 * against the local stamp the reducer took. Drawing `Date.now() - startedAt`
 * after the turn ended would keep a finished turn's duration climbing for as long
 * as the screen is left open — which is why the finished case reads
 * `lastTurnMs` instead.
 */
test('a running turn is timed against the local clock, and a finished one is frozen', () => {
  captureOutbound();
  resetStore();
  applyInit();

  assert.equal(selectTurnMs(useApp.getState(), KEY, Date.now()), null, 'no turn, no duration');

  useApp.getState().applyRuntimeMessage(KEY, ev('run_started'));
  const head = rt().entries.find((entry) => entry.kind === 'turn') as Extract<Entry, { kind: 'turn' }>;
  assert.ok(head, 'run_started opens a turn head');
  const startedAt = head.startedAt;
  assert.equal(typeof startedAt, 'number');

  // A clock reading four seconds later reports four seconds.
  assert.equal(selectTurnMs(useApp.getState(), KEY, startedAt + 4000), 4000);

  // The turn ends with the runtime's own measurement, and the local clock stops
  // being consulted: two readings a minute apart give the same answer.
  useApp.getState().applyRuntimeMessage(KEY, ev('run_finished', { stop_reason: 'answered', duration_ms: 2500 }));
  assert.equal(selectTurnMs(useApp.getState(), KEY, startedAt + 5000), 2500);
  assert.equal(selectTurnMs(useApp.getState(), KEY, startedAt + 65000), 2500);
});

/* ============================================================
   images and context traces
   ============================================================ */

/** Pull the single note a one-event reduction produced. */
function noteOf(kind: string, extra: Record<string, unknown> = {}): Extract<Entry, { kind: 'note' }> {
  const entry = reduceEvent([], ev(kind, extra), freshOptions()).entries[0];
  assert.equal(entry?.kind, 'note');
  return entry as Extract<Entry, { kind: 'note' }>;
}

test('image_attached renders in its four shapes, with the keys each one really sends', () => {
  // `attached` — `name` / `path` / `width` / `height` (internal/runtime/images.go).
  const attached = noteOf('image_attached', {
    artifact_id: 'a1',
    name: 'shot.png',
    path: 'docs/shot.png',
    width: 800,
    height: 600,
    bytes: 1000,
  });
  assert.equal(attached.tone, 'image');
  assert.match(attached.text, /shot\.png/);
  assert.match(attached.text, /800×600/);

  // `skipped` — `path` + `reason`, the runtime's own sentence for the file.
  const skipped = noteOf('image_attached', {
    path: 'big.png',
    status: 'skipped',
    reason: 'too large',
  });
  assert.equal(skipped.tone, 'error');
  assert.match(skipped.text, /big\.png/);
  assert.match(skipped.text, /too large/);

  // `refused` — `names[]` + `model`, and **no** `path` / `reason`: the sentence
  // is written to stderr by the runtime, and stderr is not protocol content. A
  // read of `path`/`reason` here used to produce " was not attached" — a line
  // that looked normal and said nothing.
  const refused = noteOf('image_attached', {
    status: 'refused',
    names: ['a.png', 'b.png'],
    model: 'deepseek-chat',
  });
  assert.equal(refused.tone, 'error');
  assert.match(refused.text, /a\.png/);
  assert.match(refused.text, /b\.png/);
  assert.match(refused.text, /deepseek-chat/);

  // `over_limit` — `limit` / `rest` / `paths[]`: the runtime names them on
  // purpose, because "4 of 9 attached" leaves the reader to guess which four.
  const overLimit = noteOf('image_attached', {
    status: 'over_limit',
    limit: 5,
    rest: 4,
    paths: ['a.png', 'b.png'],
  });
  assert.equal(overLimit.tone, 'error');
  assert.match(overLimit.text, /limit 5/);
  assert.match(overLimit.text, /b\.png/);
});

test('an unknown event kind is ignored rather than fatal', () => {
  const entries: Entry[] = [];
  const result = reduceEvent(entries, ev('something_new', { whatever: 1 }), freshOptions());
  assert.equal(result.entries.length, 0);
  assert.equal(result.stale, undefined);
});

test('phase mapping keeps the distinctions a reader acts on', () => {
  assert.equal(phaseFromStopReason('max_steps'), 'step_limit');
  assert.equal(phaseFromStopReason('cancelled'), 'interrupted');
  assert.equal(phaseFromStopReason('model_error'), 'failed');
  assert.equal(phaseFromStopReason('model_fatal'), 'failed');
  assert.equal(phaseFromStopReason('answered'), 'done');
  assert.equal(phaseFromStopReason('completed'), 'done');
});

/* ============================================================
   session history
   ============================================================ */

test('history reads role and content, and tolerates both content shapes', () => {
  const history = projectHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    { role: 'system', content: 'not shown' },
    { role: 'assistant', content: 42 },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
  ] as never);

  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].text, 'hello');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].text, 'hi there');
});

/* ============================================================
   the store: runtime facts vs. front-end preferences
   ============================================================ */

/**
 * The key the fake child is registered under.
 *
 * Every runtime fact is stored per session now, so a test needs a session before
 * it can assert anything about one — and "which session was this sent to" is
 * itself part of what several of these tests are checking.
 */
const KEY = 'k-1';

/**
 * Capture what the store tries to send **to this session**.
 *
 * A handle is registered for `KEY` rather than a single global runtime, which is
 * the shape the real bridge has: one child per conversation, addressed by key.
 * A message that went to a different key would not appear here, and that is the
 * point — misdirecting a `user_message` is the failure this build has to make
 * impossible.
 */
function captureOutbound(): FrontendMsg[] {
  const sent: FrontendMsg[] = [];
  registerRuntime({
    key: KEY,
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

/** Install one session and clear the window-level state around it. */
function resetStore(): void {
  useApp.setState({
    sessions: {
      [KEY]: createSessionBucket(KEY, 'C:/work', { ericai: false, maxSteps: null }),
    },
    order: [KEY],
    activeKey: KEY,
    modal: null,
    pendingModals: [],
    panel: null,
  });
}

/** The session being shown, with "there is one" folded into the assertion. */
function rt(): SessionRuntime {
  const bucket = activeRuntime(useApp.getState());
  assert.ok(bucket, 'a session must be installed');
  return bucket;
}

/** Feed the handshake, with the caller's overrides on top of the fixture. */
function applyInit(overrides: Record<string, unknown> = {}, key = KEY): void {
  useApp.getState().applyRuntimeMessage(key, { ...INIT_PAYLOAD, ...overrides } as never);
}

test('every outbound message carries the envelope version', () => {
  const sent = captureOutbound();
  resetStore();

  useApp.getState().setThinking(true);
  useApp.getState().setAutopilot(true);
  useApp.getState().chooseEffort('high');
  useApp.getState().chooseModel('deepseek/deepseek-chat');
  useApp.getState().interrupt();
  useApp.getState().refreshState();

  assert.ok(sent.length >= 5);
  for (const msg of sent) {
    assert.equal(msg.v, ENVELOPE_VERSION, `${msg.t} must carry v`);
  }
});

test('absolute-state messages use `on`, not a toggle action', () => {
  const sent = captureOutbound();
  resetStore();

  useApp.getState().setThinking(true);
  useApp.getState().setAutopilot(false);

  assert.deepEqual(sent[0], { v: 1, t: 'set_thinking', on: true });
  assert.deepEqual(sent[1], { v: 1, t: 'set_autopilot', on: false });
});

test('this front end never switches a session in place', async () => {
  const sent = captureOutbound();
  resetStore();
  applyInit();

  // Decision 11 in the design was "`/new` sends no `session_id` at all, not the
  // prototype's `"__new__"` sentinel". The mechanism has changed since and the
  // point is now stronger: **the desktop front end does not send
  // `session_switch` at all.** A conversation is a process, so opening one is a
  // new child — there is no sentinel left to get wrong, because there is no
  // message.
  //
  // That matters beyond tidiness: `session_switch` makes the runtime rebuild
  // itself and call `pending.abandonAll()`, which is exactly the behaviour that
  // stopped two conversations from running at once.
  await useApp.getState().openSession(null);
  await useApp.getState().enterWorkspace('C:/work/elsewhere');

  assert.equal(
    sent.filter((msg) => msg.t === 'session_switch').length,
    0,
    'a session is a process, not something a message can move',
  );
});

test('focusing a session sends nothing and clears nothing', () => {
  const sent = captureOutbound();
  resetStore();

  // A conversation is on screen, with a transcript.
  applyInit();
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'session_load',
    messages: [{ role: 'user', content: 'the old session' }],
  } as never);
  const before = rt().entries;
  assert.ok(before.length > 0);

  // A second conversation is open beside it.
  const second = 'k-2';
  useApp.setState((s) => ({
    sessions: {
      ...s.sessions,
      [second]: createSessionBucket(second, 'C:/work', { ericai: false, maxSteps: null }),
    },
    order: [...s.order, second],
  }));
  useApp.getState().applyRuntimeMessage(second, { ...INIT_PAYLOAD, session_id: 's-2' } as never);

  // `init` asks for the session list on its way past (the first screen's four
  // recent slots), so the count is taken after the handshakes.
  const beforeCount = sent.length;
  useApp.getState().focusSession(second);

  // **This replaces the old "a switch must not clear the screen" test**, and the
  // rule is now trivial rather than delicate: focusing is local, so there is no
  // request that could fail and leave the screen blank. What used to be a
  // discipline ("do not clear optimistically") is now a property of the design.
  assert.equal(useApp.getState().activeKey, second);
  assert.equal(sent.length, beforeCount, 'focusing sends nothing');
  // And the conversation that was on screen is untouched in its own bucket.
  assert.deepEqual(useApp.getState().sessions[KEY]?.entries, before);
});

test('mcp puts the servers in an array, and is only sent because a person asked', () => {
  const sent = captureOutbound();
  resetStore();

  // Simply receiving protocol traffic must not send one: a front end that sent
  // it on its own initiative would make "the config widens itself" possible.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'state',
    ...STATE_PAYLOAD,
  } as never);
  assert.equal(sent.filter((msg) => msg.t === 'mcp').length, 0);

  useApp.getState().requestMcp('load', ['fs']);
  const mcp = sent.find((msg) => msg.t === 'mcp') as Extract<FrontendMsg, { t: 'mcp' }>;
  assert.deepEqual(mcp.servers, ['fs']);
  assert.equal(mcp.action, 'load');
});

test('a load marks the server in flight, and the runtime\'s reply releases it', () => {
  const sent = captureOutbound();
  resetStore();

  // Nothing in flight to start with — the initial value is empty, and that
  // matters: a row that began life looking like it was already waiting would
  // disable its button for a request nobody made.
  assert.deepEqual(rt().mcpPending, []);

  // A snapshot has arrived, so `fs` is on screen as running.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'state',
    ...STATE_PAYLOAD,
  } as never);

  useApp.getState().requestMcp('load', ['fs', 'web']);
  // Both named servers are marked. This is the front end's own fact ("I just
  // sent this"), not a claim about the servers — which is why it can be known
  // before the runtime has answered.
  assert.deepEqual([...rt().mcpPending].sort(), ['fs', 'web']);

  // The row's own state is untouched by the request: still whatever
  // `ui(state)` last said. Marking a server in flight must not make the screen
  // say it is up (or down) before the runtime has answered.
  assert.equal(rt().uiState?.mcp.find((s) => s.name === 'fs')?.state, 'loaded');
  assert.equal(rt().uiState?.mcp.find((s) => s.name === 'web')?.state, 'unload');

  // The runtime answers with the payload that follows an `mcp` message. That
  // reply is what releases the marks; a timer must never do it, because the
  // round trip waits the running turn out and has no fixed length.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'mcp',
    mcp_servers: [{ name: 'fs', state: 'loaded', tools: 12, where: 'npx fs-server' }],
    mcp_notes: [],
  } as never);

  assert.deepEqual(rt().mcpPending, []);
  // And the servers list is the runtime's, not the request's.
  assert.deepEqual(rt().mcp.map((s) => s.name), ['fs']);
});

test('listing is not marked in flight, because it changes nothing', () => {
  captureOutbound();
  resetStore();

  // `list` only draws the panel; marking it would grey the row's button for a
  // request that cannot change any server.
  useApp.getState().requestMcp('list', ['fs']);
  assert.deepEqual(rt().mcpPending, []);
});

test('a dead runtime releases the marks instead of leaving the button disabled forever', () => {
  captureOutbound();
  resetStore();

  useApp.getState().requestMcp('load', ['fs']);
  assert.deepEqual(rt().mcpPending, ['fs']);

  // No reply can arrive now, so a mark left behind would be a button disabled
  // by an answer that will never come.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'runtime_exited',
    code: 1,
    requested: false,
  } as never);

  assert.deepEqual(rt().mcpPending, []);
});

test('answering a permission sends the decision and does not update the display', () => {
  const sent = captureOutbound();
  resetStore();

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'state',
    ...STATE_PAYLOAD,
  } as never);
  assert.equal(rt().uiState?.autopilot, true);

  // A modal opens and is answered.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'permission_request',
    id: 'p1',
    call_id: 'c1',
    tool: 'shell',
    risk: 'high',
    arguments: { command: 'rm -rf /' },
    remember: { tool: 'shell' },
    remember_hint: 'this writes a rule',
    allow_trust_all: false,
    trust_all_hint: null,
  } as never);
  assert.equal(useApp.getState().modal?.kind, 'permission');

  useApp.getState().answerPermission('always');
  const response = sent.find((msg) => msg.t === 'permission_response') as Extract<
    FrontendMsg,
    { t: 'permission_response' }
  >;
  assert.equal(response.decision, 'always');
  assert.equal(response.id, 'p1');

  // No optimistic update: the runtime's snapshot is still the only thing that
  // has written these facts.
  assert.equal(rt().uiState?.autopilot, true);
});

test('an answer goes back to the session that asked, not to the one on screen', () => {
  const first: FrontendMsg[] = [];
  const second: FrontendMsg[] = [];
  registerRuntime({ key: KEY, send: (m) => first.push(m), subscribe: () => () => undefined, dispose: () => undefined });
  registerRuntime({ key: 'k-2', send: (m) => second.push(m), subscribe: () => () => undefined, dispose: () => undefined });

  resetStore();
  const other = 'k-2';
  useApp.setState((s) => ({
    sessions: {
      ...s.sessions,
      [other]: createSessionBucket(other, 'C:/work', { ericai: false, maxSteps: null }),
    },
    order: [...s.order, other],
  }));
  useApp.getState().applyRuntimeMessage(other, { ...INIT_PAYLOAD, session_id: 's-2' } as never);

  // **The second session asks while the first is the one on screen.** That is
  // the whole case: a prompt with several conversations open belongs to a
  // session the reader may not be looking at.
  useApp.getState().applyRuntimeMessage(other, {
    v: 1,
    t: 'permission_request',
    id: 'p-second',
    call_id: 'c1',
    tool: 'shell',
    risk: 'high',
    arguments: { command: 'rm -rf /' },
    remember: null,
    remember_hint: null,
    allow_trust_all: false,
    trust_all_hint: null,
  } as never);

  assert.equal(useApp.getState().activeKey, KEY, 'the display did not move');
  assert.equal(useApp.getState().modal?.kind, 'permission');

  useApp.getState().answerPermission('allow');

  // The reply goes to **k-2**, the child the runtime is blocked on. Getting this
  // wrong is the failure this design exists to make impossible: the asker waits
  // on that id forever (the runtime has no timeout), while the session that
  // never asked receives a decision about a call it does not have.
  assert.equal(second.filter((m) => m.t === 'permission_response').length, 1);
  assert.equal(first.filter((m) => m.t === 'permission_response').length, 0);
  assert.equal((second.find((m) => m.t === 'permission_response') as { id: string }).id, 'p-second');
});

test('an approval labels which conversation it came from', () => {
  captureOutbound();
  resetStore();
  applyInit();

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'permission_request',
    id: 'p1',
    call_id: 'c1',
    tool: 'shell',
    risk: 'high',
    arguments: {},
    remember: null,
    remember_hint: null,
    allow_trust_all: false,
    trust_all_hint: null,
  } as never);

  // The workspace's base name and the runtime's own session id. Not the bridge
  // key: a reader cannot do anything with `k-1`, and the id is what names the
  // conversation everywhere else on screen.
  const origin = selectModalOrigin(useApp.getState(), KEY);
  assert.ok(origin.includes('s-1'), `the session id must be in it, got ${origin}`);
  assert.equal(selectQueuedModals(useApp.getState()), 0, 'one request is not a queue');
});

test('answering a question distinguishes skip from an answer', () => {
  const sent = captureOutbound();
  resetStore();

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'question_request',
    id: 'q1',
    question: 'which one?',
    header: 'pick',
    options: ['first', 'second'],
    multi_select: false,
  } as never);

  useApp.getState().answerQuestion('skipped', 'ignored');
  const skip = sent[0] as Extract<FrontendMsg, { t: 'question_response' }>;
  assert.equal(skip.status, 'skipped');
  // A skip carries an empty string: it is not an answer, and it must not look
  // like one.
  assert.equal(skip.text, '');
});

test('the store never writes a runtime fact on its own', () => {
  captureOutbound();
  resetStore();

  // The only way these fields change is a message from the runtime.
  assert.equal(rt().uiState, null);
  useApp.getState().setAutopilot(true);
  assert.equal(rt().uiState, null);

  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'ui', kind: 'state', ...STATE_PAYLOAD } as never);
  assert.equal(rt().uiState?.autopilot, true);
});

/* ============================================================
   The workspace's terminals and files: the two facts that only
   ever reached the screen when a panel happened to be open
   ============================================================ */

test('a snapshot alone is enough to learn about a terminal', () => {
  captureOutbound();
  resetStore();

  // **No `terminal_list` is sent here, and that is the assertion.** The panel's
  // own request is the usual path and it works — which is exactly why the hole
  // went unnoticed: the contract the runtime documents ("a front end that started
  // *after* a shell was created, or one that lost a message, learns from the next
  // snapshot rather than never") was simply not implemented on this side. The
  // field was declared on the wire type, projected nowhere, and the bucket's list
  // only ever changed when somebody opened the panel.
  assert.deepEqual(rt().terminals, []);

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'state',
    ...STATE_PAYLOAD,
  } as never);

  assert.deepEqual(rt().terminals.map((row) => row.id), ['term-01']);
});

test('a snapshot that no longer lists a terminal takes its attach away', () => {
  captureOutbound();
  resetStore();

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'state',
    ...STATE_PAYLOAD,
  } as never);
  useApp.getState().attachTerminal('term-01');
  assert.equal(rt().activeTerminalId, 'term-01');

  // The runtime's list is the whole truth, so a snapshot without the id means it
  // is gone. An attach left pointing at a row that does not exist draws a
  // terminal view with no tab to switch away from it.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'state',
    ...STATE_PAYLOAD,
    terminals: [],
  } as never);

  assert.equal(rt().activeTerminalId, null);
  assert.deepEqual(rt().terminals, []);
});

test('a refused listing stops the spinner and says why', () => {
  captureOutbound();
  resetStore();

  useApp.getState().listFiles('gone');
  assert.equal(rt().filesLoading, true, 'the request is in flight');

  // **The refusal is a `notice`, not a `ui(files)`.** Only the success path used
  // to clear `filesLoading`, so a refused listing left the panel reading
  // "Reading the directory…" for ever — while the sentence explaining it went
  // into the transcript, which is exactly what the panel was covering. A
  // directory deleted between the listing and the click is the everyday
  // reproduction.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'notice',
    level: 'warn',
    code: 'files',
    text: '[files] could not list that directory: Path escapes workspace',
  } as never);

  assert.equal(rt().filesLoading, false);
  assert.equal(
    rt().filesProblem,
    '[files] could not list that directory: Path escapes workspace',
  );
  // The runtime's own sentence, unaltered, and **also** in the stream: the panel
  // shows it where the person is looking, and the transcript keeps the record.
  const note = rt().entries.at(-1);
  assert.equal(note?.kind, 'note');
});

test('a successful listing clears the refusal it superseded', () => {
  captureOutbound();
  resetStore();

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'notice',
    level: 'warn',
    code: 'files',
    text: 'nope',
  } as never);
  assert.equal(rt().filesProblem, 'nope');

  useApp.getState().listFiles('');
  // Cleared on the **request**, not on the answer: the old refusal is about a
  // request that has been superseded, and leaving it up would show a stale reason
  // over a directory that may now list fine.
  assert.equal(rt().filesProblem, null);

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'files',
    path: '',
    entries: [],
  } as never);
  assert.equal(rt().filesLoading, false);
  assert.equal(rt().filesProblem, null);
});

test('reading a file fills the panel\'s own viewer, and keeps both files', () => {
  captureOutbound();
  resetStore();

  useApp.getState().readFile('a.txt');
  // In flight: the viewer names what was asked for, and has no answer yet.
  assert.deepEqual(rt().fileView, { path: 'a.txt', answer: null, problem: null });

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'file_read',
    path: 'a.txt',
    artifact_id: '',
    content: 'first',
    chars: 5,
    bytes: 5,
    truncated: false,
    total_lines: 1,
  } as never);

  // **Two destinations, one answer.** The transcript block is where a file read
  // belongs in arrival order, and the viewer is what the panel draws — without
  // which pressing Enter on a file changed nothing anybody could see.
  assert.equal(rt().fileView?.answer?.content, 'first');
  const blocks = rt().entries.filter((e) => e.kind === 'block' && e.block === 'file');
  assert.equal(blocks.length, 1);

  // A second file **adds** a block rather than replacing the first. `pushBlock`
  // replaces same-kind blocks, which is right for `/status` — "what is the state
  // now" — and wrong here: "I read A, now B" is two readings, and replacing meant
  // opening the second file silently deleted the first.
  useApp.getState().readFile('b.txt');
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'file_read',
    path: 'b.txt',
    artifact_id: '',
    content: 'second',
    chars: 6,
    bytes: 6,
    truncated: false,
    total_lines: 1,
  } as never);

  const both = rt().entries.filter((e) => e.kind === 'block' && e.block === 'file');
  assert.equal(both.length, 2, 'reading a second file must not delete the first');
});

test('a refused read is answered in the viewer, not only in the stream', () => {
  captureOutbound();
  resetStore();

  useApp.getState().readFile('.tudouni');
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'notice',
    level: 'warn',
    code: 'files',
    text: '[files] could not read that file: not a file: .tudouni',
  } as never);

  assert.equal(rt().fileView?.problem, '[files] could not read that file: not a file: .tudouni');
  assert.equal(rt().fileView?.answer, null);
});

test('asking for a terminal marks the request in flight, and a refusal releases it', () => {
  const sent = captureOutbound();
  resetStore();

  useApp.getState().createTerminal();
  assert.equal(sent.at(-1)?.t, 'terminal_create');
  // The sentinel is `'new'` rather than an id, because there is no id yet —
  // creation is what produces one. Both `+` buttons read this to disable
  // themselves, and without it two quick presses created **two real shells**,
  // with the reply attaching the view to the newest and leaving the first as a
  // tab nobody remembered asking for.
  assert.deepEqual(rt().terminalPending, ['new']);

  // A **refused** create answers with the unchanged full list plus a notice, so
  // the list is what has to release the mark. Releasing it only on
  // `terminal_created` would leave the button disabled for the rest of the
  // session, with nothing on screen to explain why.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'ui',
    kind: 'terminals',
    terminals: [],
  } as never);
  assert.deepEqual(rt().terminalPending, []);
});

test('runtime_exited records the code and whether it was requested', () => {
  captureOutbound();
  resetStore();

  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'runtime_exited',
    code: 0,
    requested: false,
  } as never);

  assert.deepEqual(rt().runtimeExit, { code: 0, requested: false });
});

test('quiet mode is a preference and survives protocol traffic', () => {
  captureOutbound();
  resetStore();

  const before = rt().quiet;
  useApp.getState().toggleQuiet();
  assert.equal(rt().quiet, !before);

  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'ui', kind: 'state', ...STATE_PAYLOAD } as never);
  // A snapshot refresh must not reach into presentation choices.
  assert.equal(rt().quiet, !before);
  useApp.getState().setQuiet(before);
});

/* ============================================================
   the handshake's facts, and the message that arrives right behind it
   ============================================================ */

test('the handshake notices survive the session_load that follows them', () => {
  captureOutbound();
  resetStore();

  applyInit();

  // The runtime sends these two back to back, unconditionally. `session_load`
  // rebuilds the whole transcript, which used to take the diagnostics with it.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'session_load',
    messages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ],
  } as never);

  const state = rt();
  // The runtime's own sentence, verbatim, still on screen.
  assert.equal(state.handshakeNotices.length, 1);
  assert.equal(state.handshakeNotices[0].code, 'grep.missing_binary');
  assert.equal(state.handshakeNotices[0].tone, 'warn');
  // And it was folded back into the rebuilt stream, not dropped from it.
  const notes = state.entries.filter((entry) => entry.kind === 'note');
  assert.equal(notes.length, 1);
  assert.equal((notes[0] as Extract<Entry, { kind: 'note' }>).text, 'grep is not registered');
  // The transcript itself was still rebuilt.
  assert.equal(state.entries.filter((entry) => entry.kind === 'user').length, 1);
  assert.equal(state.entries.filter((entry) => entry.kind === 'answer').length, 1);
});

test('init.tools feeds the risk lookup, before ui(tools) is ever asked for', () => {
  captureOutbound();
  resetStore();

  applyInit();

  // No `ui(tools)` has arrived — only the handshake has.
  assert.equal(rt().tools.length, 0);
  assert.equal(rt().toolRegistry.length, 2);

  // A tool row is drawn from these facts, so `shell` must already be HIGH.
  const facts = useApp.getState().toolFacts('shell');
  assert.equal(facts?.risk, 'high');
  assert.equal(facts?.parallelSafe, false);
  assert.equal(facts?.interactive, false);
  // `external` only exists on the richer `ui(tools)` row: unknown, not false.
  assert.equal(facts?.external, null);

  // And the row really does carry it once a tool call arrives.
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'event',
    kind: 'run_started',
    run_id: 'r1',
    step: 0,
  } as never);
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'event',
    kind: 'tool_call',
    run_id: 'r1',
    step: 1,
    tool: 'shell',
    call_id: 'c1',
    tool_index: 0,
    arguments: '{"command":"ls"}',
  } as never);

  const row = rt().entries.find((entry) => entry.kind === 'tool');
  assert.equal((row as Extract<Entry, { kind: 'tool' }>)?.risk, 'high');

  // An unknown tool stays unknown rather than defaulting to low.
  assert.equal(useApp.getState().toolFacts('never-heard-of-it'), null);
});

test('the config-level permission scope is kept, and is not the live one', () => {
  captureOutbound();
  resetStore();

  applyInit({
    permissions: { auto_approve: ['low'], shell_allow: ['git status'] },
  });

  // This is what the audit panel reads for "non-default permissions".
  assert.deepEqual(rt().session?.permissions, {
    auto_approve: ['low'],
    shell_allow: ['git status'],
  });

  // The live snapshot is a different fact and carries no config scope at all.
  useApp.getState().applyRuntimeMessage(KEY, { v: 1, t: 'ui', kind: 'state', ...STATE_PAYLOAD } as never);
  const live = rt().uiState?.permission;
  assert.deepEqual(live?.autoApprove, []);
  assert.deepEqual(live?.shellAllow, []);
  // …but it does carry what was released while the session ran.
  assert.deepEqual(live?.grantedTools, ['read_file']);
  assert.deepEqual(live?.grantedPrefixes, ['git add']);
});

/* ============================================================
   The left sidebar: workspaces and sessions
   ============================================================ */

test('a workspace bookmark is a preference, not a protocol message', () => {
  const sent = captureOutbound();
  resetStore();
  useApp.setState({ workspaces: [] });

  useApp.getState().addWorkspace('C:/work/one');

  // The protocol has no workspace list, and it could not usefully carry one: a
  // workspace *is* the child's working directory, so changing it is a different
  // process rather than a message. Adding one therefore sends nothing at all —
  // a version of this that sent `session_switch` or similar would be claiming a
  // channel that does not exist.
  assert.equal(sent.length, 0);
  assert.deepEqual(useApp.getState().workspaces, ['C:/work/one']);
});

test('the same directory is bookmarked once, however it is spelled', () => {
  captureOutbound();
  resetStore();
  useApp.setState({ workspaces: [] });

  useApp.getState().addWorkspace('C:/work/one');
  // A trailing separator and the other case are the same directory on Windows,
  // and a second row for it would draw the current workspace twice.
  useApp.getState().addWorkspace('C:/Work/One/');
  useApp.getState().addWorkspace('c:\\work\\one');

  assert.deepEqual(useApp.getState().workspaces, ['C:/work/one']);
});

test('forgetting a workspace does not move the runtime out of it', () => {
  const sent = captureOutbound();
  resetStore();
  applyInit();
  useApp.setState({ workspaces: ['C:/work/one'] });

  // `init` asks for the session list on its way past, so the count is not zero
  // to begin with; what matters is that forgetting adds nothing.
  const beforeCount = sent.length;
  useApp.getState().removeWorkspace('C:/work/one');

  assert.deepEqual(useApp.getState().workspaces, []);
  // Being *listed* and being *current* are two different things: the runtime is
  // still in that directory, and `init.workspace` still says so. A version that
  // cleared the session here would be reporting a move that never happened.
  assert.equal(rt().session?.workspace, INIT_PAYLOAD.workspace);
  assert.equal(sent.length, beforeCount);
});

test('entering the workspace the runtime is already in does not restart it', () => {
  const sent = captureOutbound();
  resetStore();
  applyInit();
  useApp.getState().applyRuntimeMessage(KEY, {
    v: 1,
    t: 'session_load',
    messages: [{ role: 'user', content: 'still here' }],
  } as never);
  const before = rt().entries;
  assert.ok(before.length > 0);

  // A restart would throw away a live session to arrive at the same directory —
  // and the comparison has to tolerate case and separator differences, or
  // pressing the row that says "current" would do exactly that.
  return useApp
    .getState()
    .enterWorkspace(String(INIT_PAYLOAD.workspace).toUpperCase())
    .then(() => {
      assert.equal(rt().entries, before);
      assert.ok(rt().session, 'the session must survive');
    });
});

test('entering another workspace opens beside the current one, and clears nothing', () => {
  const sent = captureOutbound();
  resetStore();
  applyInit();
  useApp.setState((s) => ({
    sessions: {
      ...s.sessions,
      [KEY]: { ...s.sessions[KEY]!, sessionList: [{ id: 's-1' } as never], listedSessions: true },
    },
  }));

  return useApp
    .getState()
    .enterWorkspace('C:/work/elsewhere')
    .then(() => {
      const s = useApp.getState();

      // **This reverses what this test used to assert**, and the reversal is the
      // whole point of the change. It used to demand that the old session, its
      // transcript and its session list were all cleared "before the child
      // restarts" — because with one process, going to another workspace meant
      // replacing the one that was running. That is precisely the behaviour the
      // second target scenario needs to stop: a conversation at work must not be
      // torn down because somebody looked at a different directory.
      //
      // So the old conversation survives, untouched, in its own bucket.
      assert.ok(s.sessions[KEY], 'the conversation that was open must survive');
      assert.deepEqual(s.sessions[KEY]?.sessionList, [{ id: 's-1' }]);
      assert.equal(s.sessions[KEY]?.listedSessions, true);
      assert.equal(s.sessions[KEY]?.session?.workspace, INIT_PAYLOAD.workspace);

      // And nothing was switched in place: a workspace is a process, so this is
      // a new child or nothing at all.
      assert.equal(sent.filter((msg) => msg.t === 'session_switch').length, 0);
    });
});

test('a session row and a workspace row are never confused for one another', () => {
  const sent = captureOutbound();
  resetStore();
  applyInit();

  // The two halves of the left rail do different things, and the difference is
  // now "which process" rather than "a message versus a process":
  //
  //   - a **session row** opens a conversation. If a child already holds it,
  //     that child is focused and *nothing is sent*; otherwise a new child is
  //     started.
  //   - a **workspace row** goes to a directory. If a conversation is already
  //     live there, it is focused; otherwise a new child is started in it.
  //
  // What neither one may do is reach for `session_switch`, which makes the
  // runtime rebuild itself and abandon whatever it was waiting on.
  const beforeCount = sent.length;

  // A session row for the conversation already on screen: pure focus.
  useApp.getState().focusSession(KEY);
  assert.equal(sent.length, beforeCount, 'focusing the current session sends nothing');
  assert.equal(useApp.getState().activeKey, KEY);

  // A workspace row for the directory a live child is already in: also pure
  // focus, and this is the rule the old test was reaching for — going to where
  // the runtime already is must not restart it.
  return useApp
    .getState()
    .enterWorkspace(String(INIT_PAYLOAD.workspace))
    .then(() => {
      assert.equal(sent.length, beforeCount, 'entering the current workspace sends nothing');
      assert.equal(sent.filter((msg) => msg.t === 'session_switch').length, 0);
      assert.ok(rt().session, 'the running conversation is untouched');
    });
});

/* ============================================================
   Which directory a new child is started in
   ============================================================ */

/**
 * Every `runtime_attach` the store makes, while a fake Tauri host is installed.
 *
 * The workspace is a **start-up argument** and not a message: it is the child's
 * working directory, and the runtime takes it as the workspace
 * (`paths.WorkspaceDir()`). So "which conversation did we open" and "which
 * directory did we open it in" are one call, and this is the only way to see the
 * second half from here — the store's own `workspace` field records what it
 * *believed*, which is precisely what can be wrong.
 *
 * `isHosted()` is what makes `attachRuntime` a real call rather than a null
 * return, so the host has to exist for the length of the test and is removed
 * afterwards: the rest of this file relies on there being no bridge at all.
 */
async function attachCalls<T>(body: () => Promise<T>): Promise<{ options: Record<string, unknown> }[]> {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke(cmd: string, args: Record<string, unknown>) {
        calls.push({ cmd, args });
        if (cmd === 'runtime_attach') return 100 + calls.length;
        if (cmd === 'runtime_stderr') return [];
        return null;
      },
    },
  };
  try {
    await body();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
  return calls
    .filter((call) => call.cmd === 'runtime_attach')
    .map((call) => call.args.options as Record<string, unknown>);
}

test('a child is started in the workspace of the session that asked for it', () => {
  resetStore();
  applyInit();

  // The row a person clicks in the rail. It names a session and no directory —
  // the directory is the one the child that owns that list is already in, and
  // only the store knows it.
  //
  // Leaving it out of the `runtime_attach` call is not a harmless omission: the
  // bridge then falls back to the *process's* working directory, which for a
  // packaged application is where it is installed. The session file is not
  // there, and the runtime reads an id with no file as **a new session with that
  // name** (`internal/runtime/composition.go`, `ResolveSession`), so the child
  // starts a different, empty conversation and reports `init.workspace` from
  // there — the screen moves to an unrelated workspace while the row that was
  // clicked stays put. This is that bug, pinned.
  return attachCalls(async () => {
    await useApp.getState().openSession('s-2');
  }).then((calls) => {
    assert.equal(calls.length, 1, 'one click opens one child');
    assert.equal(calls[0]?.sessionId, 's-2');
    assert.equal(
      calls[0]?.workspace,
      'C:/work/proj',
      'the directory must travel with the session, not be left to the process',
    );
  });
});

test('starting a conversation from the first screen stays where the window is', () => {
  resetStore();
  applyInit();

  // `/new` names no session and no directory, and it means "here": the same
  // default, for the same reason.
  return attachCalls(async () => {
    await useApp.getState().openSession(null);
  }).then((calls) => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.workspace, 'C:/work/proj');
    // And no session id at all: a null id *is* the new-session request.
    assert.equal(calls[0]?.sessionId, null);
  });
});

test('with nothing open and nothing remembered, no child is started at all', () => {
  // **This used to assert the opposite, and the assertion was the bug written
  // down.** It required exactly one `runtime_attach` with `workspace: null`,
  // reasoning that an absent workspace is the bridge's documented "the directory
  // the app was started in" — which for a packaged application is its own install
  // folder. So the omission was not a neutral act; it *selected* a directory
  // nobody named. The runtime then read the session id as a new name (no file in
  // that directory) and reported `init.workspace` from there, so the screen moved
  // somewhere unrelated and nothing failed.
  //
  // The contract now is that a missing workspace is a **refusal**, not a
  // fallback: there is no honest directory to guess, so no child is started and
  // the first screen asks. See `resolveAttachWorkspace`.
  useApp.setState({ sessions: {}, order: [], activeKey: null, lastWorkspace: null });

  return attachCalls(async () => {
    await useApp.getState().attachSession({});
  }).then((calls) => {
    assert.equal(calls.length, 0, 'no workspace means no child');
    // And the person is told, because `/new` and the rail's button both land here.
    assert.deepEqual(useApp.getState().startupNotice, { code: 'no-workspace' });
  });
});

test('a remembered workspace is what a first attach goes to', () => {
  // The other half of the same contract: with nothing open but something
  // remembered, the child is started **there** — named explicitly, rather than
  // left to the bridge's fallback.
  useApp.setState({ sessions: {}, order: [], activeKey: null, lastWorkspace: 'C:/remembered' });

  return attachCalls(async () => {
    await useApp.getState().attachSession({});
  }).then((calls) => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.workspace, 'C:/remembered');
  });
});
