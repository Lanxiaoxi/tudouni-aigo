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
      // Reported here, not only into `problems`. `problems` is printed at the
      // very end of the run, so an assertion that threw while evaluating a probe
      // used to abort with its own message and take the cause with it: the
      // failure read "the composer is not inside the conversation column" when
      // what actually happened was a `TypeError` in the probe itself.
      const detail =
        r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      problems.push(`eval threw: ${detail}`);
      console.error(`  eval threw: ${detail}`);
      return undefined;
    }
    if (r.result?.result?.value === undefined) {
      // The third way this returns nothing, and the one that cost a real
      // debugging session: a CDP-level **error** reply (`{id, error}`), which
      // leaves `r.result` undefined entirely — so neither branch above fires and
      // the caller just sees `undefined`. It is not hypothetical: it is what a
      // probe attached to a stale browser instance returns, and it read exactly
      // like "the element is not there".
      console.error(`  eval returned nothing; raw reply: ${JSON.stringify(r).slice(0, 400)}`);
      problems.push(`eval returned nothing: ${JSON.stringify(r).slice(0, 200)}`);
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

  // ---- 1b. the conversation column owns the composer, the status bar spans the window ----
  //
  // A layout is not testable by asserting that elements exist — they all existed
  // in the old shape too. What has to be asserted is the *relationship*: which
  // container each region belongs to, and where the sidebars stop. Those are
  // facts about the DOM tree, and they are exactly what a CSS edit can silently
  // undo while every element stays on screen.
  const layout = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const conv = q('.app-conversation');
    const main = q('.app-main');
    const sb = q('.statusbar');
    const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null; };
    const convBox = box(conv);
    const statusBox = box(sb);
    return JSON.stringify({
      // The composer must be a descendant of the conversation column, and NOT a
      // direct child of the shell — that is the whole change.
      composerInConversation: !!conv?.querySelector('.composer'),
      composerIsShellChild: !!q('.app > .composer'),
      composerInMain: !!main?.querySelector(':scope > .composer'),
      // The status bar must be the shell's own child, after .app-main, so it
      // spans the window including under both rails.
      statusIsShellChild: !!q('.app > .statusbar'),
      statusAfterMain: !!(main && sb && (main.compareDocumentPosition(sb) & Node.DOCUMENT_POSITION_FOLLOWING)),
      // And it must not be inside the conversation column.
      statusInConversation: !!conv?.querySelector('.statusbar'),
      convBox,
      statusBox,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      streamInnerW: Math.round(q('.stream-inner')?.getBoundingClientRect().width ?? 0),
      cpBoxX: box(q('.cp-box'))?.x ?? null,
    });
  })()`);
  console.log('layout:', layout);
  const L = JSON.parse(layout ?? '{}');

  if (!L.composerInConversation) {
    throw new Error('the composer is not inside the conversation column');
  }
  if (L.composerIsShellChild || L.composerInMain) {
    throw new Error('the composer is still a window-level region, not part of the conversation');
  }
  if (!L.statusIsShellChild || !L.statusAfterMain) {
    throw new Error('the status bar is not a window-spanning row after the conversation');
  }
  if (L.statusInConversation) {
    throw new Error('the status bar moved into the conversation column instead of spanning the window');
  }
  // The status bar spans the whole window, so it starts at x=0 and is as wide as
  // the viewport — the rails must not extend past it to the bottom.
  if (L.statusBox && (L.statusBox.x !== 0 || L.statusBox.w !== L.viewportW)) {
    throw new Error(`the status bar does not span the window: ${JSON.stringify(L.statusBox)} of ${L.viewportW}px`);
  }
  // The conversation column is above it, and together they close the height
  // budget: the composer sits inside the column, so column bottom == status top.
  if (L.convBox && L.statusBox) {
    const convBottom = L.convBox.y + L.convBox.h;
    if (Math.abs(convBottom - L.statusBox.y) > 1) {
      throw new Error(`a gap between the conversation column (${convBottom}) and the status bar (${L.statusBox.y})`);
    }
    if (L.convBox.h <= 0) throw new Error('the conversation column has no height');
  }
  // The box you type into lines up with the text above it. Two numbers in two
  // stylesheets have to agree for this, so it is worth an assertion.
  if (L.cpBoxX !== null && Math.abs(L.cpBoxX - L.convBox.x) > 40) {
    throw new Error(`the composer is not aligned with the conversation column: ${L.cpBoxX} vs ${L.convBox.x}`);
  }

  // ---- 1c. the composer is two rows in one box, with exactly two controls ----
  //
  // These are facts about structure and geometry that a CSS edit can quietly
  // undo while every element stays present: the input and the buttons are all
  // still in the DOM if the box goes back to `flex-direction: row`, it just
  // stops being two rows. Three claims are worth asserting:
  //
  //   - the input is on its own line (its bottom is above the control row);
  //   - there are exactly two controls, a plus and an action, and nothing else;
  //   - there is no hint row below the box.
  const composer = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null; };
    const cpBox = q('.cp-box');
    const ta = q('.composer textarea');
    const row = q('.cp-row');
    const add = q('.cp-add');
    const send = q('.cp-send');
    return JSON.stringify({
      boxBox: box(cpBox),
      taBox: box(ta),
      rowBox: box(row),
      addBox: box(add),
      sendBox: box(send),
      boxDirection: cpBox ? getComputedStyle(cpBox).flexDirection : null,
      // Every focusable control in the composer, named, so a third one shows up
      // by name rather than as a changed count.
      controls: [...(cpBox?.querySelectorAll('button') ?? [])].map((b) => b.className),
      // The removed pieces.
      hintRow: !!q('.cp-hint'),
      toolsRow: !!q('.cp-tools'),
      // The input must be the first child, so nothing sits to its left.
      textareaIsFirst: cpBox?.firstElementChild?.tagName === 'TEXTAREA',
    });
  })()`);
  console.log('composer:', composer);
  const C = JSON.parse(composer ?? '{}');

  if (C.boxDirection !== 'column') {
    throw new Error(`the composer box is not a column of rows: flex-direction is ${C.boxDirection}`);
  }
  if (!C.textareaIsFirst) {
    throw new Error('the textarea is not the first child of the composer box');
  }
  // The input row must sit above the control row — that is the whole shape.
  if (!(C.taBox && C.rowBox)) {
    throw new Error('could not measure the composer rows');
  }
  if (C.taBox.bottom > C.rowBox.y) {
    throw new Error(`the input overlaps the control row: input bottom ${C.taBox.bottom}, row top ${C.rowBox.y}`);
  }
  if (C.taBox.w < 100) throw new Error(`the input is not a full-width line: width ${C.taBox.w}`);
  // The two ends of the control row.
  if (!C.addBox) throw new Error('the plus button is missing');
  if (!C.sendBox) throw new Error('the send button is missing');
  if (Math.abs(C.addBox.y - C.sendBox.y) > 2) {
    throw new Error('the plus and the action are not on the same row');
  }
  if (C.addBox.x >= C.sendBox.x) {
    throw new Error('the plus is not at the left end of the control row');
  }
  // Exactly two controls, and no others.
  if (C.controls.length !== 2) {
    throw new Error(`expected 2 composer controls, found ${C.controls.length}: ${JSON.stringify(C.controls)}`);
  }
  if (C.hintRow) throw new Error('the hint row below the composer is still rendered');
  if (C.toolsRow) throw new Error('the old single-row tools container is still rendered');
  // ---- the composer ring is for the keyboard only ----
  //
  // The first version of this assertion measured the box's `borderColor`, which
  // could never have caught the defect: the ring is drawn with `outline` (and, in
  // an earlier revision, with a `box-shadow` on the textarea itself). So it has to
  // measure all three surfaces, and it has to drive real input modalities —
  // `ta.focus()` in script matches `:focus-visible` no matter what, which is
  // precisely the confusion that produced the bug.
  //
  // Simulated pointer and key events are what set `data-input-mode`, so this also
  // covers the hook that distinguishes them.
  const focusProbe = await evaluate(`(() => {
    const ta = document.querySelector('.composer textarea');
    const box = document.querySelector('.cp-box');
    if (!ta || !box) return null;
    const read = () => {
      const b = getComputedStyle(box);
      const t = getComputedStyle(ta);
      return {
        outline: b.outlineStyle + ' ' + b.outlineWidth + ' ' + b.outlineColor,
        outlineIsNone: b.outlineStyle === 'none' || b.outlineWidth === '0px',
        boxShadow: b.boxShadow,
        textareaShadow: t.boxShadow,
        mode: document.documentElement.getAttribute('data-input-mode'),
      };
    };
    const out = {};
    // 1. A pointer press, then focus — the case that must show nothing.
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    ta.focus();
    out.afterClick = read();
    // 2. A keypress, then focus — the case that must show a ring.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    ta.blur();
    ta.focus();
    out.afterKey = read();
    // 3. Back to the pointer, to prove it clears again.
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    ta.blur();
    ta.focus();
    out.backToPointer = read();
    ta.blur();
    return JSON.stringify(out);
  })()`);
  console.log('composer ring:', focusProbe);
  const FR = JSON.parse(focusProbe ?? '{}');
  if (!FR.afterClick) throw new Error('the composer ring probe found no composer');
  if (FR.afterClick.mode !== 'pointer') {
    throw new Error(`a pointer press did not set the pointer mode: ${FR.afterClick.mode}`);
  }
  // The defect: a ring after a click.
  if (!FR.afterClick.outlineIsNone || FR.afterClick.textareaShadow !== 'none') {
    throw new Error(
      `clicking into the composer still draws a ring (outline ${FR.afterClick.outline}, textarea shadow ${FR.afterClick.textareaShadow})`,
    );
  }
  if (FR.afterKey.mode !== 'keyboard') {
    throw new Error(`a keypress did not set the keyboard mode: ${FR.afterKey.mode}`);
  }
  // Not the defect, but the accessibility half of it: the keyboard must still
  // get an indication, or removing the ring for the mouse removed it for everyone.
  if (FR.afterKey.outlineIsNone) {
    throw new Error('the keyboard reaches the composer with no visible focus indication at all');
  }
  if (FR.backToPointer.outlineIsNone === false) {
    throw new Error('the ring did not clear when the pointer was used again');
  }

  // ---- 1d. (moved) ----
  // The fold check lives further down, immediately after the sidebar's blocks
  // exist. It sat here first and its probe returned `null`, because at this point
  // no `ui(state)` has arrived and the right rail is still empty — a runtime
  // ordering fact that `node --check` cannot see, and the `null` surfaced as
  // "no .collapse element", which read like a markup problem rather than a
  // too-early probe.

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

  // ---- the two rails are independent, and hiding one is reversible ----
  //
  // This is a regression test for a real defect, and the shape of it is why it
  // needs to exist: the left rail's collapse button called `setSidebarVisible`,
  // which is the **right** rail's setter. Nothing threw, nothing logged, no
  // element went missing — pressing the button simply hid a different rail and
  // left the one being pointed at on screen. Type checking cannot see it (both
  // setters take a boolean) and neither can the CSS audit.
  //
  // **Visibility is measured, not inferred from the DOM.** Both rails are now
  // permanently mounted (an unmounted element has nothing to animate, so the
  // collapse is a width transition on a clipping wrapper). `!!querySelector` was
  // the old test and it is now true in every state, which would have made this
  // whole section pass while asserting nothing. So the wrapper's measured width
  // is what gets checked.
  //
  // The sleeps are longer than the transition (`--motion-base`, 180ms) on
  // purpose: measuring mid-transition gives an arbitrary number between the two
  // ends, which is exactly the kind of flake that gets a test deleted.
  const railState = () =>
    evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const w = (s) => { const el = q(s); if (!el) return null; return Math.round(el.getBoundingClientRect().width); };
    const st = window.__aigoStore.getState();
    return JSON.stringify({
      leftW: w('.app-rail-left'),
      rightW: w('.app-rail-right'),
      leftCollapsed: !!q('.app-rail-left')?.classList.contains('is-collapsed'),
      rightCollapsed: !!q('.app-rail-right')?.classList.contains('is-collapsed'),
      leftInert: q('.app-rail-left')?.hasAttribute('inert') ?? null,
      toggle: !!q('.sessionbar .rail-toggle'),
      toggleInTopbar: !!q('.topbar .rail-toggle'),
      toggleFirstInBar: q('.sessionbar')?.firstElementChild?.classList.contains('rail-toggle') ?? null,
      store: { leftbarVisible: st.leftbarVisible, sidebarVisible: st.sidebarVisible },
    });
  })()`);

  // A rail wider than this is on screen; narrower is folded away. Well clear of
  // the transition's endpoints so a partially-completed animation cannot pass.
  const WIDE = 100;
  const FOLDED = 2;

  const beforeToggle = await railState();
  console.log('both rails, before hiding:', beforeToggle);
  const bt = JSON.parse(beforeToggle ?? '{}');
  if (!(bt.leftW > WIDE) || !(bt.rightW > WIDE)) {
    throw new Error(`both rails should start wide, got left=${bt.leftW} right=${bt.rightW}`);
  }
  if (bt.leftCollapsed || bt.rightCollapsed) throw new Error('a rail starts in the collapsed state');
  if (!bt.toggle) {
    throw new Error('no rail toggle in the session bar: hiding the left rail would be a one-way trip');
  }
  if (bt.toggleInTopbar) throw new Error('the rail toggle is still in the top bar');
  if (bt.toggleFirstInBar !== true) {
    throw new Error('the rail toggle is not the first element in the session bar');
  }

  // Press the left rail's own collapse button, as a person would.
  await evaluate(`(() => {
    document.querySelector('.lb-head .lb-icon').click();
    return true;
  })()`);
  await sleep(500);

  const afterHide = await railState();
  console.log('after hiding the left rail:', afterHide);
  const ah = JSON.parse(afterHide ?? '{}');
  if (ah.leftW > FOLDED) throw new Error(`the left rail did not fold away: width ${ah.leftW}`);
  if (ah.rightW < WIDE) {
    throw new Error(`hiding the left rail also hid the right one (width ${ah.rightW}) — the two setters are crossed`);
  }
  if (ah.rightCollapsed) throw new Error('the left rail collapsed the right one');
  if (ah.store.sidebarVisible !== true) {
    throw new Error("the left rail wrote the right rail's preference");
  }
  if (ah.store.leftbarVisible !== false) {
    throw new Error('the left rail did not write its own preference');
  }
  // A folded rail is still in the DOM, so it must be out of the tab order too.
  if (ah.leftInert !== true) {
    throw new Error('the folded left rail is still reachable by Tab: no `inert`');
  }

  // And back, with the mouse only. A rail whose restore path is a keyboard
  // shortcut is a rail a mouse user cannot get back.
  await evaluate(`(() => {
    document.querySelector('.sessionbar .rail-toggle').click();
    return true;
  })()`);
  await sleep(500);

  const afterShow = await railState();
  console.log('after restoring the left rail:', afterShow);
  const as = JSON.parse(afterShow ?? '{}');
  if (!(as.leftW > WIDE)) throw new Error(`the left rail did not come back: width ${as.leftW}`);
  if (!(as.rightW > WIDE)) throw new Error('restoring the left rail took the right one with it');
  if (as.store.leftbarVisible !== true) throw new Error('the restore did not reach the preference');
  if (as.leftInert) throw new Error('the restored left rail is still inert');

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

  // ---- a fold animates, so its content stays mounted ----
  //
  // This sits here rather than with the composer because it needs a block to
  // exist, and the right rail is empty until `ui(state)` lands above.
  //
  // The expand/collapse work rests on one property: a folded body stays in the
  // DOM with its height driven to zero, rather than being unmounted. Unmounting
  // is what the code used to do (`{open ? <Body/> : null}`), and an element that
  // appears and disappears between frames has nothing to interpolate — so the
  // animation would be a silent no-op, because both end states look identical.
  // That is why the two facts are asserted together: a leaf inside the fold must
  // still be queryable *and* the fold must have no height.
  const fold = await evaluate(`(() => {
    const block = document.querySelector('.sb-block');
    if (!block) return null;
    const head = block.querySelector('.sb-block-head');
    const foldEl = block.querySelector('.collapse');
    const countRows = () => block.querySelectorAll('.sb-row, .sb-empty, .sb-goal, .sb-progress').length;
    const snapshot = () => ({
      collapsed: foldEl?.classList.contains('is-collapsed') ?? null,
      h: foldEl ? Math.round(foldEl.getBoundingClientRect().height) : null,
      rows: countRows(),
      inert: foldEl?.hasAttribute('inert') ?? null,
    });
    const openState = snapshot();
    head.click();
    return new Promise((resolve) => setTimeout(() => {
      const closed = snapshot();
      head.click();
      setTimeout(() => resolve(JSON.stringify({
        openState, closed, reopened: snapshot(), hasFoldElement: !!foldEl,
      })), 600);
    }, 600));
  })()`);
  console.log('fold:', fold);
  const FO = JSON.parse(fold ?? '{}');
  if (fold === null) {
    throw new Error('no sidebar block to fold: `ui(state)` did not produce one');
  }
  if (!FO.hasFoldElement) {
    throw new Error('no .collapse element in a sidebar block: the fold is not using the animated wrapper');
  }
  if (!(FO.openState?.h > 0)) {
    throw new Error(`an expanded sidebar block has no height: ${JSON.stringify(FO.openState)}`);
  }
  if (!(FO.closed?.h <= 1)) {
    throw new Error(`folding a sidebar block left it with height ${FO.closed?.h}`);
  }
  if (FO.closed?.rows !== FO.openState?.rows) {
    throw new Error(
      `folding removed content from the DOM (${FO.openState?.rows} -> ${FO.closed?.rows}): the fold unmounts instead of collapsing`,
    );
  }
  if (FO.closed?.inert !== true) {
    throw new Error('a folded sidebar block is still reachable by Tab: no `inert`');
  }
  if (!(FO.reopened?.h > 0)) {
    throw new Error('the block did not expand again');
  }
  if (FO.reopened?.collapsed !== false) {
    throw new Error('the block did not return to the expanded class');
  }

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
  //
  // Measured by width, not by presence: the rail is permanently mounted now, so
  // a presence check here would assert nothing at all.
  const railDuringModal = await evaluate(`(() => {
    const bar = document.querySelector('.app-leftbar');
    const buttons = [...bar.querySelectorAll('button')];
    return JSON.stringify({
      // The rail stays readable: the prompt takes the *actions*, not the
      // information about where you are.
      width: Math.round(document.querySelector('.app-rail-left')?.getBoundingClientRect().width ?? 0),
      text: (bar.innerText ?? '').replace(/\\s+/g,' ').toLowerCase(),
      enabled: buttons.filter((b) => !b.disabled).length,
      total: buttons.length,
    });
  })()`);
  console.log('left rail during a prompt:', railDuringModal);
  const rm = JSON.parse(railDuringModal ?? '{}');
  if (!(rm.width > 100)) throw new Error(`the left rail is not on screen behind a prompt: width ${rm.width}`);
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
