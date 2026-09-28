/**
 * Render check: mount the real UI in a browser and drive it with real payloads.
 *
 * Type checking cannot catch a component that throws on mount, and a blank
 * screen is exactly the failure mode this project is most exposed to. So this
 * navigates to the dev server, records every console error and uncaught
 * exception, then imports the **real** store module through Vite's module graph
 * and feeds it the protocol payloads the Go runtime actually sends 鈥?checking
 * that the pieces of the interface light up as they should.
 *
 * Usage:
 *   node scripts/render-check.mjs <url> [cdpPort]
 */

import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  ).then((r) => r.json());

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const problems = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    // Anything the page throws or logs as an error is a finding.
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      problems.push(`exception: ${d?.exception?.description ?? d?.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      problems.push(
        `console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`,
      );
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      problems.push(`eval threw: ${r.result.exceptionDetails.text}`);
      return undefined;
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // The default is dark, and dark is the theme the design system is built around.
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await send('Page.navigate', { url });
  await sleep(3500);

  // ---- 1. did it mount at all? ----
  const mounted = await evaluate(`(() => {
    const root = document.getElementById('root');
    return JSON.stringify({
      theme: document.documentElement.dataset.theme,
      childCount: root ? root.childElementCount : -1,
      hasApp: !!document.querySelector('.app'),
      hasTitleBar: !!document.querySelector('.titlebar'),
      hasTopBar: !!document.querySelector('.topbar'),
      hasSessionBar: !!document.querySelector('.sessionbar'),
      hasStatusBar: !!document.querySelector('.statusbar'),
      hasComposer: !!document.querySelector('.composer'),
      booting: !!document.querySelector('.booting'),
      commandCount: document.querySelectorAll('.titlebar, .topbar').length,
    });
  })()`);

  console.log('mount:', mounted);
  const m = JSON.parse(mounted ?? '{}');
  if (m.childCount <= 0) throw new Error('the React tree did not mount');
  if (!m.hasApp) throw new Error('the app shell is missing');
  if (!m.booting) throw new Error('with no runtime attached the UI should show its booting phase');

  // ---- 2. drive the real store with real payloads ----
  // `window.__aigoStore` is set by `main.tsx` (dev builds only) and is the very
  // instance the rendered tree reads. Importing the module here instead would
  // get a second instance 鈥?Vite keys modules by resolved specifier, so
  // `/src/state/store` and `/src/state/store.ts` are two different modules 鈥?and
  // the check would then drive a store nobody is rendering.
  const storeReady = await evaluate(`(async () => {
    for (let i = 0; i < 40 && !window.__aigoStore; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return typeof window.__aigoStore?.getState === 'function';
  })()`);
  if (!storeReady) throw new Error('the app did not expose its store (is this a dev build?)');
  console.log('store: the instance the tree reads');

  const apply = async (payload) => {
    const r = await evaluate(
      `(() => { window.__aigoStore.getState().applyRuntimeMessage(${JSON.stringify(payload)}); return true; })()`,
    );
    if (r !== true) throw new Error(`failed to apply ${payload.t}`);
    await sleep(120);
  };

  // init
  await apply({
    v: 1,
    t: 'init',
    protocol: 3,
    session_id: 's-render',
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
      ],
      aliases: [],
    },
    workspace: 'C:/work/project',
    max_steps: 120,
    stream: true,
    context_tokens: 65536,
    tools: [
      { name: 'shell', risk: 'high', parallel_safe: false, interactive: false },
      { name: 'read_file', risk: 'low', parallel_safe: true, interactive: false },
    ],
    permissions: {},
    audit_path: 'C:/work/project/.tudouni/audit/s-render.jsonl',
    notices: [{ level: 'warn', code: 'grep.missing_binary', text: 'grep is not registered' }],
  });

  const afterInit = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const txt = (s) => (q(s) ? q(s).innerText.replace(/\\s+/g,' ').slice(0,200) : null);
    return JSON.stringify({
      ready: window.__aigoStore.getState().ready,
      welcome: !!q('.welcome'),
      sessionbar: txt('.sessionbar'),
      statusbar: txt('.statusbar'),
      note: txt('.e-note'),
      booting: !!q('.booting'),
    });
  })()`);
  console.log('after init:', afterInit);
  const ai = JSON.parse(afterInit ?? '{}');
  if (!ai.ready) throw new Error('init did not mark the store ready');
  if (ai.booting) throw new Error('the booting phase should be gone after init');
  if (!ai.welcome) throw new Error('a session with no conversation should show the first screen');
  if (!ai.sessionbar?.includes('deepseek-chat')) {
    throw new Error(`the session bar did not pick up the model: ${ai.sessionbar}`);
  }

  // ---- the left rail: workspaces and sessions ----
  //
  // Two assertions here, and both are about things that cannot fail loudly:
  //   - the **brand mark is drawn**, which is a `<rect>` in `--accent` inside an
  //     SVG. A missing mark renders as nothing at all — no error, no gap in the
  //     layout, just a rail that starts with a word;
  //   - the **current workspace is a row even though nothing is bookmarked**.
  //     `init.workspace` is the runtime's own answer to "where am I", and a list
  //     of bookmarks that omits it would answer "where have I been" instead.
  const leftbar = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const bar = q('.app-leftbar');
    const logo = q('.lb-head svg rect');
    return JSON.stringify({
      present: !!bar,
      text: (bar?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 400),
      logoFill: logo ? logo.getAttribute('fill') : null,
      currentRows: document.querySelectorAll('.lb-row.is-current').length,
      newSession: !!q('.lb-new button'),
    });
  })()`);
  console.log('left rail:', leftbar);
  const lb = JSON.parse(leftbar ?? '{}');
  // Case-insensitive: the section titles are styled `text-transform: uppercase`,
  // and `innerText` reports what is *rendered* — so comparing against title case
  // tests the CSS, not the rail.
  const lbText = String(lb.text).toLowerCase();
  if (!lb.present) throw new Error('the left sidebar is missing');
  if (!lb.logoFill) throw new Error('the left sidebar has no brand mark');
  // The mark is the application's own: the accent token, not a hard-coded hex.
  if (!String(lb.logoFill).includes('--accent')) {
    throw new Error(`the brand mark is not drawn from the token set: ${lb.logoFill}`);
  }
  if (!lb.newSession) throw new Error('the "new session" button is missing');
  if (!lbText.includes('workspaces')) throw new Error('the workspace section is missing');
  if (!lbText.includes('sessions')) throw new Error('the session section is missing');
  if (!lbText.includes('project')) {
    throw new Error(`the current workspace is not listed: ${lb.text}`);
  }
  if (lb.currentRows !== 1) {
    throw new Error(`expected exactly one row marked current, got ${lb.currentRows}`);
  }

  // There must be no sign-in affordance and no plugin market: neither exists
  // behind this window, so a control for either would be a control for something
  // that cannot happen.
  for (const absent of ['sign in', 'log in', 'plugins', 'marketplace', 'account']) {
    if (lbText.includes(absent)) {
      throw new Error(`the left sidebar offers "${absent}", which has nothing behind it`);
    }
  }

  // The session list, as the runtime answers it. `messages`, `steps`, `todos`
  // and `preview` are all computed by the runtime — this rail counts nothing
  // itself, so what is asserted here is that the runtime's own numbers arrive.
  await apply({
    v: 1,
    t: 'sessions',
    items: [
      {
        session_id: 's-20260101-000000',
        messages: 12,
        steps: 5,
        todos: '3/7',
        preview: 'fix the reconnect race',
        modified_at: 1767225600,
      },
      {
        session_id: 's-20251231-235959',
        messages: 3,
        steps: 1,
        todos: '',
        preview: '',
        modified_at: null,
      },
    ],
  });

  const sessions = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.lb-session')];
    return JSON.stringify({
      count: rows.length,
      first: (rows[0]?.innerText ?? '').replace(/\\s+/g,' ').trim(),
      current: rows.filter((r) => r.classList.contains('is-current')).length,
      times: [...document.querySelectorAll('.lb-session-time')].map((n) => n.textContent),
    });
  })()`);
  console.log('session rows:', sessions);
  const sr = JSON.parse(sessions ?? '{}');
  if (sr.count !== 2) throw new Error(`expected 2 session rows, got ${sr.count}`);
  if (!sr.first.includes('s-20260101-000000')) throw new Error('the session id is missing');
  if (!sr.first.includes('12 messages')) throw new Error(`the runtime's message count is missing: ${sr.first}`);
  if (!sr.first.includes('3/7')) throw new Error('the runtime-made progress text is missing');
  if (!sr.first.includes('fix the reconnect race')) throw new Error('the preview is missing');
  // The session on screen is not one of these, so none of them is current.
  if (sr.current !== 0) throw new Error('a session row claimed to be current without being so');
  // `modified_at` is epoch **seconds**; null means unreadable and must not be
  // turned into a time.
  if (!sr.times.some((value) => value === 'unknown')) {
    throw new Error(`an unreadable modified_at was rendered as a time: ${JSON.stringify(sr.times)}`);
  }

  // `session_load` — the message the runtime sends **unconditionally** right
  // behind `init`.
  //
  // This step used to be missing, and its absence is why this script certified a
  // bug it could not see: it asserted the notice survived after `init` alone, in
  // a sequence the runtime never produces. The real opening is
  // `init` -> `session_load` -> `ui(state)`, and `session_load` rebuilds the
  // whole transcript — which wiped every handshake notice before the first frame
  // was drawn. Checking the notice *after* this message is the check that means
  // something.
  await apply({ v: 1, t: 'session_load', messages: [] });

  const afterLoad = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const txt = (s) => (q(s) ? q(s).innerText.replace(/\\s+/g,' ').slice(0,200) : null);
    return JSON.stringify({
      welcome: !!q('.welcome'),
      note: txt('.e-note'),
      notes: window.__aigoStore.getState().entries.filter((e) => e.kind === 'note').length,
    });
  })()`);
  console.log('after session_load:', afterLoad);
  const al = JSON.parse(afterLoad ?? '{}');
  if (!al.welcome) {
    throw new Error('the first screen should survive an empty session_load');
  }
  if (!al.notes) {
    throw new Error('session_load wiped the handshake notices');
  }
  if (!al.note?.includes('grep is not registered')) {
    throw new Error(`the runtime notice was not rendered verbatim: ${al.note}`);
  }

  // ui(state) 鈥?every sidebar block
  await apply({
    v: 1,
    t: 'ui',
    kind: 'state',
    todos: [
      { content: 'read the spec', status: 'completed' },
      { content: 'write the adapter', status: 'in_progress' },
    ],
    skills: [{ name: 'pdf-tools', digest: 'ab12' }],
    skill_catalog: [{ name: 'pdf-tools', description: 'work with PDFs' }],
    jobs: [{ id: 'j1', command: 'npm test', state: 'uncollected', seconds: 45, exit_code: 0 }],
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
    messages: 4,
    steps: 2,
    model: 'deepseek-chat',
    model_provider: 'deepseek',
    model_window: 65536,
    thinking: true,
    effort: 'high',
    effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    autopilot: false,
    granted_tools: ['read_file'],
    granted_prefixes: ['git add'],
    denied_tools: [],
    risk_scope: [
      { risk: 'low', disposition: 'auto' },
      { risk: 'medium', disposition: 'ask' },
      { risk: 'high', disposition: 'ask' },
    ],
    agents_md: [{ path: 'AGENT.md', lines: 12, status: 'loaded' }],
    mcp: [{ name: 'fs', state: 'loaded', tools: 12, where: 'npx fs-server' }],
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
  });

  const sidebar = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll('.sb-block')];
    return JSON.stringify({
      blockCount: blocks.length,
      titles: blocks.map((b) => b.querySelector('.sbh-title')?.textContent ?? ''),
      sidebarText: (document.querySelector('.app-sidebar')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 400),
    });
  })()`);
  console.log('sidebar:', sidebar);
  const sb = JSON.parse(sidebar ?? '{}');
  // Five blocks, in the fixed order.
  if (sb.blockCount !== 5) throw new Error(`expected 5 sidebar blocks, got ${sb.blockCount}`);
  const expected = ['Goal', 'Tasks', 'Loaded skills', 'Background jobs', 'MCP'];
  if (JSON.stringify(sb.titles) !== JSON.stringify(expected)) {
    throw new Error(`block order/titles wrong: ${JSON.stringify(sb.titles)}`);
  }
  if (!sb.sidebarText.includes('fix the reconnect')) throw new Error('the goal text is missing');
  if (!sb.sidebarText.includes('3/60')) throw new Error('the goal round count is missing');
  if (!sb.sidebarText.includes('uncollected')) throw new Error('the uncollected job is not flagged');
  if (!sb.sidebarText.includes('pdf-tools')) throw new Error('the loaded skill is missing');

  // a full turn: run_started -> model_call -> tool_call -> tool_result -> answer
  await apply({
    v: 1,
    t: 'event',
    kind: 'run_started',
    session_id: 's-render',
    run_id: 'r-1',
    step: 0,
    ts: '2026-01-01T00:00:00Z',
    model: 'deepseek-chat',
    provider: 'deepseek',
  });
  await apply({
    v: 1,
    t: 'event',
    kind: 'model_call',
    session_id: 's-render',
    run_id: 'r-1',
    step: 0,
    ts: '2026-01-01T00:00:01Z',
    status: 'ok',
    duration_ms: 900,
    prompt_tokens: 1000,
    cached_tokens: 700,
    completion_tokens: 40,
    reasoning: 'I should look at the file first.',
  });
  await apply({
    v: 1,
    t: 'delta',
    session_id: 's-render',
    run_id: 'r-1',
    step: 0,
    channel: 'text',
    text: 'Looking at it now',
    reset: false,
  });
  await apply({
    v: 1,
    t: 'event',
    kind: 'tool_call',
    session_id: 's-render',
    run_id: 'r-1',
    step: 0,
    ts: '2026-01-01T00:00:02Z',
    tool: 'shell',
    call_id: 'c1',
    tool_index: 0,
    arguments: '{"command":"git status"}',
  });
  await apply({
    v: 1,
    t: 'event',
    kind: 'tool_result',
    session_id: 's-render',
    run_id: 'r-1',
    step: 0,
    ts: '2026-01-01T00:00:03Z',
    tool: 'shell',
    call_id: 'c1',
    tool_index: 0,
    status: 'ok',
    chars: 128,
    duration_ms: 42,
    exit_code: 0,
  });

  const stream = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    return JSON.stringify({
      rows: document.querySelectorAll('.stream-inner > *').length,
      turnHead: !!q('.turn-head'),
      model: !!q('.e-model'),
      tool: !!q('.e-tool'),
      reason: !!q('.e-reason'),
      stream: !!q('.e-stream'),
      toolText: (q('.e-tool')?.innerText ?? '').replace(/\\s+/g,' ').slice(0,160),
    });
  })()`);
  console.log('stream:', stream);
  const st = JSON.parse(stream ?? '{}');
  if (!st.turnHead) throw new Error('the turn head is missing');
  if (!st.model) throw new Error('the model step row is missing');
  if (!st.tool) throw new Error('the tool row is missing');
  if (!st.reason) throw new Error('the reasoning block is missing');
  if (!st.stream) throw new Error('the streamed body is missing');
  if (!st.toolText.includes('git status')) throw new Error('the tool arguments are missing');

  // the final answer replaces the streamed body
  await apply({
    v: 1,
    t: 'ui',
    kind: 'run_finished',
    run_id: 'r-1',
    answer: 'Here is the final answer.',
  });
  const afterAnswer = await evaluate(`(() => {
    return JSON.stringify({
      answer: !!document.querySelector('.e-answer'),
      streamLeft: document.querySelectorAll('.e-stream').length,
      answerText: (document.querySelector('.e-answer')?.innerText ?? '').trim(),
      turnStatus: document.querySelector('.turn-head .badge')?.textContent ?? '',
    });
  })()`);
  console.log('after answer:', afterAnswer);
  const aa = JSON.parse(afterAnswer ?? '{}');
  if (!aa.answer) throw new Error('the answer block is missing');
  if (aa.streamLeft !== 0) throw new Error('the streamed body was rendered twice');
  if (!aa.answerText.includes('Here is the final answer')) throw new Error('the answer text is wrong');
  // The two `run_finished` messages are not ordered, so an answer can land with
  // no matching event. Leaving the head open would make the status bar read
  // "Running" over a finished answer.
  if (aa.turnStatus.includes('in progress')) {
    throw new Error(`the turn head still reads "in progress" after the answer: ${aa.turnStatus}`);
  }

  // ---- 3. the approval modal ----
  await apply({
    v: 1,
    t: 'permission_request',
    id: 'p1',
    call_id: 'c2',
    tool: 'shell',
    risk: 'high',
    arguments: { command: 'rm -rf ./build && npm run build -- --strict' },
    remember: { prefix: ['git', 'add'] },
    remember_hint: 'Allowing this remembers the rule for future calls.',
    allow_trust_all: true,
    trust_all_hint: 'This applies to the current snapshot only; new tools still ask.',
  });

  const perm = await evaluate(`(() => {
    const d = document.querySelector('.dialog');
    if (!d) return JSON.stringify({ open: false });
    const buttons = [...d.querySelectorAll('.dialog-foot button')].map((b) => b.innerText.trim());
    return JSON.stringify({
      open: true,
      title: d.querySelector('.dialog-title')?.textContent ?? '',
      buttons,
      body: d.innerText.replace(/\\s+/g,' ').slice(0, 700),
    });
  })()`);
  console.log('approval modal:', perm);
  const pm = JSON.parse(perm ?? '{}');
  if (!pm.open) throw new Error('the approval modal did not open');
  // Deny + Always allow + Allow all + Allow: all four are available here.
  for (const label of ['Deny', 'Always allow', 'Allow all', 'Allow']) {
    if (!pm.buttons.some((b) => b.includes(label))) {
      throw new Error(`the approval modal is missing "${label}": ${JSON.stringify(pm.buttons)}`);
    }
  }
  // The arguments must appear in full 鈥?the decisive half is at the end.
  if (!pm.body.includes('--strict')) {
    throw new Error('the arguments were truncated: the tail is missing');
  }
  // The runtime's hint, verbatim.
  if (!pm.body.includes('This applies to the current snapshot only')) {
    throw new Error('the trust_all_hint was not rendered verbatim');
  }

  // Answer it, and confirm the display did not change on its own.
  await evaluate(`(() => { window.__aigoStore.getState().answerPermission('allow'); return true; })()`);
  await sleep(200);
  const afterAnswerPerm = await evaluate(`(() => {
    return JSON.stringify({
      modalOpen: !!document.querySelector('.dialog'),
      autopilot: window.__aigoStore.getState().uiState?.autopilot,
    });
  })()`);
  console.log('after answering:', afterAnswerPerm);

  // Now a modal where nothing may be remembered: only Allow and Deny.
  await apply({
    v: 1,
    t: 'permission_request',
    id: 'p2',
    call_id: 'c3',
    tool: 'read_file',
    risk: 'low',
    arguments: { path: 'README.md' },
    remember: null,
    remember_hint: null,
    allow_trust_all: false,
    trust_all_hint: null,
  });
  const perm2 = await evaluate(`(() => {
    const d = document.querySelector('.dialog');
    const buttons = [...d.querySelectorAll('.dialog-foot button')].map((b) => b.innerText.trim());
    return JSON.stringify({ buttons });
  })()`);
  console.log('approval modal (nothing to remember):', perm2);
  const pm2 = JSON.parse(perm2 ?? '{}');
  if (pm2.buttons.some((b) => b.includes('Always allow'))) {
    throw new Error('"Always allow" appeared with nothing to remember');
  }
  if (pm2.buttons.some((b) => b.includes('Allow all'))) {
    throw new Error('"Allow all" appeared while allow_trust_all was false');
  }

  // The left rail must be inert while a prompt is up — and this is not
  // decoration. `server.go: switchSession` calls `pending.abandonAll()`, so
  // switching a session abandons the request the runtime is blocked on, and it
  // waits on that id forever. Restarting the child under a prompt is worse.
  const railDuringModal = await evaluate(`(() => {
    const bar = document.querySelector('.app-leftbar');
    const buttons = [...bar.querySelectorAll('button')];
    return JSON.stringify({
      // The rail stays readable: the prompt takes the *actions*, not the
      // information about where you are.
      visible: !!bar,
      text: (bar.innerText ?? '').replace(/\\s+/g,' ').toLowerCase(),
      enabled: buttons.filter((b) => !b.disabled).length,
      total: buttons.length,
    });
  })()`);
  console.log('left rail during a prompt:', railDuringModal);
  const rm = JSON.parse(railDuringModal ?? '{}');
  if (!rm.visible) throw new Error('the left rail vanished behind a prompt');
  if (!rm.text.includes('project')) {
    throw new Error('the rail stopped saying which workspace is current behind a prompt');
  }
  // The only button that may stay live is the rail's own collapse toggle: it
  // touches nothing the runtime is holding.
  if (rm.enabled > 1) {
    throw new Error(`${rm.enabled} rail controls stayed live behind a prompt`);
  }
  await evaluate(`(() => { window.__aigoStore.getState().answerPermission('deny'); return true; })()`);
  await sleep(200);

  // ---- 4. the question modal ----
  await apply({
    v: 1,
    t: 'question_request',
    id: 'q1',
    question: 'Which database should I use?',
    header: 'pick one',
    options: ['SQLite', 'Postgres'],
    multi_select: false,
  });
  const question = await evaluate(`(() => {
    const d = document.querySelector('.dialog');
    if (!d) return JSON.stringify({ open: false });
    return JSON.stringify({
      open: true,
      body: d.innerText.replace(/\\s+/g,' ').slice(0, 500),
      buttons: [...d.querySelectorAll('.dialog-foot button')].map((b) => b.innerText.trim()),
      options: [...d.querySelectorAll('.radio-item')].map((o) => o.innerText.replace(/\\s+/g,' ').trim()),
    });
  })()`);
  console.log('question modal:', question);
  const qm = JSON.parse(question ?? '{}');
  if (!qm.open) throw new Error('the question modal did not open');
  if (!qm.body.includes('Which database should I use?')) throw new Error('the question is missing');
  if (qm.options.length !== 2) throw new Error(`expected 2 options, got ${qm.options.length}`);
  if (!qm.buttons.some((b) => b.includes('Skip'))) throw new Error('Skip is not an independent button');

  // Answer with a selection: options are strings, so the text goes back.
  await evaluate(`(() => { window.__aigoStore.getState().answerQuestion('answered', 'SQLite'); return true; })()`);
  await sleep(200);

  // ---- 5. the command palette, and the 17-command table ----
  await evaluate(`(() => { window.__aigoStore.getState().openPanel('commands'); return true; })()`);
  await sleep(400);
  const palette = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cmdk-item .cmd-name')].map((n) => n.textContent);
    return JSON.stringify({ count: rows.length, rows });
  })()`);
  console.log('command palette:', palette);
  const pal = JSON.parse(palette ?? '{}');
  if (pal.count !== 17) throw new Error(`expected 17 commands, got ${pal.count}`);
  if (pal.rows.includes('/theme')) throw new Error('/theme is still in the command table');

  await evaluate(`(() => { window.__aigoStore.setState({ panel: null }); return true; })()`);
  await sleep(200);

  // ---- 6. quiet mode, in-stream blocks, and the theme ----
  await evaluate(`(() => {
    window.__aigoStore.getState().setQuiet(true);
    window.__aigoStore.getState().requestBlock('tools');
    return true;
  })()`);
  await sleep(300);
  const quiet = await evaluate(`(() => {
    return JSON.stringify({
      rollup: !!document.querySelector('.quiet-rollup'),
      quietLines: document.querySelectorAll('.quiet-line').length,
    });
  })()`);
  console.log('quiet mode:', quiet);

  await evaluate(`(() => { window.__aigoStore.getState().setQuiet(false); return true; })()`);

  // Light theme: the same tree, the other token set.
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await sleep(400);
  const lightTheme = await evaluate(`document.documentElement.dataset.theme`);
  console.log('theme after switching the system to light:', lightTheme);
  if (lightTheme !== 'light') throw new Error('the theme did not follow the system');

  // ---- 7. a screenshot, for the record ----
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('render-check.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot: render-check.png');

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();

  console.log('');
  if (problems.length > 0) {
    console.log(`FAIL 鈥?${problems.length} runtime problem(s):`);
    for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log('PASS 鈥?the interface mounts, renders every region, and survives real payloads.');
}

main().catch((e) => {
  console.error('');
  console.error('FAIL:', e.message);
  process.exit(1);
});
