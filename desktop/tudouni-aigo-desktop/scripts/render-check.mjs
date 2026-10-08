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
      welcome: !!document.querySelector('.welcome'),
      commandCount: document.querySelectorAll('.titlebar, .topbar').length,
    });
  })()`);

  console.log('mount:', mounted);
  const m = JSON.parse(mounted ?? '{}');
  if (m.childCount <= 0) throw new Error('the React tree did not mount');
  if (!m.hasApp) throw new Error('the app shell is missing');
  // No session attached: `conversationView` puts the **first screen** here, not
  // "starting the runtime…" — `booting` belongs to a session that exists but is
  // not ready yet. This check used to assert `booting` and had not followed the
  // view's documented priority order, so it failed on an untouched tree.
  if (!m.welcome) {
    throw new Error('with no session attached the UI should show the first screen');
  }

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

  // ---- 1b-bis. a rail's surface is the whole column, not just its content ----
  //
  // This is a regression test for a defect that every other assertion here was
  // blind to. Both rails were sized by their **content**, so the rail element
  // stopped at its last row: below that the wrapper painted nothing and the
  // window's own background showed through — white under the light theme, a
  // near-miss dark under the dark one. Nothing threw, no element was missing and
  // the layout was still closed; half of each rail was simply a different colour.
  //
  // The claim is therefore about **geometry**, and the probe is placed at the
  // bottom of the column, well past the last row — exactly where the rail used to
  // end. What it reads is not the rail's own `height` (a size can be right while
  // the paint is not) but the colour a point there actually resolves to, walking
  // up from the topmost element to the first ancestor that paints anything. So
  // the assertion is "the surface under the rail's bottom pixel is the rail's",
  // which is the thing a person sees.
  const railSurface = await evaluate(`(() => {
    const main = document.querySelector('.app-main');
    if (!main) return null;
    const mainBox = main.getBoundingClientRect();
    const probeY = Math.round(mainBox.bottom - 8);
    const read = (sel) => {
      const rail = document.querySelector(sel);
      if (!rail) return null;
      const b = rail.getBoundingClientRect();
      const x = Math.round(b.x + b.width / 2);
      const hit = document.elementFromPoint(x, probeY);
      // The first ancestor that paints — a transparent wrapper is not an answer.
      let node = hit, painted = null, by = null;
      while (node) {
        const c = getComputedStyle(node);
        if (c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          painted = c.backgroundColor;
          by = node.className || node.tagName;
          break;
        }
        node = node.parentElement;
      }
      return {
        h: Math.round(b.height),
        probeY,
        painted,
        by: String(by),
        railBg: getComputedStyle(rail).backgroundColor,
      };
    };
    return JSON.stringify({
      mainH: Math.round(mainBox.height),
      // Which element the point lands on, so a failure can name the culprit.
      hitAtBottom: (() => {
        const el = document.elementFromPoint(4, probeY);
        return el ? String(el.className || el.tagName) : null;
      })(),
      left: read('.app-leftbar'),
      right: read('.app-sidebar'),
    });
  })()`);
  console.log('rail surface:', railSurface);
  const RS = JSON.parse(railSurface ?? '{}');
  if (!RS.left || !RS.right) throw new Error('a rail is missing, so its surface cannot be measured');
  for (const [name, rail] of [['left', RS.left], ['right', RS.right]]) {
    // Content-sized is the defect: the rail stops short of the column.
    if (Math.abs(rail.h - RS.mainH) > 1) {
      throw new Error(
        `the ${name} rail does not span the column: ${rail.h}px of ${RS.mainH}px — the window background shows below it`,
      );
    }
    // And the point past its last row must resolve to the rail's own colour.
    if (rail.painted !== rail.railBg) {
      throw new Error(
        `the ${name} rail's bottom pixel is not painted by the rail: ${rail.painted} from "${rail.by}" vs the rail's ${rail.railBg}`,
      );
    }
    // `--bg` is what the window paints, and it is what leaked through before.
    const windowBg = await evaluate(
      `getComputedStyle(document.querySelector('.app')).backgroundColor`,
    );
    if (rail.painted === windowBg) {
      throw new Error(
        `the ${name} rail's bottom pixel shows the window background (${windowBg}) instead of the rail surface`,
      );
    }
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

  // ---- the session this harness drives ----
  //
  // Runtime facts live in `sessions[key]`, and `applyRuntimeMessage(key, msg)`
  // **drops anything addressed to a key that does not exist** — deliberately, so
  // a line in flight for a session whose child was shut down cannot resurrect a
  // bucket nothing would reap. In a plain browser there is no bridge, so nothing
  // ever calls `attachSession` and no bucket exists: every payload below would be
  // discarded silently and the run would die at the first assertion with a
  // message about the interface, not about the harness. So the bucket is made
  // here, with the same factory the real path uses, and it is the one the tree
  // draws because `activeKey` names it.
  //
  // The factory is exposed by `main.tsx` in dev builds for exactly this reason.
  const KEY = 'k-render';
  const harnessReady = await evaluate(`(() => {
    const store = window.__aigoStore;
    if (typeof window.__aigoCreateBucket !== 'function') return 'no bucket factory';
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/work/project', {
      ericai: false,
      maxSteps: null,
    });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
    }));
    window.__aigoKey = ${JSON.stringify(KEY)};
    return 'ok';
  })()`);
  if (harnessReady !== 'ok') {
    throw new Error(`the harness could not open a session bucket: ${harnessReady}`);
  }
  console.log(`session: driving bucket ${KEY}`);

  /** The active session's bucket, in the page's own context. */
  const RT = `window.__aigoStore.getState().sessions[window.__aigoKey]`;

  const apply = async (payload) => {
    const r = await evaluate(
      `(() => { window.__aigoStore.getState().applyRuntimeMessage(window.__aigoKey, ${JSON.stringify(payload)}); return true; })()`,
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
      ready: ${RT}.ready,
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
  //   - the **brand mark is drawn**, which is now the application's own icon
  //     file (`<img class="app-mark">`, the same PNG `tauri.conf.json` bundles).
  //     A missing mark renders as nothing at all — no error, no gap in the
  //     layout, just a rail that starts with a word;
  //   - the **current workspace is a row even though nothing is bookmarked**.
  //     `init.workspace` is the runtime's own answer to "where am I", and a list
  //     of bookmarks that omits it would answer "where have I been" instead.
  const leftbar = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const bar = q('.app-leftbar');
    const mark = q('.lb-head .app-mark');
    const cs = mark ? getComputedStyle(mark) : null;
    return JSON.stringify({
      present: !!bar,
      text: (bar?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 400),
      markTag: mark ? mark.tagName : null,
      markSrc: mark ? mark.getAttribute('src') : null,
      // A broken image is the failure this has to catch: it renders as an empty
      // box or as alt text, silently, with the layout intact.
      markLoaded: mark ? mark.complete && mark.naturalWidth > 0 : false,
      markRadius: cs ? cs.borderRadius : null,
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
  if (!lb.markTag) throw new Error('the left sidebar has no brand mark');
  if (lb.markTag !== 'IMG') {
    throw new Error(`the brand mark is a <${lb.markTag}>, not the application icon file`);
  }
  // The mark is the application's own drawing — the rabbit the packaged app
  // wears — and not a second, hand-drawn one. Two descriptions of one mark is
  // how they drifted the last time.
  if (!String(lb.markSrc).includes('128x128')) {
    throw new Error(`the brand mark is not the bundled application icon: ${lb.markSrc}`);
  }
  if (!lb.markLoaded) {
    throw new Error(`the brand mark did not load, so the rail shows an empty box: ${lb.markSrc}`);
  }
  // The icon file is a rounded square on an opaque black page, so without a clip
  // it wears black corners — visible as a black box on the light theme.
  if (!String(lb.markRadius) || String(lb.markRadius) === '0px') {
    throw new Error(`the brand mark is not clipped, so its black corners show: ${lb.markRadius}`);
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
  //
  // Named once, because it is applied twice: the `/resume` panel below re-asks
  // the runtime for the list, and a second hand-written copy of this fixture is
  // a second thing to keep in step with the first.
  const SESSION_ITEMS = [
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
  ];
  await apply({ v: 1, t: 'sessions', items: SESSION_ITEMS });

  const sessions = await evaluate(`(() => {
    // The saved list only. The live group (.lb-live-rows) holds the session
    // currently open with no file yet - added after this check was written -
    // and its row carries is-current by design, so counting every .lb-session
    // read 3 rows and 1 "current" on an untouched tree.
    const rows = [...document.querySelectorAll('.lb-rows:not(.lb-live-rows) .lb-session')];
    // The three lines of a row, by the y they are **painted** at. The order of
    // the lines is the point of this row and it is invisible to every text
    // assertion: \`innerText\` carries all three in either order.
    const top = (row, sel) => {
      const el = row?.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const colour = (row, sel) => {
      const el = row?.querySelector(sel);
      return el ? getComputedStyle(el).color : null;
    };
    const idEl = rows[0]?.querySelector('.lb-session-id');
    const footEl = rows[0]?.querySelector('.lb-session-foot');
    return JSON.stringify({
      count: rows.length,
      first: (rows[0]?.innerText ?? '').replace(/\\s+/g,' ').trim(),
      current: rows.filter((r) => r.classList.contains('is-current')).length,
      times: [...document.querySelectorAll('.lb-rows:not(.lb-live-rows) .lb-session-time')].map((n) => n.textContent),
      lines: {
        topic: top(rows[0], '.lb-session-preview'),
        meta: top(rows[0], '.lb-session-meta'),
        id: top(rows[0], '.lb-session-id'),
        time: top(rows[0], '.lb-session-time'),
      },
      // The id must not be painted above the topic, and the row's last line must
      // not stretch: the row is a column, so a child that grows there absorbs
      // whatever height the row has. That is now asked of the **foot** - the
      // line the id and the time share - because the id is a child of it and no
      // longer a child of the column. Inside a row, the id's own flex-grow is
      // what pushes the time to the right edge, and it is wanted.
      colours: {
        topic: colour(rows[0], '.lb-session-preview'),
        meta: colour(rows[0], '.lb-session-meta'),
        id: colour(rows[0], '.lb-session-id'),
      },
      idFlexGrow: idEl ? getComputedStyle(idEl).flexGrow : null,
      footFlexGrow: footEl ? getComputedStyle(footEl).flexGrow : null,
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
  // ---- the row reads topic, then progress, then id ----
  //
  // The id used to be the first line. Both orders render, both carry the same
  // text and both pass every assertion above, so this is asserted as geometry:
  // the topic is what identifies a conversation, and the id is a timestamp
  // (`YYYYMMDD-HHMMSS`) that belongs under it, not in front of it.
  const { topic, meta, id: idTop, time } = sr.lines ?? {};
  if (topic === null || meta === null || idTop === null || topic === undefined) {
    throw new Error(`a session row is missing one of its three lines: ${JSON.stringify(sr.lines)}`);
  }
  if (!(topic <= meta && meta <= idTop)) {
    throw new Error(
      `the session row is not topic -> progress -> id, top to bottom: ${JSON.stringify(sr.lines)}`,
    );
  }
  // The time rides the **id's** line — the row's last. It used to sit on the
  // topic's, which cost the preview a fixed ~40px on each of the two lines it
  // is clamped to; the topic is the row's only line that scales with what the
  // message actually said. The pair reads as one footnote: the runtime's name
  // for the conversation, and when it was last touched.
  if (!(time <= idTop + 1)) {
    throw new Error(
      `the time is not on the id's line: time at ${time}, id at ${idTop}`,
    );
  }
  // And the id is a footnote, not a second title. Compared as computed values
  // rather than against a hard-coded rgb, because the tokens are theme-dependent:
  // what must hold in every theme is that the id sits on the **progress line's**
  // layer and the topic does not.
  if (sr.colours.id !== sr.colours.meta) {
    throw new Error(
      `the session id is not on the metadata layer: id ${sr.colours.id}, progress ${sr.colours.meta}`,
    );
  }
  if (sr.colours.topic === sr.colours.id) {
    throw new Error(
      `the topic and the id are painted in the same colour (${sr.colours.topic}): the topic is the row's title and the id is a footnote`,
    );
  }
  // The row is a column, so a child that grows there absorbs whatever height the
  // row has. That question is now asked of the **foot** — the line the id and
  // the time share — because the id is a child of that row and no longer a child
  // of the column. Inside a row, the id's own `flex-grow` is `1` and wanted: it
  // is what pushes the stamp to the right edge.
  if (sr.footFlexGrow !== '0') {
    throw new Error(
      `the row's foot still grows (flex-grow ${sr.footFlexGrow}) — in a column row that stretches it to the row's height`,
    );
  }
  if (sr.idFlexGrow !== '1') {
    throw new Error(
      `the id does not take the foot row's slack (flex-grow ${sr.idFlexGrow}): the stamps would end wherever each id happens to`,
    );
  }

  // ---- the first screen's cards use the same order ----
  //
  // The same fact on two screens: a card here and a row in the rail open the
  // same conversation, so an order that holds on one and not the other is a
  // person having to look twice. Measured for the same reason as above.
  const card = await evaluate(`(() => {
    const slot = document.querySelector('.recent-slot:not(.is-empty)');
    if (!slot) return JSON.stringify({ missing: true });
    const top = (sel) => {
      const el = slot.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    return JSON.stringify({ topic: top('.rs-preview'), id: top('.rs-id'), time: top('.rs-time') });
  })()`);
  console.log('recent card lines:', card);
  const rc = JSON.parse(card ?? '{}');
  if (rc.missing) throw new Error('the first screen has no recent-session card to measure');
  if (!(rc.topic < rc.id)) {
    throw new Error(`the recent-session card is not topic -> id: ${JSON.stringify(rc)}`);
  }
  if (!(rc.time <= rc.id + 1)) {
    throw new Error(
      `the recent-session card does not put the time on the id's line: ${JSON.stringify(rc)}`,
    );
  }

  // ---- and the /resume panel lists the same two facts in the same order ----
  //
  // The third place the pair appears. Opening the panel **re-asks** the runtime
  // for the list (`listedSessions` goes false until the reply arrives), so the
  // payload has to be applied again behind it; without that the panel is
  // photographed saying "loading…" and this block would assert nothing at all —
  // which is exactly what the first version of it did.
  await evaluate(`(() => { window.__aigoStore.getState().openPanel('resume'); return true; })()`);
  await sleep(150);
  await apply({ v: 1, t: 'sessions', items: SESSION_ITEMS });
  const panel = await evaluate(`(() => {
    const row = document.querySelector('.dialog-body .cmdk-item');
    if (!row) return JSON.stringify({ missing: true });
    const top = (sel) => {
      const el = row.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    return JSON.stringify({
      text: (row.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      topic: top('.truncate'),
      meta: top('.row'),
      // The topic inherits the panel row's own colour (--fg-secondary); the id
      // is the faint layer under it. What has to hold is that they are not the
      // same layer — the exact rgb is the theme's business, not this check's.
      topicColour: getComputedStyle(row.querySelector('.truncate')).color,
      idColour: getComputedStyle(row.querySelector('.mono')).color,
    });
  })()`);
  console.log('resume panel row:', panel);
  const rp = JSON.parse(panel ?? '{}');
  if (rp.missing) throw new Error('the /resume panel rendered no session row');
  if (!(rp.topic < rp.meta)) {
    throw new Error(`the /resume row is not topic -> facts: ${JSON.stringify(rp)}`);
  }
  if (rp.idColour === rp.topicColour) {
    throw new Error(
      `the /resume row's id is painted as strongly as the topic (${rp.idColour}): the topic is the title and the id is a footnote`,
    );
  }
  // Closed again before the next step, so nothing below runs under a modal.
  await evaluate(`(() => { window.__aigoStore.getState().openPanel(null); return true; })()`);
  await sleep(150);

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
      notes: ${RT}.entries.filter((e) => e.kind === 'note').length,
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
    mcp: [
      { name: 'fs', state: 'loaded', tools: 12, where: 'npx fs-server' },
      // A second server that is configured but not running, so the row's
      // "Load" action (as opposed to "Unload") is actually rendered.
      { name: 'github', state: 'unload', tools: 0, where: 'https://api.github.com' },
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

  // ---- the MCP row's own load/unload control ----
  //
  // Two things are checked here and neither can fail loudly on its own:
  //
  //   - **each server has a button, and it says the right action.** A running
  //     server is one you unload; a configured one is one you load. Getting them
  //     backwards is invisible to every other assertion (the row still renders,
  //     the text still reads as English) and pressing it would do the opposite
  //     of what it says.
  //   - **the row does not overflow.** The rail is 233px wide here and 201px
  //     once the window narrows past 1180. This row already overflowed at the
  //     narrow width *before* a button was added — the long state wording took
  //     131px of it on its own — and a row that overflows is clipped, so the
  //     control silently sits past the edge where nothing can click it. Measured
  //     with `scrollWidth` because that is the number the layout actually has.
  const mcpRail = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll('.sb-block')];
    const mcp = blocks.find((b) => (b.querySelector('.sbh-title')?.textContent ?? '') === 'MCP');
    if (!mcp) return JSON.stringify({ error: 'no MCP block' });
    const rows = [...mcp.querySelectorAll('.sb-row')].map((row) => {
      const button = row.querySelector('.mcp-act');
      return {
        name: row.querySelector('.sbr-main')?.textContent?.trim() ?? '',
        state: row.querySelector('.badge')?.textContent?.trim() ?? '',
        buttonText: button ? (button.textContent ?? '').trim() : null,
        buttonLabel: button ? (button.getAttribute('aria-label') ?? '') : null,
        buttonW: button ? Math.round(button.getBoundingClientRect().width) : null,
        // The whole row versus the space it is given.
        over: row.scrollWidth - row.clientWidth,
        client: row.clientWidth,
      };
    });
    return JSON.stringify(rows);
  })()`);
  console.log('mcp rail rows:', mcpRail);
  const mcpRows = JSON.parse(mcpRail ?? '[]');
  if (mcpRows.error) throw new Error(`no MCP block in the rail: ${mcpRows.error}`);
  if (mcpRows.length !== 2) {
    throw new Error(`expected 2 MCP rows in the rail, got ${mcpRows.length}`);
  }
  for (const row of mcpRows) {
    if (row.buttonText === null) {
      throw new Error(`the MCP row for "${row.name}" has no load/unload button`);
    }
    // The action word is the *other* state's answer.
    const expectedAction = row.state === 'running' ? 'Unload' : 'Load';
    if (row.buttonText !== expectedAction) {
      throw new Error(
        `the button on "${row.name}" (state "${row.state}") says "${row.buttonText}", ` +
          `expected "${expectedAction}"`,
      );
    }
    // A bare "Load" is ambiguous to a screen reader; the name has to be in there.
    if (!row.buttonLabel.includes(row.name)) {
      throw new Error(
        `the button's accessible name does not say which server: "${row.buttonLabel}"`,
      );
    }
    // A control squeezed below its own hit target is on screen but not usable.
    if (!(row.buttonW >= 22)) {
      throw new Error(`the button on "${row.name}" collapsed to ${row.buttonW}px`);
    }
    if (row.over > 0) {
      throw new Error(
        `the rail MCP row for "${row.name}" overflows its ${row.client}px by ${row.over}px — ` +
          `the button is outside the row where it cannot be clicked`,
      );
    }
  }
  // One of each state, so both actions were actually rendered.
  const actions = mcpRows.map((r) => r.buttonText).sort();
  if (JSON.stringify(actions) !== JSON.stringify(['Load', 'Unload'])) {
    throw new Error(`expected one Load and one Unload row, got ${JSON.stringify(actions)}`);
  }

  // Press the "Load" button and check what actually reached the store.
  //
  // Rendering a button is not the same as wiring one, and the difference is
  // invisible here: the row would look identical either way. So the click is
  // performed and the store is read — `mcpPending` is the front end's own record
  // that a request went out, and `uiState` must be untouched, because a request
  // is not allowed to make the screen claim a server is up before the runtime
  // has answered.
  const pressed = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.app-sidebar .sb-row')];
    const loadRow = rows.find((r) => (r.querySelector('.mcp-act')?.textContent ?? '').trim() === 'Load');
    if (!loadRow) return JSON.stringify({ error: 'no Load button' });
    const name = loadRow.querySelector('.sbr-main')?.textContent?.trim() ?? '';
    // The mark must be clear before the press, or the assertion below would pass
    // on a leftover from something else.
    const before = [...${RT}.mcpPending];
    loadRow.querySelector('.mcp-act').click();
    return JSON.stringify({ name, before, after: [...${RT}.mcpPending] });
  })()`);
  console.log('mcp rail, after pressing Load:', pressed);
  const pr = JSON.parse(pressed ?? '{}');
  if (pr.error) throw new Error(`could not press the rail's load button: ${pr.error}`);
  if (pr.before.length !== 0) {
    throw new Error(`a server was already marked in flight before any press: ${pr.before}`);
  }
  if (!pr.after.includes(pr.name)) {
    throw new Error(
      `pressing "Load" on "${pr.name}" did not reach the store: mcpPending = ${JSON.stringify(pr.after)}`,
    );
  }
  // Read the DOM on the next tick: React commits asynchronously, so reading the
  // row in the same tick as the click would see the state before the press.
  await sleep(150);
  const afterPress = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.app-sidebar .sb-row')];
    const loadRow = rows.find((r) => (r.querySelector('.mcp-act')?.getAttribute('aria-label') ?? '').startsWith('Waiting'));
    if (!loadRow) return JSON.stringify({ error: 'the pressed row is not marked as waiting' });
    const button = loadRow.querySelector('.mcp-act');
    return JSON.stringify({
      name: loadRow.querySelector('.sbr-main')?.textContent?.trim() ?? '',
      state: loadRow.querySelector('.badge')?.textContent?.trim() ?? '',
      disabled: button.disabled,
      label: button.getAttribute('aria-label'),
      dots: !!button.querySelector('.dots'),
    });
  })()`);
  console.log('mcp rail, while the request is out:', afterPress);
  const ap = JSON.parse(afterPress ?? '{}');
  if (ap.error) throw new Error(ap.error);
  // The press is not allowed to have written a runtime fact: the badge is still
  // whatever `ui(state)` said, never what the request hopes for.
  if (ap.state !== 'not loaded') {
    throw new Error(`the press changed the row's state to "${ap.state}": that is an optimistic update`);
  }
  // While the request is out the button says so and refuses a second press.
  if (ap.disabled !== true) {
    throw new Error('the button stayed pressable while its request was still in flight');
  }
  if (!ap.dots) {
    throw new Error('the waiting button shows no busy indicator (component-states §0 Loading)');
  }
  // The waiting label has to name the server, and it has to be *interpolated*:
  // an unfilled `{name}` reads aloud as "brace name" and would sail past every
  // check above (the label is a non-empty string either way). This is the shape
  // of bug that got through once already.
  if (!ap.label.includes(ap.name) || ap.label.includes('{name}')) {
    throw new Error(
      `the waiting label did not substitute the server name: "${ap.label}" for "${ap.name}"`,
    );
  }
  // Put the store back so the checks below see a clean screen.
  await evaluate(`(() => {
    window.__aigoStore.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'ui', kind: 'mcp', mcp_servers: [
      { name: 'fs', state: 'loaded', tools: 12, where: 'npx fs-server' },
      { name: 'github', state: 'unload', tools: 0, where: 'https://api.github.com' },
    ], mcp_notes: [] });
    return true;
  })()`);
  await sleep(150);
  // The reply released the mark, so the row is pressable again.
  const released = await evaluate(
    `JSON.stringify(${RT}.mcpPending)`,
  );
  if (released !== '[]') {
    throw new Error(`the runtime's reply did not release the in-flight mark: ${released}`);
  }

  // ---- the rail lists every row, and the status bar reports no fraction ----
  //
  // Two presentations that were inherited from the terminal front end, where
  // the constraint behind each of them is real. Neither constraint exists here.
  //
  // **A block is not capped.** Decision 6 stopped each block at five rows and
  // folded the rest into `(+N more)`; that cap came from the TUI's rail, which
  // is a **fixed-height column that cannot scroll** (`internal/frontends/tui/
  // rail.go`, `railMaxRows` / `clipBlock`), so it has to clip or a block becomes
  // unreachable. This rail scrolls (`.sidebar-inner` is `overflow-y: auto`), so
  // the cap only hid rows a reader could have scrolled to.
  //
  // **The step count has no denominator.** `session.steps` is
  // `ui(state).steps` — every assistant message in the conversation, so it
  // grows and a resumed session starts high. `session.maxSteps` is
  // `init.max_steps` — `--max-steps`, the budget for **one turn**, which the
  // agent's loop resets each turn. Printed as a fraction that reads
  // `step 497 / 120`; the per-turn progress belongs on the turn head, where
  // both numbers come from the same entry.
  //
  // Both failures are invisible without an assertion: a capped list renders
  // perfectly, and so does an uncapped one — the difference is rows that are
  // simply not there. So the count is checked against the payload, the
  // `(+N more)` marker is checked absent, and the step cell is checked for the
  // absence of a `/`.
  const MANY = 8;
  await apply({
    v: 1,
    t: 'ui',
    kind: 'state',
    todos: Array.from({ length: MANY }, (_, i) => ({
      content: `task number ${i + 1}`,
      status: i < 3 ? 'completed' : 'pending',
    })),
    skills: [],
    skill_catalog: [],
    jobs: [],
    subagents: [],
    messages: 4,
    steps: 2,
    model: 'deepseek-chat',
    model_provider: 'deepseek',
    model_window: 65536,
    thinking: true,
    effort: 'high',
    effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    autopilot: false,
    granted_tools: [],
    granted_prefixes: [],
    denied_tools: [],
    risk_scope: [],
    agents_md: [],
    mcp: [],
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

  const uncapped = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll('.sb-block')];
    const tasks = blocks.find((b) => (b.querySelector('.sbh-title')?.textContent ?? '') === 'Tasks');
    const rows = tasks ? [...tasks.querySelectorAll('.sb-row')] : [];
    const nums = rows.map((r) => Number((r.querySelector('.sbr-main')?.textContent ?? '').trim().replace('task number ', '')));
    return JSON.stringify({
      rowCount: rows.length,
      // The rows actually present, by number, so a missing one is nameable.
      nums: nums.filter((n) => Number.isFinite(n)),
      railText: (document.querySelector('.app-sidebar')?.innerText ?? '').replace(/\\s+/g, ' '),
      statusText: (document.querySelector('.statusbar .st-left')?.innerText ?? '').replace(/\\s+/g, ' '),
    });
  })()`);
  console.log('uncapped rail:', uncapped);
  const uc = JSON.parse(uncapped ?? '{}');
  if (uc.rowCount !== MANY) {
    throw new Error(
      `the Tasks block drew ${uc.rowCount} of ${MANY} rows: the rail is still capping its content`,
    );
  }
  for (let i = 1; i <= MANY; i += 1) {
    if (!uc.nums.includes(i)) {
      throw new Error(`task number ${i} is missing from the rail (drew ${JSON.stringify(uc.nums)})`);
    }
  }
  // The marker itself, not merely a short list: `(+N more)` is what the cap
  // used to say, and an unfilled `{n}` would still be a non-empty string.
  if (/\(\+\s*\d+\s*more\)/i.test(uc.railText)) {
    throw new Error(`the rail still prints a "(+N more)" marker: ${uc.railText}`);
  }
  if (!uc.railText.includes(`3/${MANY}`)) {
    throw new Error(`the Tasks count badge does not name all ${MANY}: ${uc.railText}`);
  }
  // Cumulative steps, no denominator. A `/` in this cell is the `step 497 / 120`
  // shape coming back.
  if (!uc.statusText.includes('2 steps')) {
    throw new Error(`the status bar does not report cumulative steps: "${uc.statusText}"`);
  }
  if (/\d+\s*\/\s*\d+/.test(uc.statusText)) {
    throw new Error(
      `the status bar still pairs a cumulative count with a per-turn cap: "${uc.statusText}"`,
    );
  }

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

  // ---- the bar's usage numbers move per step, not per turn ----
  //
  // They used to come only from `ui(status)`, which is requested when a turn
  // ends (decision 5 — `status` reads the audit log and must not become a
  // heartbeat), so a long turn sat on the previous turn's figures and then
  // jumped; a turn that grew to 300k tokens showed the whole jump at once. The
  // `model_call` event carries the same four fields and was already arriving, so
  // the last successful call is read off the stream as it lands.
  //
  // **No `ui(status)` has been fed anywhere in this script**, and that is the
  // assertion: the figures below can only have come from the `model_call` above.
  const liveBar = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('.statusbar .st-right .st-chip')];
    return JSON.stringify({
      metrics: chips.map((c) => (c.querySelector('.st-metric')?.textContent ?? '').trim()),
      right: (document.querySelector('.statusbar .st-right')?.innerText ?? '').replace(/\\s+/g, ' '),
    });
  })()`);
  console.log('status bar, live usage:', liveBar);
  const bar = JSON.parse(liveBar ?? '{}');
  // 1000 prompt tokens, 700 of them cached → the context chip reports the amount
  // and the cache chip reports that call's own 70%.
  if (!(bar.metrics ?? []).includes('70%')) {
    throw new Error(`the cache chip does not report the call's own ratio: ${JSON.stringify(bar.metrics)}`);
  }
  if (!(bar.right ?? '').includes('1,000')) {
    throw new Error(`the context chip does not report the call's prompt size: ${bar.right}`);
  }

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

  // ---- 2b. quiet mode folds the thinking block even while it streams ----
  //
  // This is a regression test for a defect the mode's own name made invisible:
  // quiet folds tool calls into a one-line brief, and then a block that opened
  // itself the moment the model started thinking put a wall of text back on the
  // screen — the one thing the mode exists to prevent. The TUI has always folded
  // its thinking line under quiet (`internal/frontends/tui/view.go`), so the two
  // front ends disagreed about what the mode means.
  //
  // The forced-open rule is deliberately kept for **normal** mode, and that half
  // is asserted too: removing it there would be a different defect (a live
  // reasoning block you can no longer watch arrive). And the manual choice has to
  // win in both modes, or quiet would be a mode you cannot read your way out of.
  //
  // A fresh run is driven here rather than reusing the finished turn above,
  // because `streaming` is the field under test: only a block that is still being
  // written is forced open in normal mode, and a settled one would pass this by
  // accident.
  await apply({
    v: 1,
    t: 'event',
    kind: 'run_started',
    session_id: 's-render',
    run_id: 'r-2',
    step: 0,
    ts: '2026-01-01T00:00:05Z',
    model: 'deepseek-chat',
    provider: 'deepseek',
  });
  await apply({
    v: 1,
    t: 'delta',
    session_id: 's-render',
    run_id: 'r-2',
    step: 0,
    channel: 'reasoning',
    text: 'let me think about the reconnect race carefully',
    reset: false,
  });

  // The **last** block: run 1's finalized reasoning is still on screen above this
  // one, and reading the first would be reading the wrong turn.
  const reasonState = () =>
    evaluate(`(() => {
    const all = [...document.querySelectorAll('.e-reason')];
    const last = all[all.length - 1];
    if (!last) return JSON.stringify({ present: false });
    const fold = last.querySelector('.collapse');
    return JSON.stringify({
      present: true,
      count: all.length,
      open: fold ? !fold.classList.contains('is-collapsed') : null,
      foldH: fold ? Math.round(fold.getBoundingClientRect().height) : null,
      streaming: ${RT}.entries.filter((e) => e.kind === 'reason').pop()?.streaming ?? null,
      quiet: ${RT}.quiet,
    });
  })()`);

  const normalReason = JSON.parse((await reasonState()) ?? '{}');
  console.log('reasoning, normal mode, live:', JSON.stringify(normalReason));
  if (!normalReason.present) throw new Error('no reasoning block to measure');
  if (normalReason.streaming !== true) {
    throw new Error('the reasoning block is not streaming, so the forced-open rule is not under test');
  }
  if (normalReason.open !== true) {
    throw new Error('normal mode closed a live reasoning block: watching it arrive is the point of the mode');
  }

  await evaluate(`(() => { window.__aigoStore.getState().setQuiet(true); return true; })()`);
  await sleep(300);
  const quietReason = JSON.parse((await reasonState()) ?? '{}');
  console.log('reasoning, quiet mode, live:', JSON.stringify(quietReason));
  // The defect: a live block that forces itself open under quiet.
  if (quietReason.open !== false) {
    throw new Error(
      `quiet mode still opened the live reasoning block (open=${quietReason.open}, height=${quietReason.foldH})`,
    );
  }
  if (!(quietReason.foldH <= 1)) {
    throw new Error(`the folded reasoning block still has height ${quietReason.foldH}`);
  }

  // The manual choice still wins under quiet: a person who wants to read it can.
  await evaluate(
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true })); return true; })()`,
  );
  await sleep(300);
  const openedReason = JSON.parse((await reasonState()) ?? '{}');
  console.log('reasoning, quiet mode, after Ctrl+T:', JSON.stringify(openedReason));
  if (openedReason.open !== true) {
    throw new Error('Ctrl+T does not open the reasoning block under quiet: the mode became unreadable');
  }

  await evaluate(`(() => { window.__aigoStore.getState().setQuiet(false); return true; })()`);
  await sleep(200);

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
      autopilot: ${RT}.uiState?.autopilot,
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
  //
  // The rule is about **runtime** actions, not about buttons: the two local-only
  // controls may stay live, because neither touches anything the runtime is
  // holding. One is the rail's own collapse toggle; the other is the sessions
  // fold, which is a preference (`persistPrefs`) and sends no message at all.
  // This used to count enabled buttons and allow exactly one, which was true
  // only until the fold toggle was added — since then it failed on an untouched
  // codebase, which is how it was found. Naming the allowed controls is what
  // keeps it from going stale again: a new button fails this unless somebody
  // decides, here, that it is local.
  const railDuringModal = await evaluate(`(() => {
    const bar = document.querySelector('.app-leftbar');
    const buttons = [...bar.querySelectorAll('button')];
    return JSON.stringify({
      // The rail stays readable: the prompt takes the *actions*, not the
      // information about where you are.
      width: Math.round(document.querySelector('.app-rail-left')?.getBoundingClientRect().width ?? 0),
      text: (bar.innerText ?? '').replace(/\\s+/g,' ').toLowerCase(),
      live: buttons.filter((b) => !b.disabled).map((b) => {
        const cls = typeof b.className === 'string' ? b.className : '';
        return {
          local: cls.includes('lb-section-toggle') || cls.includes('lb-icon'),
          what: (b.getAttribute('aria-label') ?? b.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0, 40),
          cls: cls.split(' ')[0],
        };
      }),
      total: buttons.length,
    });
  })()`);
  console.log('left rail during a prompt:', railDuringModal);
  const rm = JSON.parse(railDuringModal ?? '{}');
  if (!(rm.width > 100)) throw new Error(`the left rail is not on screen behind a prompt: width ${rm.width}`);
  if (!rm.text.includes('project')) {
    throw new Error('the rail stopped saying which workspace is current behind a prompt');
  }
  // Everything still live must be a control this front end owns outright. A
  // `lb-icon` that starts a workspace or re-reads sessions is disabled above, so
  // reaching this with one enabled means a real action escaped the prompt.
  const escaped = (rm.live ?? []).filter((b) => !b.local);
  if (escaped.length > 0) {
    throw new Error(
      `${escaped.length} rail control(s) stayed live behind a prompt: ` +
        escaped.map((b) => `"${b.what}" (.${b.cls})`).join(', '),
    );
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

  // ---- 5. the command palette, and the command table ----
  await evaluate(`(() => { window.__aigoStore.getState().openPanel('commands'); return true; })()`);
  await sleep(400);
  const palette = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.cmdk-item .cmd-name')].map((n) => n.textContent);
    return JSON.stringify({ count: rows.length, rows });
  })()`);
  console.log('command palette:', palette);
  const pal = JSON.parse(palette ?? '{}');
  // 19 = `COMMANDS` in `src/commands.ts` (files and terminal joined after this
  // check was written; keep the number tied to that table, not to a memory).
  if (pal.count !== 19) throw new Error(`expected 19 commands, got ${pal.count}`);
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
