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

  // ---- 1b. the conversation column owns the composer AND the session bar;
  //          the status bar spans the window ----
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
    const sessionBar = q('.sessionbar');
    // The left rail opens straight at its primary action ('.lb-new', the
    // new-session button's band) — the named head it used to open with moved to
    // the top bar. Its block top is the rail's own top, so the band check below
    // still reads the pair of rails.
    const leftTop = Math.round(q('.lb-new')?.getBoundingClientRect().top ?? -1);
    const rightTop = Math.round(q('.rb-head')?.getBoundingClientRect().top ?? -1);
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
      // The session bar is the **conversation column's** header: a direct child
      // of the column, NOT of the shell. A window-wide bar read every rail as
      // one conversation's facts and stopped the rails from reaching this row.
      sessionbarIsShellChild: !!q('.app > .sessionbar'),
      sessionbarInConversation: !!conv?.querySelector(':scope > .sessionbar'),
      sessionbarBox: box(sessionBar),
      // With the bar inside the column, both rail heads and it share one band:
      // their tops agree, which is what alignments across a rail boundary need.
      leftTop,
      rightTop,
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
  if (L.sessionbarIsShellChild) {
    throw new Error("the session bar is still a window-spanning row: it should be the conversation column's header");
  }
  if (!L.sessionbarInConversation) {
    throw new Error("the session bar is not the conversation column's header");
  }
  // The status bar spans the whole window, so it starts at x=0 and is as wide as
  // the viewport — the rails must not extend past it to the bottom.
  if (L.statusBox && (L.statusBox.x !== 0 || L.statusBox.w !== L.viewportW)) {
    throw new Error(`the status bar does not span the window: ${JSON.stringify(L.statusBox)} of ${L.viewportW}px`);
  }
  // The session bar is the conversation column's own header: exactly as wide as
  // the column — not the window — so the two sidebars reach the top of this row.
  if (L.sessionbarBox && L.convBox) {
    if (Math.abs(L.sessionbarBox.w - L.convBox.w) > 1) {
      throw new Error(`the session bar is not the conversation column's width: bar ${L.sessionbarBox.w}, column ${L.convBox.w}`);
    }
    if (Math.abs(L.sessionbarBox.x - L.convBox.x) > 1) {
      throw new Error(`the session bar's left edge is not the column's: ${L.sessionbarBox.x} vs ${L.convBox.x}`);
    }
  }
  // One band across the conversation row: the two rails' first rows and the
  // session bar start at the same y. A taller first row than its neighbour shows
  // as a step at the rail boundary — the exact failure the band check below
  // watches for.
  if (L.sessionbarBox && L.leftTop >= 0 && L.rightTop >= 0) {
    if (Math.abs(L.leftTop - L.rightTop) > 1) {
      throw new Error(`the two rails' first rows do not share one band: left ${L.leftTop}, right ${L.rightTop}`);
    }
    if (Math.abs(L.sessionbarBox.y - L.leftTop) > 2) {
      throw new Error(`the session bar and the rails' first rows are not on one band: bar ${L.sessionbarBox.y}, rails ${L.leftTop}`);
    }
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
  // the assertion is "the surface under the rail's bottom pixel belongs to the
  // rail", which is the thing a person sees.
  //
  // **Belongs to**, not "is the rail's own colour": the left rail's foot paints
  // a surface of its own (`--bg-foot`, the workbench's band), and the point at
  // the bottom of the column lands on it. That is a deliberate second surface
  // *inside* the rail, not a gap. It is **named** rather than waved through as
  // "painted by any descendant", the same way the controls allowed to stay live
  // behind a prompt are named further down: a third surface has to be decided on
  // here, and until then it fails. The window's own colour is still a failure by
  // any route — that is the `--bg` assertion below.
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
      let node = hit, painted = null, by = null, belongs = false;
      while (node) {
        const c = getComputedStyle(node);
        if (c.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          painted = c.backgroundColor;
          by = node.className || node.tagName;
          belongs = node === rail || node.classList?.contains('lb-foot') === true
            || node.classList?.contains('lb-workbench') === true;
          break;
        }
        node = node.parentElement;
      }
      return {
        h: Math.round(b.height),
        probeY,
        painted,
        by: String(by),
        belongs,
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
    // And the point past its last row must resolve to the rail's own surface, or
    // to the band its foot paints inside it.
    if (rail.painted !== rail.railBg && !rail.belongs) {
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

  // ---- 1c. the composer's empty state: one 48px row, exactly two controls ----
  //
  // The redesign's claim is that an empty composer is **one row** — `+`, the
  // placeholder, the action — and reserves no toolbar. That is a layout fact no
  // text assertion can see: every element is still present if the box goes back
  // to two rows; it just takes twice the height and the transcript pays for it.
  // The filled state is measured later, once a session exists to hold a draft.
  const composer = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null; };
    const cp = q('.cp-box');
    const ta = q('.composer textarea');
    const add = q('.cp-add');
    const send = q('.cp-send');
    const note = q('.cp-note');
    const c = cp ? getComputedStyle(cp) : null;
    return JSON.stringify({
      boxBox: box(cp),
      taBox: box(ta),
      addBox: box(add),
      sendBox: box(send),
      display: c?.display ?? null,
      filled: cp?.classList.contains('is-filled') ?? null,
      gridAreas: c?.gridTemplateAreas ?? null,
      // Every focusable control in the composer, named, so a third one shows up
      // by name rather than as a changed count.
      controls: [...(cp?.querySelectorAll('button') ?? [])].map((b) => b.className),
      // The removed pieces.
      hintRow: !!q('.cp-hint'),
      toolsRow: !!q('.cp-tools'),
      note: note ? note.innerText : null,
      placeholder: ta?.placeholder ?? null,
    });
  })()`);
  console.log('composer:', composer);
  const C = JSON.parse(composer ?? '{}');

  if (C.display !== 'grid') {
    throw new Error(`the composer box is not the two-state grid: display is ${C.display}`);
  }
  if (C.filled !== false) throw new Error('an empty composer claims to be filled');
  if (Math.abs((C.boxBox?.h ?? -1) - 48) > 1) {
    throw new Error(`the empty composer is ${C.boxBox?.h}px, not the design's 48px`);
  }
  if (!(C.taBox && C.addBox && C.sendBox)) {
    throw new Error('the empty composer is missing the input or a control');
  }
  // One row: the input's centre, the plus's centre and the action's centre all
  // sit on the same line.
  const centreY = (b) => b.y + b.h / 2;
  if (Math.abs(centreY(C.taBox) - centreY(C.addBox)) > 2 || Math.abs(centreY(C.addBox) - centreY(C.sendBox)) > 2) {
    throw new Error(
      `the empty composer is not one row: input ${JSON.stringify(C.taBox)}, plus ${JSON.stringify(C.addBox)}, action ${JSON.stringify(C.sendBox)}`,
    );
  }
  // And left-to-right: plus, input, action.
  if (C.addBox.x >= C.taBox.x) throw new Error('the plus is not at the leading edge');
  if (!(C.taBox.x + C.taBox.w <= C.sendBox.x)) throw new Error('the send button overlaps the input');
  if (C.taBox.w < 100) throw new Error(`the input is not a full-width line: width ${C.taBox.w}`);
  if (C.controls.length !== 2) {
    throw new Error(`expected 2 composer controls, found ${C.controls.length}: ${JSON.stringify(C.controls)}`);
  }
  if (C.note !== null) throw new Error(`the empty composer reserves a toolbar ("${C.note}")`);
  if (C.hintRow) throw new Error('the hint row below the composer is still rendered');
  if (C.toolsRow) throw new Error('the old single-row tools container is still rendered');
  if (C.placeholder !== 'Say something…') {
    throw new Error(`the empty placeholder still carries the key hint: "${C.placeholder}"`);
  }
  // ---- the composer box wears no focus ring at all ----
  //
  // The box is the largest control on screen; a ring around it would frame a
  // third of the window, so it draws none — the caret is the keyboard's
  // indication inside it. (This used to assert the opposite: that the keyboard
  // must see a neutral outline. The rule changed on purpose.) The probe still
  // measures all three surfaces (`outline` on the box, `box-shadow` on the box
  // and the textarea) and still drives real input modalities — `ta.focus()` in
  // script matches `:focus-visible` no matter what, so the modality distinction
  // has to come from real events.
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
    // 2. A keypress, then focus — the box must stay ring-free here too.
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
  if (FR.afterKey.mode !== 'keyboard') {
    throw new Error(`a keypress did not set the keyboard mode: ${FR.afterKey.mode}`);
  }
  // No surface of the box may carry a focus ring, in either modality.
  for (const [label, r] of Object.entries(FR)) {
    if (!r) continue;
    if (!r.outlineIsNone) {
      throw new Error(`the composer box draws an outline after ${label}: ${r.outline}`);
    }
    if (r.textareaShadow !== 'none') {
      throw new Error(`the composer textarea carries a shadow after ${label}: ${r.textareaShadow}`);
    }
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
      // A **second** workspace so the rail has an idle row to measure against
      // the current one. The current workspace is prepended from the session's
      // own init.workspace; without this, a browser with no saved preferences
      // (a fresh profile, a CI run) has exactly one row and the layer-model probe
      // has nothing idle to read.
      workspaces: ['C:/work/other'],
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
  // The permission statement moved out with the bar's demotion to a
  // column-level header: it named the sidebar's disposition, and the collapsed
  // summary + the SettingsPanel are its homes now. A leftover "asks on" here
  // would be a second copy of the runtime's judgement.
  if (ai.sessionbar?.includes('asks on')) {
    throw new Error(`the session bar still draws the permission statement: ${ai.sessionbar}`);
  }

  // ---- 2b. the composer's filled state ----
  //
  // The empty state was measured before any session existed; the filled state
  // needs a draft, and a draft belongs to a session. Now there is one. What is
  // asserted is the design's "two fixed heights": 96px with the input on its
  // own full-width line and the toolbar under it, the key hint in that toolbar,
  // and a send button that is enabled and filled with the accent because there
  // is something to send.
  await evaluate(`(() => {
    window.__aigoStore.getState().setDraft('A draft with something to send');
    return true;
  })()`);
  await sleep(300);
  const filledComposer = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const boxEl = (el) => {
      const b = el?.getBoundingClientRect();
      return b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) } : null;
    };
    const cp = q('.cp-box');
    const ta = q('.composer textarea');
    const add = q('.cp-add');
    const send = q('.cp-send');
    const note = q('.cp-note');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--accent);border:1px solid var(--accent-border)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    const accentBorder = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const c = cp ? getComputedStyle(cp) : null;
    return JSON.stringify({
      filled: cp?.classList.contains('is-filled') ?? null,
      h: Math.round(cp?.getBoundingClientRect().height ?? -1),
      ta: boxEl(ta),
      add: boxEl(add),
      send: boxEl(send),
      areas: c?.gridTemplateAreas ?? null,
      note: (note?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      sendDisabled: send?.disabled ?? null,
      sendBg: send ? getComputedStyle(send).backgroundColor : null,
      accent,
      border: c?.borderTopColor ?? null,
      accentBorder,
      transition: c ? c.transitionProperty + ' ' + c.transitionDuration + ' ' + c.transitionTimingFunction : null,
    });
  })()`);
  console.log('composer, filled:', filledComposer);
  const CF = JSON.parse(filledComposer ?? '{}');
  if (CF.filled !== true) throw new Error('a draft did not fill the composer');
  if (Math.abs(CF.h - 96) > 1) {
    throw new Error(`the filled composer is ${CF.h}px, not the design's 96px`);
  }
  if (!(CF.ta && CF.add && CF.send)) throw new Error('the filled composer is missing a control');
  if (!(CF.ta.bottom <= CF.add.y)) {
    throw new Error(
      `the toolbar is not under the input: input bottom ${CF.ta.bottom}, plus top ${CF.add.y}`,
    );
  }
  if (Math.abs(CF.add.y - CF.send.y) > 2) {
    throw new Error('the plus and the action are not on the same toolbar row');
  }
  if (!String(CF.areas).includes('input input input') || !String(CF.areas).includes('add note send')) {
    throw new Error(`the filled grid does not give the input its own line: ${CF.areas}`);
  }
  if (!CF.note.includes('Enter sends') || !CF.note.includes('Shift+Enter')) {
    throw new Error(`the key hint is missing from the filled toolbar: "${CF.note}"`);
  }
  if (CF.sendDisabled !== false) throw new Error('send is disabled with a non-empty draft');
  if (CF.sendBg !== CF.accent) {
    throw new Error(`the available send is not the accent fill: ${CF.sendBg} vs ${CF.accent}`);
  }
  if (CF.border !== CF.accentBorder) {
    throw new Error(`the filled composer has no accent edge: ${CF.border} vs ${CF.accentBorder}`);
  }
  if (
    !String(CF.transition).includes('height') ||
    !(String(CF.transition).includes('200ms') || String(CF.transition).includes('0.2s'))
  ) {
    throw new Error(`the height switch is not the design's 200ms transition: ${CF.transition}`);
  }

  // And the switch is reversible: clearing the draft returns the box to one row
  // and takes the toolbar with it.
  await evaluate(`(() => {
    window.__aigoStore.getState().setDraft('');
    return true;
  })()`);
  await sleep(300);
  const backToEmpty = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const cp = q('.cp-box');
    return JSON.stringify({
      filled: cp?.classList.contains('is-filled') ?? null,
      h: Math.round(cp?.getBoundingClientRect().height ?? -1),
      note: !!q('.cp-note'),
    });
  })()`);
  console.log('composer, back to empty:', backToEmpty);
  const BE = JSON.parse(backToEmpty ?? '{}');
  if (BE.filled !== false || Math.abs(BE.h - 48) > 1 || BE.note) {
    throw new Error(`clearing the draft did not return the composer to 48px: ${JSON.stringify(BE)}`);
  }

  // ---- the left rail: workspaces and sessions ----
  //
  // Two assertions here, and both are about things that cannot fail loudly:
  //   - the **brand mark is drawn**, which is the application's own icon file
  //     (`<img class="app-mark">`, the same PNG `tauri.conf.json` bundles). It
  //     lives in the **top bar** now, left of the program name — the left rail
  //     used to draw mark and name again one row lower, and the top bar carries
  //     both. A missing mark renders as nothing at all — no error, no gap in
  //     the layout, just a name with nothing beside it;
  //   - the **current workspace is a row even though nothing is bookmarked**.
  //     `init.workspace` is the runtime's own answer to "where am I", and a list
  //     of bookmarks that omits it would answer "where have I been" instead.
  const leftbar = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const bar = q('.app-leftbar');
    const mark = q('.topbar .brand .app-mark');
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
      // The identity left the rail for the top bar; a mark or a brand row drawn
      // back inside the rail is the old double statement returning.
      railMark: !!q('.app-leftbar .app-mark'),
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
  if (!lb.markTag) throw new Error('the top bar has no brand mark');
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
    throw new Error(`the brand mark did not load, so the bar shows an empty box: ${lb.markSrc}`);
  }
  // The icon file is a rounded square on an opaque black page, so without a clip
  // it wears black corners — visible as a black box on the light theme.
  if (!String(lb.markRadius) || String(lb.markRadius) === '0px') {
    throw new Error(`the brand mark is not clipped, so its black corners show: ${lb.markRadius}`);
  }
  if (lb.railMark) {
    throw new Error('the left rail still draws the app mark that moved to the top bar');
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
      // The two rail toggles, which are now the **only** way either rail is
      // folded. leftToggle / rightToggle are found by their position in the bar
      // rather than by a class of their own, so a button that drifted out of the
      // ends is not found at all.
      toggle: !!q('.sessionbar .rail-toggle'),
      leftToggle: !!q('.sessionbar > .rail-toggle:first-child'),
      rightToggle: !!q('.sessionbar > .rail-toggle:last-child'),
      toggleCount: q('.sessionbar')?.querySelectorAll('.rail-toggle').length ?? 0,
      toggleInTopbar: !!q('.topbar .rail-toggle'),
      // **Outside the scroller** is the property that keeps them reachable: only
      // .sb-scroll overflows, so no session id can carry a toggle off the edge.
      toggleInScroller: !!q('.sessionbar .sb-scroll .rail-toggle'),
      rightToggleDisabled: q('.sessionbar > .rail-toggle:last-child')?.disabled ?? null,
      rightToggleExpanded: q('.sessionbar > .rail-toggle:last-child')?.getAttribute('aria-expanded') ?? null,
      // The session board's door, which lives here for the reason the two
      // toggles do: the rail's own copy of this button is inert the moment the
      // rail is folded. Its **position** is asserted rather than merely its
      // existence — "right of the collapse button" is the request, and a button
      // that drifted to the far end would render, work, and be wrong.
      boardBtn: !!q('.sessionbar .sb-board'),
      // Outside the scroller, like the toggles: with the left rail folded this
      // is the only way to the board, so a long session id must not be able to
      // scroll it away.
      boardBtnInScroller: !!q('.sessionbar .sb-scroll .sb-board'),
      boardBtnIndex: (() => {
        const bar = q('.sessionbar');
        const b = q('.sessionbar .sb-board');
        return bar && b ? [...bar.children].indexOf(b) : -1;
      })(),
      boardBtnLabel: q('.sessionbar .sb-board')?.getAttribute('aria-label') ?? null,
      boardBtnPressed: q('.sessionbar .sb-board')?.getAttribute('aria-pressed') ?? null,
      boardBtnDisabled: q('.sessionbar .sb-board')?.disabled ?? null,
      // Tallied here so the assertion can compare the two doors' own state
      // rather than restating the gate: the rail foot's row carries
      // aria-pressed too, and the two must agree in every frame.
      footBoardDisabled:
        [...document.querySelectorAll('.lb-foot .lb-workbench-item')].find(
          (b) => b.hasAttribute('aria-pressed'),
        )?.disabled ?? null,
      store: { leftbarVisible: st.leftbarVisible, sidebarVisible: st.sidebarVisible, boardOpen: st.boardOpen },
      // The rail heads: the title the right one carries, and — the point of the
      // change — the fact that **neither head has a collapse control any more**.
      // A button that lives inside the thing it hides cannot perform its own act.
      // The left rail no longer draws a head at all: its identity moved to the
      // top bar and the rail opens straight at the new-session button, so the
      // guard here is the head's absence.
      leftHeadGone: !q('.app-leftbar .lb-head'),
      rightHead: q('.rb-head')?.innerText?.replace(/\\s+/g,' ').trim() ?? null,
      rightHeadButtons: q('.rb-head')?.querySelectorAll('button').length ?? -1,
      // The head must sit **outside** the scrolling region: a head that scrolled
      // would let the goal text push the rail's own name off the top, which is
      // the failure the left head's comment names.
      rightHeadInScroller: !!q('.sidebar-inner .rb-head'),
      rightHeadMark: !!q('.rb-head .app-mark'),
      band: {
        leftTop: Math.round(q('.lb-new')?.getBoundingClientRect().top ?? -1),
        rightTop: Math.round(q('.rb-head')?.getBoundingClientRect().top ?? -1),
      },
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
  // **Exactly two**, one at each end, and neither inside the scroller. Both
  // in-rail collapse buttons are gone, so these two toggles are the whole
  // mechanism: a third one would be a leftover, one inside `.sb-scroll` could be
  // scrolled off the edge by a long session id, and either failure leaves a rail
  // that cannot be folded back by mouse.
  if (bt.toggleCount !== 2) {
    throw new Error(`expected exactly 2 rail toggles in the session bar, found ${bt.toggleCount}`);
  }
  if (!bt.leftToggle) throw new Error('the session bar has no leading rail toggle');
  if (!bt.rightToggle) throw new Error('the session bar has no trailing rail toggle');
  if (bt.toggleInScroller) {
    throw new Error('a rail toggle is inside the horizontal scroller: a long session id can carry it off the edge');
  }
  if (bt.rightToggleDisabled === true) {
    throw new Error('the trailing rail toggle starts disabled with no board open');
  }
  if (bt.rightToggleExpanded !== 'true') {
    throw new Error(`the trailing toggle disagrees with the rail it folds: aria-expanded=${bt.rightToggleExpanded}`);
  }

  // ---- the session board's door in the session bar ----
  //
  // It is the left rail's foot button reached from a surface that survives the
  // rail. Two things about it are invisible to every other assertion here:
  //
  //   1. **Where it is.** "Right of the collapse button" is the whole request,
  //      and a button that had been appended after `.sb-scroll` instead would
  //      render, work, and sit on the wrong side of every fact on the row. The
  //      index is asserted against the bar's own children, so the bar's leading
  //      order — toggle, board, facts, toggle — is the property under test.
  //   2. **That it is readable.** Its name is in `aria-label` and its state in
  //      `aria-pressed`; the icon alone carries neither, so a copy that dropped
  //      them would be an unlabelled square to a screen reader.
  if (!bt.boardBtn) {
    throw new Error('the session bar has no session-board button: with the left rail folded there is no way to the board');
  }
  if (bt.boardBtnInScroller) {
    throw new Error('the board button is inside the horizontal scroller: a long session id can carry it off the edge');
  }
  if (bt.boardBtnIndex !== 1) {
    throw new Error(
      `the board button is not the second child of the session bar (index ${bt.boardBtnIndex}): it belongs immediately right of the leading rail toggle`,
    );
  }
  if (bt.boardBtnLabel !== 'Session board') {
    throw new Error(`the board button carries no usable name: aria-label=${bt.boardBtnLabel}`);
  }
  if (bt.boardBtnPressed !== 'false') {
    throw new Error(`the board button claims a board is up before one was opened: aria-pressed=${bt.boardBtnPressed}`);
  }
  // The two doors must agree in every frame, because they read one gate. The
  // foot's row is drawn from the same `selectBoardAvailable`, so a divergence
  // here is exactly the "one door open, the other dead" defect the selector was
  // lifted out of `WorkspaceSidebar` to prevent.
  if (bt.boardBtnDisabled !== bt.footBoardDisabled) {
    throw new Error(
      `the two board doors disagree: session bar disabled=${bt.boardBtnDisabled}, rail foot disabled=${bt.footBoardDisabled}`,
    );
  }

  // ---- the rail heads, and what they no longer carry ----
  //
  // The mirror of the left rail's head, and the reasons it is asserted are the
  // same ones: a missing title renders as a rail that starts at "Goal" with
  // nothing saying what the rail *is*.
  //
  // **The collapse control is what left.** It used to live here — inside the
  // rail it hides — so pressing it removed the only control that could bring the
  // rail back, and `Ctrl+B` (plus a `Show` button that only existed once the
  // rail was already gone) was what remained. Both rail heads are now controls-
  // free, and the two toggles in the session bar do the work. A button reappearing
  // in either head is the defect coming back, which is why the count is asserted
  // rather than merely the absence of an aria-label.
  //
  // The head being **outside** `.sidebar-inner` is the non-obvious half. Both
  // rails keep their head out of the scrolling region; put it inside and the
  // goal text scrolls the rail's own name off the top. That is invisible in a
  // rendering where the blocks happen to fit.
  if (bt.rightHead === null) throw new Error('the right rail has no head');
  if (!bt.rightHead.includes('Session runtime')) {
    throw new Error(`the right rail's head does not name the rail: "${bt.rightHead}"`);
  }
  // **No mark here, and that is deliberate** (`708a168` removed the Logo from
  // this head and said so in its comment: the rail's name in words is all this
  // rail needs). The assertion below held the *opposite* for a while — it
  // originally paired with the mark's introduction (`826434d`) and was never
  // turned around when the mark left, so every run failed here and none of the
  // checks after it ran. The probe stays so the flip is cheap if the head's
  // shape changes again.
  if (bt.rightHeadMark) {
    throw new Error('the right rail\'s head still carries the app mark that was deliberately removed');
  }
  if (bt.rightHeadInScroller) {
    throw new Error('the right rail\'s head is inside the scrolling region: the goal text will push it off');
  }
  if (bt.rightHeadButtons !== 0) {
    throw new Error(
      `the right rail's head carries ${bt.rightHeadButtons} button(s): its collapse control belongs at the session bar's trailing end, where it survives its own press`,
    );
  }
  if (bt.leftHeadGone !== true) {
    throw new Error(
      'the left rail still draws a brand head: its mark and name moved to the top bar, and the rail opens at the new-session button',
    );
  }
  // One horizontal band across the window: the two rails' first rows start at
  // the same y, so the pair still reads as rails around one transcript. Their
  // heights are no longer expected to agree — the left one is an action button's
  // band, the right one a title's.
  if (bt.band.leftTop !== bt.band.rightTop) {
    throw new Error(
      `the two rails' first rows do not form one band: left ${JSON.stringify({ y: bt.band.leftTop })} vs right ${JSON.stringify({ y: bt.band.rightTop })}`,
    );
  }

  // Fold the left rail from the session bar's **leading** toggle, as a person
  // would. The two toggles take the same `boolean` setters, so a copy-paste
  // between them type-checks and folds the wrong rail — one of the two tests
  // below is what catches that.
  await evaluate(`(() => {
    document.querySelector('.sessionbar > .rail-toggle:first-child').click();
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
  // Both toggles are still on screen while one rail is folded — that is the
  // whole point of putting them here rather than in the rails.
  if (ah.rightToggle !== true) {
    throw new Error('folding the left rail took the right rail\'s toggle with it');
  }

  // And back, with the mouse only. A rail whose restore path is a keyboard
  // shortcut is a rail a mouse user cannot get back.
  await evaluate(`(() => {
    document.querySelector('.sessionbar > .rail-toggle:first-child').click();
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

  // And the right rail's control, pressed as a person would press it. The
  // crossed-setter defect from the other side: the two setters take the same
  // `boolean`, so a copy-paste between the toggles type-checks and hides the
  // wrong rail. The leading one is checked above; this is the trailing one's.
  await evaluate(`(() => {
    document.querySelector('.sessionbar > .rail-toggle:last-child').click();
    return true;
  })()`);
  await sleep(500);

  const afterRightHide = await railState();
  console.log('after hiding the right rail from the session bar:', afterRightHide);
  const rh = JSON.parse(afterRightHide ?? '{}');
  if (rh.rightW > FOLDED) throw new Error(`the right rail did not fold away: width ${rh.rightW}`);
  if (rh.leftW < WIDE) {
    throw new Error(`the trailing toggle hid the left rail (width ${rh.leftW}) — the two setters are crossed`);
  }
  if (rh.store.leftbarVisible !== true) {
    throw new Error("the trailing toggle wrote the left rail's preference");
  }
  if (rh.store.sidebarVisible !== false) {
    throw new Error("the trailing toggle did not write its own preference");
  }
  // The toggle that just folded the rail is still on screen, and now says so.
  if (rh.rightToggle !== true) {
    throw new Error('the toggle that folded the right rail vanished with it');
  }
  if (rh.rightToggleExpanded !== 'false') {
    throw new Error(`the trailing toggle did not report the folded rail: aria-expanded=${rh.rightToggleExpanded}`);
  }

  // ---- the replacement row is the conversation column's own header ----
  //
  // The summary row now stands in for the folded rail **inside the conversation
  // column, under the session bar**, rather than as a window-wide strip between
  // `.app-main` and the status bar. Measured, not inferred: the two rows have to
  // share their left edge and their width, and the row has to be inside the
  // column — a window-wide strip still renders and its text still reads right, so
  // only geometry can tell the two apart.
  const summaryLayout = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null; };
    const conv = q('.app-conversation');
    const bar = q('.sessionbar');
    const row = q('.collapsed-summary');
    return JSON.stringify({
      inConversation: !!conv?.querySelector('.collapsed-summary'),
      isShellChild: !!q('.app > .collapsed-summary'),
      // The fold wrapper that animates it: it lives in the column too, so the
      // animation and the width are the same element's business.
      foldInConversation: !!conv?.querySelector(':scope > .collapse'),
      wrapperH: Math.round(q('.app-conversation > .collapse')?.getBoundingClientRect().height ?? -1),
      barBox: box(bar),
      rowBox: box(row),
      convBox: box(conv),
      // Any control left in the row is a leftover: the way back is the session
      // bar's trailing toggle, which is on screen in both states.
      rowButtons: q('.collapsed-summary')?.querySelectorAll('button').length ?? -1,
      rowText: (q('.collapsed-summary')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    });
  })()`);
  console.log('collapsed summary row:', summaryLayout);
  const SL = JSON.parse(summaryLayout ?? '{}');
  if (!SL.inConversation) {
    throw new Error("the summary row is not inside the conversation column: it still spans under both rails");
  }
  if (SL.isShellChild) {
    throw new Error('the summary row is still a window-level strip between `.app-main` and the status bar');
  }
  if (!SL.foldInConversation) {
    throw new Error('the summary row\'s fold wrapper is not the conversation column\'s own child');
  }
  if (!(SL.wrapperH > 0)) {
    throw new Error(`the summary row has no height while the rail is folded: ${SL.wrapperH}`);
  }
  if (!(SL.barBox && SL.rowBox && SL.convBox)) {
    throw new Error(`could not measure the session bar against the summary row: ${summaryLayout}`);
  }
  // Same left edge, same width: "the same width as the session bar" is the whole
  // request, and a bar tucked under the rail boundary would still render.
  if (Math.abs(SL.rowBox.x - SL.barBox.x) > 1) {
    throw new Error(
      `the summary row does not start at the session bar's left edge: ${SL.rowBox.x} vs ${SL.barBox.x}`,
    );
  }
  if (Math.abs(SL.rowBox.w - SL.barBox.w) > 1) {
    throw new Error(
      `the summary row is not the session bar's width: ${SL.rowBox.w} vs ${SL.barBox.w}`,
    );
  }
  // Directly under it, and above the transcript.
  if (Math.abs(SL.rowBox.y - SL.barBox.bottom) > 1) {
    throw new Error(
      `the summary row is not directly under the session bar: row at ${SL.rowBox.y}, bar bottom ${SL.barBox.bottom}`,
    );
  }
  if (!(SL.rowBox.bottom <= SL.convBox.bottom)) {
    throw new Error('the summary row overflows the conversation column');
  }
  // The two controls it used to carry — the label and the `Show` button — are
  // both gone, which is the third of the four changes asked for.
  if (SL.rowButtons !== 0) {
    throw new Error(
      `the summary row still has ${SL.rowButtons} button(s): the way back is the session bar's trailing toggle, not a control that exists only after the fold`,
    );
  }
  if (/sidebar hidden/i.test(SL.rowText)) {
    throw new Error(`the summary row still announces the fold: "${SL.rowText}"`);
  }

  // Back up from the same trailing toggle — the one control that is on screen in
  // both states, and the half of this a `Ctrl+B`-only implementation would miss.
  await evaluate(`(() => {
    document.querySelector('.sessionbar > .rail-toggle:last-child').click();
    return true;
  })()`);
  await sleep(500);
  const afterRightShow = await railState();
  console.log('after restoring the right rail:', afterRightShow);
  const rs2 = JSON.parse(afterRightShow ?? '{}');
  if (!(rs2.rightW > WIDE)) throw new Error(`the right rail did not come back: width ${rs2.rightW}`);
  if (rs2.store.sidebarVisible !== true) throw new Error('the restore did not reach the preference');
  if (rs2.rightToggleDisabled === true) {
    throw new Error('the trailing toggle is disabled while the rail is on screen');
  }
  // With the rail back, the row is folded away again — and folded, not unmounted,
  // so the animation has something to run on.
  const summaryFolded = await evaluate(`(() => {
    const wrap = document.querySelector('.app-conversation > .collapse');
    return JSON.stringify({
      collapsed: wrap?.classList.contains('is-collapsed') ?? null,
      h: Math.round(wrap?.getBoundingClientRect().height ?? -1),
      inert: wrap?.hasAttribute('inert') ?? null,
    });
  })()`);
  console.log('summary row, with the rail back:', summaryFolded);
  const SF = JSON.parse(summaryFolded ?? '{}');
  if (SF.collapsed !== true) throw new Error('the summary row did not fold when the rail came back');
  if (!(SF.h <= 1)) throw new Error(`the folded summary row still has height ${SF.h}`);
  if (SF.inert !== true) throw new Error('the folded summary row is still reachable by Tab: no `inert`');

  // ---- the board button actually opens the board, from the bar ----
  //
  // **The half that a structural assertion cannot reach.** The button could be
  // in the right place, correctly labelled, correctly gated, and wired to the
  // wrong action — `toggleSidebar`, most plausibly, since this row already
  // carries two buttons that take a `boolean` and fold a rail. So the click is
  // driven for real and the *store* is asked, not the button's own `aria-pressed`:
  // a control that reports a state it did not cause is the defect this whole
  // file exists for.
  //
  // Driven with the **left rail folded**, deliberately: that is the state the
  // button was asked for. With the rail on screen the foot's own row is
  // equivalent, so a check that ran there would pass without the new door
  // existing at all.
  await evaluate(`(() => {
    document.querySelector('.sessionbar > .rail-toggle:first-child').click();
    return true;
  })()`);
  await sleep(500);
  const foldedForBoard = JSON.parse((await railState()) ?? '{}');
  if (foldedForBoard.leftW > FOLDED) {
    throw new Error(`the left rail did not fold before the board test: width ${foldedForBoard.leftW}`);
  }

  await evaluate(`(() => {
    document.querySelector('.sessionbar .sb-board').click();
    return true;
  })()`);
  await sleep(300);

  const afterBoardOpen = JSON.parse((await railState()) ?? '{}');
  console.log('after opening the board from the session bar:', JSON.stringify(afterBoardOpen));
  if (afterBoardOpen.store.boardOpen !== true) {
    throw new Error('the session bar\'s board button did not open the board');
  }
  // **Not the rail's preference.** The crossed-wire failure this row is prone
  // to: `sidebarVisible` must be untouched, or the button is a second `Ctrl+B`.
  if (afterBoardOpen.store.sidebarVisible !== true || afterBoardOpen.store.leftbarVisible !== false) {
    throw new Error(
      `the board button wrote a rail preference instead: sidebarVisible=${afterBoardOpen.store.sidebarVisible}, leftbarVisible=${afterBoardOpen.store.leftbarVisible}`,
    );
  }
  if (afterBoardOpen.boardBtnPressed !== 'true') {
    throw new Error(`the board button does not report the open board: aria-pressed=${afterBoardOpen.boardBtnPressed}`);
  }
  // The board is the column's occupant now, so the column must be showing it
  // rather than a rail the button had hidden on its way past.
  const boardView = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    return JSON.stringify({
      board: !!q('.app-stream .board'),
      // The right rail is derived away under the board, so its toggle says so.
      rightToggleDisabled: q('.sessionbar > .rail-toggle:last-child')?.disabled ?? null,
    });
  })()`);
  const BV = JSON.parse(boardView ?? '{}');
  if (!BV.board) throw new Error('the board is not what the conversation column is showing');
  if (BV.rightToggleDisabled !== true) {
    throw new Error('the trailing rail toggle stayed enabled under the board');
  }

  // And the same door closes it. A view opened from a button that cannot be
  // shut from that button is a one-way trip, which is the failure the two rail
  // toggles were moved into this row to avoid.
  await evaluate(`(() => {
    document.querySelector('.sessionbar .sb-board').click();
    return true;
  })()`);
  await sleep(300);
  const afterBoardClose = JSON.parse((await railState()) ?? '{}');
  console.log('after closing the board from the session bar:', JSON.stringify(afterBoardClose));
  if (afterBoardClose.store.boardOpen !== false) {
    throw new Error('the board button does not close the board it opened');
  }
  if (afterBoardClose.boardBtnPressed !== 'false') {
    throw new Error(`the board button still claims an open board: aria-pressed=${afterBoardClose.boardBtnPressed}`);
  }
  // And the button is still there and still enabled, with the board gone and
  // the left rail folded: the state it was asked for.
  if (!afterBoardClose.boardBtn) throw new Error('the board button vanished with the board');
  if (afterBoardClose.boardBtnDisabled === true) {
    throw new Error('the board button is disabled with the board closed and a session live');
  }

  // Put the left rail back, so every assertion below sees the tree it expects.
  await evaluate(`(() => {
    document.querySelector('.sessionbar > .rail-toggle:first-child').click();
    return true;
  })()`);
  await sleep(500);

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
    const box = (el) => {
      const b = el?.getBoundingClientRect();
      return b ? { h: Math.round(b.height), w: Math.round(b.width) } : null;
    };
    return JSON.stringify({
      count: rows.length,
      first: (rows[0]?.innerText ?? '').replace(/\\s+/g,' ').trim(),
      current: rows.filter((r) => r.classList.contains('is-current')).length,
      times: [...document.querySelectorAll('.lb-rows:not(.lb-live-rows) .lb-session-time')].map((n) => n.textContent),
      // The two painted lines of a row. The time rides the first, at its right
      // edge; the meta line is the second. The id is not a line any more.
      lines: {
        topic: top(rows[0], '.lb-session-preview'),
        meta: top(rows[0], '.lb-session-meta'),
        time: top(rows[0], '.lb-session-time'),
      },
      colours: {
        topic: colour(rows[0], '.lb-session-preview'),
        meta: colour(rows[0], '.lb-session-meta'),
      },
      // The id is a fact on the row, but not ink: it lives in sr-only and in
      // the row's title, which is where a person goes looking for it before
      // typing /resume.
      id: {
        text: idEl?.textContent ?? null,
        position: idEl ? getComputedStyle(idEl).position : null,
        box: box(idEl),
      },
      title: rows[0]?.getAttribute('title') ?? null,
      rowHeight: box(rows[0])?.h ?? null,
      fallback: rows[1]?.querySelector('.lb-session-preview')?.textContent ?? null,
    });
  })()`);
  console.log('session rows:', sessions);
  const sr = JSON.parse(sessions ?? '{}');
  if (sr.count !== 2) throw new Error(`expected 2 session rows, got ${sr.count}`);
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
  // ---- two lines: topic + time, then progress ----
  //
  // The row used to be three lines of equal weight (topic, progress, id/time),
  // and that is why only four conversations fit in the rail. The redesign's
  // claim is a **density** claim, so it is asserted as geometry: a ~46px row
  // whose time shares the topic's line, with the progress line under it.
  const { topic, meta, time } = sr.lines ?? {};
  if (topic === null || meta === null || time === null) {
    throw new Error(`a session row is missing one of its lines: ${JSON.stringify(sr.lines)}`);
  }
  if (!(topic < meta)) {
    throw new Error(
      `the session row is not topic -> progress, top to bottom: ${JSON.stringify(sr.lines)}`,
    );
  }
  if (Math.abs(time - topic) > 2) {
    throw new Error(`the time is not on the topic's line: time at ${time}, topic at ${topic}`);
  }
  if (!(sr.rowHeight >= 44 && sr.rowHeight <= 48)) {
    throw new Error(`a two-line session row is ${sr.rowHeight}px, not the design's ~46px`);
  }
  // The id is still on the row — the runtime's own name, and what `/resume`
  // takes — but it is not painted: `sr-only` keeps it for the screen reader and
  // `title` puts it under the pointer.
  if (sr.id?.text !== 's-20260101-000000') {
    throw new Error(`the session id left the row entirely: ${JSON.stringify(sr.id)}`);
  }
  if (sr.id?.position !== 'absolute' || !(sr.id?.box?.w <= 1) || !(sr.id?.box?.h <= 1)) {
    throw new Error(
      `the session id is painted as a third line (${JSON.stringify(sr.id)}) — it belongs in ` +
        'the accessible name and the hover title, not on a row whose height is the point',
    );
  }
  if (sr.title !== 's-20260101-000000') {
    throw new Error(`the row carries no hover title for its id: ${JSON.stringify(sr.title)}`);
  }
  // A session that never spoke has no preview. The design's fallback names that
  // fact instead of leaving the title blank.
  if (sr.fallback !== 'Untitled') {
    throw new Error(`an empty preview did not fall back to "Untitled": ${JSON.stringify(sr.fallback)}`);
  }
  // The topic is the row's title and the meta line is a footnote: two layers,
  // not one colour repeated.
  if (sr.colours.topic === sr.colours.meta) {
    throw new Error(
      `the topic and its progress line are painted in the same colour (${sr.colours.topic})`,
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
    const rows = row.querySelectorAll('.row');
    const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
    const topicLine = rows[0];
    const factsLine = rows[1];
    return JSON.stringify({
      text: (row.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      topic: top(topicLine?.querySelector('.truncate')),
      meta: top(factsLine),
      // The topic inherits the panel row's own colour (--fg-secondary); the id
      // is the faint layer under it. What has to hold is that they are not the
      // same layer — the exact rgb is the theme's business, not this check's.
      topicColour: getComputedStyle(row.querySelector('.truncate')).color,
      idColour: getComputedStyle(row.querySelector('.mono')).color,
      // The archive action sits **on the topic line**, next to the topic it
      // acts on — not in a footer or a separate manage screen.
      archiveBtn: !!topicLine?.querySelector('button[aria-label*="rchive"]'),
      // The fixture's single live session is the harness's own bucket (its
      // session id was never in the saved list), so nothing here should be
      // disabled — "a person can archive every row they see" is the default.
      archiveDisabled: topicLine?.querySelector('button[aria-label*="rchive"]')?.disabled ?? true,
      // The field-level search box and the Active/Archived tabs are the two
      // new controls; both must be present and the search must take focus on
      // open, so a typed letter goes into the query rather than a row.
      search: !!row.closest('.dialog')?.querySelector('input[aria-label]'),
      searchFocused: !!row.closest('.dialog')?.querySelector('input[aria-label]')?.matches(':focus'),
      tabs: [...(row.closest('.dialog')?.querySelectorAll('[role="tab"]') ?? [])].map((b) => ({
        text: (b.innerText ?? '').replace(/\\s+/g, ' ').trim(),
        on: b.getAttribute('aria-selected') === 'true',
      })),
    });
  })()`);
  console.log('resume panel row:', panel);
  const rp = JSON.parse(panel ?? '{}');
  if (rp.missing) throw new Error('the /resume panel rendered no session row');
  if (!(rp.topic !== null && rp.meta !== null && rp.topic < rp.meta)) {
    throw new Error(`the /resume row is not topic -> facts: ${JSON.stringify(rp)}`);
  }
  if (rp.idColour === rp.topicColour) {
    throw new Error(
      `the /resume row's id is painted as strongly as the topic (${rp.idColour}): the topic is the title and the id is a footnote`,
    );
  }
  if (!rp.archiveBtn) {
    throw new Error('the /resume row has no archive action on its topic line');
  }
  if (rp.archiveDisabled) {
    throw new Error('the archive action is disabled for a row nothing is running');
  }
  if (!rp.search) {
    throw new Error('the /resume panel has no search box');
  }
  if (!Array.isArray(rp.tabs) || rp.tabs.length !== 2) {
    throw new Error(`the /resume panel must have exactly two tabs (Active/Archived), saw ${JSON.stringify(rp.tabs)}`);
  }
  if (rp.tabs.filter((b) => b.on).length !== 1) {
    throw new Error(`exactly one tab is selected, saw ${JSON.stringify(rp.tabs)}`);
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
      // Each block is a **list card**: the edge is what separates one section
      // from the next. It was dropped silently in the realigning pass and only a
      // screenshot caught it, so the width is asserted here.
      blockEdges: blocks.map((b) => getComputedStyle(b).borderTopWidth),
      sidebarText: (document.querySelector('.app-sidebar')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 400),
    });
  })()`);
  console.log('sidebar:', sidebar);
  const sb = JSON.parse(sidebar ?? '{}');
  // Six blocks, in the fixed order. **SSH is the sixth** (see the Sidebar's own
  // order comment): a display-only block added after this probe was written,
  // which is why the count check below used to read five.
  if (sb.blockCount !== 6) throw new Error(`expected 6 sidebar blocks, got ${sb.blockCount}`);
  if ((sb.blockEdges ?? []).some((w) => w !== '1px')) {
    throw new Error(`a right-rail block has no list-card border: ${JSON.stringify(sb.blockEdges)}`);
  }
  const expected = ['Goal', 'Tasks', 'Background jobs', 'Loaded skills', 'MCP', 'SSH sessions'];
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

  // While that turn runs, the composer's action is a stop **square** in the
  // send button's place, and the toolbar says what is happening and how to stop
  // it. The shape is the state; this is the half a screenshot cannot regress
  // silently because a circle would still look like a plausible button.
  //
  // The extra wait is the 200ms height transition: `apply` already waits 120ms,
  // which catches the box mid-flight (~94px) and would make this a flake about
  // timing rather than a check about the state.
  await sleep(300);
  const stopButton = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const btn = q('.cp-send.is-stop');
    const cp = q('.cp-box');
    const note = q('.cp-note');
    if (!btn || !cp) return JSON.stringify({ missing: true });
    const b = btn.getBoundingClientRect();
    const c = getComputedStyle(btn);
    return JSON.stringify({
      missing: false,
      w: Math.round(b.width),
      h: Math.round(b.height),
      radius: c.borderRadius,
      bg: c.backgroundColor,
      filled: cp.classList.contains('is-filled'),
      height: Math.round(cp.getBoundingClientRect().height),
      note: (note?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    });
  })()`);
  console.log('composer, running:', stopButton);
  const SB = JSON.parse(stopButton ?? '{}');
  if (SB.missing) throw new Error('a running turn has no stop button');
  if (SB.w !== 28 || SB.h !== 28) {
    throw new Error(`the stop button is ${SB.w}x${SB.h}, not the send button's 28x28`);
  }
  if (SB.radius !== '8px') {
    throw new Error(`the stop control is not the design's square (radius ${SB.radius})`);
  }
  if (!SB.filled || Math.abs(SB.height - 96) > 1) {
    throw new Error(`a running turn's composer changed height (${SB.height}px, filled=${SB.filled})`);
  }
  if (!SB.note.includes('Streaming') || !SB.note.includes('Esc to stop')) {
    throw new Error(`the running toolbar does not say what to do: "${SB.note}"`);
  }
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
  // The rule is about **runtime** actions, not about buttons: the local-only
  // controls may stay live, because none of them touches anything the runtime is
  // holding. They are the rail's own collapse toggle, the sessions fold and the
  // workbench fold — each a preference (`persistPrefs`) that sends no message at
  // all. The sessions fold had to be named here when it was added, and the
  // workbench's head is the same story one release later: it is live behind a
  // prompt by design, so this failed on an untouched codebase until it was
  // named too. That failure is the point — naming the allowed controls is what
  // keeps this from going stale: a new button fails unless somebody decides,
  // here, that it is local.
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
          local:
            cls.includes('lb-section-toggle') ||
            cls.includes('lb-icon') ||
            cls.includes('lb-workbench-head'),
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

  // ---- 6b. the rail is cards on a rail, and the canvas has a gradient ----
  //
  // Both of these were "done" and neither was: the rail painted every session
  // row the **same** colour as the rail it sat on, so the reference's session
  // cards were not there at all, and the app's aurora gradients were centred
  // outside the window (`at 82% -18%`), which leaves only the ellipse's falling
  // edge on screen — measured at a peak alpha of 0.02 against the design's 0.08.
  // Neither is visible to any assertion above: the rows exist, the text is
  // right, the gradient string is a well-formed gradient.
  //
  // So what is asserted is *depth* (three surfaces, strictly ordered) and
  // *geometry* (each gradient's centre is inside the box that paints it).
  //
  // And a third, added after a report: the two lists in this rail must share a
  // **right edge**. The saved rows carry a hover-revealed actions column beside
  // the card, and as a flex item that column took 26px of the row and the card
  // paid for it — 201px against the workspace row's 227px, so the session cards
  // were visibly outdented from everything above them. Both rows existed and
  // both carried the right text, which is why nothing here noticed.
  const skin = await evaluate(`(async () => {
    const store = window.__aigoStore;
    const key = window.__aigoKey;
    const q = (s) => document.querySelector(s);
    const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    const cs = (el) => (el ? getComputedStyle(el) : null);
    // ---- seed what this probe measures ----
    //
    // Two of the things asserted below are properties of state the script's own
    // payloads do not produce, and measuring their absence was a check that
    // could only fail:
    //
    //   - a **step card**. A "reason" row is not in STEP_KINDS, so it closes the
    //     block and the model row is drawn as a loose ".e-model" line instead
    //     (see the flush() in streamBlocks). The turn driven earlier carries
    //     reasoning, so no card exists at this point.
    //   - a **saved row that is current**. The session on screen is the live one
    //     (open, no file), and a live row has no per-row actions at all — so the
    //     retraction, which is about a saved row's actions, has nothing to
    //     measure.
    //
    // So both are seeded here, through the same store the tree renders.
    const activeId = store.getState().sessions[key]?.session?.id ?? 's-render';
    const send = (p) => store.getState().applyRuntimeMessage(key, p);
    send({ v: 1, t: 'sessions', items: [
      { session_id: activeId, messages: 500, steps: 218, todos: '', preview: 'the current one', modified_at: 1767225600 },
      { session_id: 's-idle-probe', messages: 12, steps: 4, todos: '', preview: 'an idle one', modified_at: 1767225600 },
    ]});
    send({ v: 1, t: 'event', kind: 'run_started', session_id: activeId, run_id: 'r-probe', step: 5,
      ts: '2026-01-01T00:00:00Z', model: 'deepseek-chat', provider: 'deepseek' });
    send({ v: 1, t: 'event', kind: 'model_call', session_id: activeId, run_id: 'r-probe', step: 5,
      ts: '2026-01-01T00:00:01Z', status: 'ok', duration_ms: 1900,
      prompt_tokens: 277209, cached_tokens: 276224, completion_tokens: 40 });
    send({ v: 1, t: 'event', kind: 'tool_call', session_id: activeId, run_id: 'r-probe', step: 5,
      ts: '2026-01-01T00:00:02Z', tool: 'shell', call_id: 'cp1', tool_index: 0,
      arguments: '{"command":"git status"}' });
    send({ v: 1, t: 'event', kind: 'tool_result', session_id: activeId, run_id: 'r-probe', step: 5,
      ts: '2026-01-01T00:00:03Z', call_id: 'cp1', status: 'ok', duration_ms: 42, exit_code: 0, output: 'clean' });
    send({ v: 1, t: 'event', kind: 'run_finished', session_id: activeId, run_id: 'r-probe', status: 'completed' });
    await new Promise((r) => setTimeout(r, 500));

    const railEl = q('.app-leftbar');
    // An idle card specifically: the live group's row is the current one.
    const savedRows = [...document.querySelectorAll('.lb-rows:not(.lb-live-rows) .lb-session')];
    const idleEl = savedRows.find((r) => !r.classList.contains('is-current'));
    const savedCurrentEl = savedRows.find((r) => r.classList.contains('is-current'));
    const currentEl = q('.lb-session.is-current');
    const rowEl = q('.lb-row:not(.is-current)') ?? q('.lb-row');
    const workspaceCurrentEl = q('.lb-row.is-current');
    const appEl = q('.app');
    const image = appEl ? getComputedStyle(appEl).backgroundImage : '';
    // Every "at <x> <y>" in the background, as percentages. The failure this
    // catches is a centre outside 0-100: the gradient still parses and still
    // paints, so nothing else notices.
    const centres = [...image.matchAll(/at\\s+(-?[\\d.]+)%\\s+(-?[\\d.]+)%/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    // The right edges of the two rows that must line up. Rounded to whole
    // pixels: the columns are all integers here, and a sub-pixel difference is
    // not what anyone can see.
    const right = (el) => (el ? Math.round(el.getBoundingClientRect().right) : null);
    // The session bar's groups, the model-call card's head and icon, and the
    // current row's retraction: all of them are *paint* decisions that no text
    // assertion can see.
    const groups = [...document.querySelectorAll('.sessionbar .sb-group')];
    const step = q('.e-step');
    const icon = step?.querySelector('.e-step-icon');
    const stepHead = step?.querySelector('.e-step-head');
    const curActs = savedCurrentEl?.closest('.lb-session-wrap')?.querySelector('.lb-session-actions');
    const idleActs = idleEl?.closest('.lb-session-wrap')?.querySelector('.lb-session-actions');
    // The reveal is on the **buttons** (.lb-row-action), not on their column
    // wrapper: the wrapper is only a layout box, so reading its opacity would
    // always report 1 and the assertion would be vacuous.
    const actBtn = (acts) => acts?.querySelector('.lb-row-action') ?? null;
    const curTime = savedCurrentEl?.querySelector('.lb-session-time');
    const idleTime = idleEl?.querySelector('.lb-session-time');
    // The redesign's two surfaces, read from the token set rather than written
    // as literals: the rail's plane and the capsule are different values in each
    // theme, and what must hold in both is their *relationship*.
    const root = getComputedStyle(document.documentElement);
    return JSON.stringify({
      tokens: {
        rail: root.getPropertyValue('--lb-surface').trim(),
        selected: root.getPropertyValue('--lb-selected').trim(),
        hover: root.getPropertyValue('--lb-hover').trim(),
      },
      rail: bg(railEl),
      idle: bg(idleEl),
      current: bg(currentEl),
      row: bg(rowEl),
      workspaceCurrent: bg(workspaceCurrentEl),
      idleBorder: cs(idleEl)?.borderTopColor ?? null,
      currentBorder: cs(currentEl)?.borderTopColor ?? null,
      idleShadow: cs(idleEl)?.boxShadow ?? null,
      currentShadow: cs(currentEl)?.boxShadow ?? null,
      gradients: (image.match(/radial-gradient/g) ?? []).length,
      centres,
      rightEdges: { workspace: right(rowEl), saved: right(idleEl), live: right(currentEl) },
      sbGroups: {
        count: groups.length,
        fills: groups.map((g) => bg(g)),
        borders: groups.map((g) => getComputedStyle(g).borderTopWidth),
        separators: document.querySelectorAll('.sessionbar > .sep').length,
        innerFactBorders: groups.map((g) => {
          const f = g.querySelector('.fact');
          return f ? getComputedStyle(f).borderTopWidth : null;
        }),
      },
      stepCard: {
        present: !!step,
        headBg: stepHead ? bg(stepHead) : null,
        headBorderBottom: stepHead ? getComputedStyle(stepHead).borderBottomWidth : null,
        iconBg: icon ? bg(icon) : null,
        iconColor: icon ? getComputedStyle(icon).color : null,
        iconW: icon ? Math.round(icon.getBoundingClientRect().width) : null,
      },
      retraction: {
        hasSavedCurrent: !!savedCurrentEl,
        currentActionsOpacity: cs(actBtn(curActs))?.opacity ?? null,
        currentActionsPointer: cs(actBtn(curActs))?.pointerEvents ?? null,
        // The idle row's opacity is deliberately **not** measured: what it
        // computes to depends on where the pointer and focus happen to be by this
        // point in the run. What distinguishes the two rows is the tappable
        // state, not the fade.
        idleActionsPointer: cs(actBtn(idleActs))?.pointerEvents ?? null,
        actionsTransition: cs(actBtn(curActs))?.transitionProperty ?? null,
        // On hover the row's two actions take the time's place: the time fades
        // out, the buttons fade in, and nothing reflows.
        currentTimeOpacity: cs(curTime)?.opacity ?? null,
        idleTimeOpacity: cs(idleTime)?.opacity ?? null,
        timeTransition: cs(idleTime)?.transitionProperty ?? null,
      },
    });
  })()`);
  console.log('light skin:', skin);
  const sk = JSON.parse(skin ?? '{}');
  if (!sk.rail || !sk.idle || !sk.current) {
    throw new Error(`the rail's cards are not all on screen: ${JSON.stringify(sk)}`);
  }
  // ---- the rail's layer model ----
  //
  // The redesign removed the cards: the rail is one plane, a session row is
  // transparent at rest, and **the current row is a single pale green capsule**
  // — no border, no ring, no shadow. That is a paint decision no text assertion
  // can see, and it is the whole of the design's first fix. Asserted as facts
  // about the computed surfaces, not as literal colours, so a retune of the
  // palette does not fail a check about the layer model.
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';
  if (sk.idle !== TRANSPARENT) {
    throw new Error(`an idle session row is still a card (${sk.idle}); flat rows are the redesign`);
  }
  if (sk.row !== TRANSPARENT) {
    throw new Error(`the workspace row is still a card (${sk.row}); flat rows are the redesign`);
  }
  // The current workspace keeps the same one-signal capsule as the current
  // session: one selected state, stated once, in both lists.
  if (sk.workspaceCurrent === TRANSPARENT || sk.workspaceCurrent === sk.rail) {
    throw new Error(
      `the current workspace row has no capsule (${sk.workspaceCurrent}) against the rail's ${sk.rail}`,
    );
  }
  if (sk.current === TRANSPARENT || sk.current === sk.rail) {
    throw new Error(
      `the current session row has no capsule (${sk.current}) against the rail's ${sk.rail}`,
    );
  }
  const currentChannels = String(sk.current).match(/rgba?\(([^)]+)\)/);
  const rgb = currentChannels ? currentChannels[1].split(',').map((s) => Number(s.trim())) : null;
  if (!rgb || !(rgb[1] > rgb[0] && rgb[1] > rgb[2])) {
    throw new Error(`the current row's capsule is not a pale green (${sk.current})`);
  }
  // **One signal.** The capsule is the state; an edge, a ring or a shadow would
  // be a second and third mark for the same fact — the exact conflict the design
  // reports ("selected draws a green border AND a current capsule").
  if (sk.idleShadow !== 'none' || sk.currentShadow !== 'none') {
    throw new Error(
      `a session row still floats (idle ${sk.idleShadow}, current ${sk.currentShadow})`,
    );
  }
  // Both halos, each centred inside the element. A centre outside it means the
  // visible part is only the falloff, which reads as "no gradient" at these
  // alphas.
  if (sk.gradients !== 2) throw new Error(`expected 2 canvas gradients, got ${sk.gradients}`);
  if (sk.centres.length !== 2) {
    throw new Error(`could not read the gradients' centres: ${sk.centres.length}`);
  }
  for (const c of sk.centres) {
    if (!(c.x >= 0 && c.x <= 100 && c.y >= 0 && c.y <= 100)) {
      throw new Error(`a halo is centred outside the window (${c.x}%, ${c.y}%), so only its edge shows`);
    }
  }
  // ---- the two lists share a right edge ----
  //
  // The workspace row and a saved session card are the rail's two kinds of row
  // and they sit one above the other, so their right edges have to agree. The
  // saved row's actions column is what broke this: as a flex item it took 26px
  // and the card shrank to 201px against 227px above it. A tolerance of 1px,
  // because these are rounded to whole pixels and nothing here is fractional.
  const re = sk.rightEdges ?? {};
  if (re.workspace === null || re.saved === null || re.live === null) {
    throw new Error(`could not measure the rail's row edges: ${JSON.stringify(re)}`);
  }
  if (Math.abs(re.workspace - re.saved) > 1) {
    throw new Error(
      `the session card's right edge (${re.saved}) does not line up with the workspace row's (${re.workspace})`,
    );
  }
  // And the live row has no actions of its own, so it must agree too — it is
  // the control for the rule: if this one drifts, the reservation is being
  // applied to a row that has nothing to reserve for.
  if (Math.abs(re.workspace - re.live) > 1) {
    throw new Error(
      `the live session card's right edge (${re.live}) does not line up with the workspace row's (${re.workspace})`,
    );
  }

  // ---- the session bar's four facts are four cards ----
  //
  // Each is its own bordered box, and the 1px separators that used to sit
  // between them are gone: a line separates flat text, and between two cards it
  // is a second edge drawn where the cards already have one. The `fact` pills
  // inside gave up their own border for the same reason — a bordered pill in a
  // bordered card is two rectangles for one fact.
  const sbg = sk.sbGroups ?? {};
  if (sbg.count !== 4) {
    throw new Error(`expected 4 session-bar cards, got ${sbg.count}`);
  }
  if (sbg.separators !== 0) {
    throw new Error(`${sbg.separators} separator(s) left between the session bar's cards`);
  }
  for (const w of sbg.borders ?? []) {
    if (w !== '1px') throw new Error(`a session-bar card has no border (${w})`);
  }
  for (const b of sbg.innerFactBorders ?? []) {
    if (b !== null && b !== '0px') {
      throw new Error(`a fact inside a session-bar card still draws its own border (${b})`);
    }
  }

  // ---- the model-call card's head and icon ----
  //
  // The icon is a pale green badge, and the head carries the accent's wash. The
  // head used to be `--bg-secondary` — the rail's grey, inside a white card —
  // which is the slab the change was about, so what is asserted is that the head
  // is **not** the rail's colour and **is** a wash of the card's own accent.
  const stc = sk.stepCard ?? {};
  if (stc.iconBg === null || stc.iconBg === 'rgba(0, 0, 0, 0)') {
    throw new Error(`the model-call icon has no fill (${stc.iconBg})`);
  }
  if (stc.iconColor === null || stc.iconColor === stc.iconBg) {
    throw new Error(`the model-call icon's glyph does not contrast with its fill (${stc.iconColor})`);
  }
  if (!(stc.iconW > 0)) throw new Error(`the model-call icon has no size (${stc.iconW})`);
  // And it stays a **label-sized** mark: 18px, below the rail's own control size
  // (`.lb-icon`, 22px). The badge was that 22 — the head's mark was drawn at the
  // size of a *button*, which is why it read as the loudest thing on a bar whose
  // content is the figures on the right. A size is invisible to every text
  // assertion, so the bound is the only thing that keeps it from drifting back.
  if (stc.iconW > 18) {
    throw new Error(`the model-call icon is back at control size (${stc.iconW}px)`);
  }
  if (stc.headBg === null || stc.headBg === 'rgba(0, 0, 0, 0)') {
    throw new Error(`the model-call head has no wash (${stc.headBg})`);
  }
  if (stc.headBg === sk.rail) {
    throw new Error(`the model-call head is painted the rail's own grey (${stc.headBg})`);
  }
  if (stc.headBorderBottom !== '0px') {
    throw new Error(`the model-call head still draws a border under its wash (${stc.headBorderBottom})`);
  }

  // ---- a hovered idle row: the neutral wash, and the actions take the time's place ----
  //
  // `:hover` cannot be produced by a synthetic JS event, so the pointer is moved
  // with a real CDP mouse event. Three things are asserted, and each has a
  // failure the others cannot see:
  //
  //   - the hover **changes** the row from its resting transparency;
  //   - the wash is the rail's neutral `--lb-hover`, **not** the accent. The
  //     accent now means exactly one thing in this rail — the row you are in —
  //     and a hover wearing it would make two rows look selected at once;
  //   - the row's two actions take the time's place: the time fades, the buttons
  //     fade in, and nothing reflows (the actions are absolutely positioned
  //     against the wrapper, the row keeps its width).
  //
  // The wash is resolved from the token through a probe element rather than
  // written as an rgb literal: `--lb-hover` is a different value in each theme,
  // and this check runs with the light token set.
  //
  // Node-side selectors, scoped to the **saved** list on purpose: the live
  // group's row (a conversation with no file yet) is `.lb-session.is-current`
  // too, so an unscoped selector would end up hovering the wrong element.
  const hoverIdleSel = '.lb-rows:not(.lb-live-rows) .lb-session:not(.is-current)';
  const selSavedCurrent = '.lb-rows:not(.lb-live-rows) .lb-session.is-current';
  const hoverGeometry = JSON.parse(
    (await evaluate(`(() => {
      const q = (s) => document.querySelector(s);
      const read = (s) => {
        const el = q(s);
        if (!el) return null;
        const c = getComputedStyle(el);
        const time = el.querySelector('.lb-session-time');
        const acts = el.closest('.lb-session-wrap')?.querySelector('.lb-session-actions');
        const actBtn = acts?.querySelector('.lb-row-action') ?? null;
        return {
          bg: c.backgroundColor,
          w: Math.round(el.getBoundingClientRect().width),
          timeOpacity: time ? getComputedStyle(time).opacity : null,
          actionsOpacity: actBtn ? getComputedStyle(actBtn).opacity : null,
          actionsPointer: actBtn ? getComputedStyle(actBtn).pointerEvents : null,
        };
      };
      const idle = q(${JSON.stringify(hoverIdleSel)});
      const cur = q(${JSON.stringify(selSavedCurrent)});
      if (!idle || !cur) return JSON.stringify({ missing: true });
      const centre = (el) => {
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      };
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--lb-hover)';
      document.body.appendChild(probe);
      const hoverWash = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return JSON.stringify({
        idleRest: read(${JSON.stringify(hoverIdleSel)}),
        currentRest: read(${JSON.stringify(selSavedCurrent)}),
        idleAt: centre(idle),
        currentAt: centre(cur),
        hoverWash,
      });
    })()`)) ?? {},
  );
  if (hoverGeometry.missing) {
    throw new Error('the rail has no idle saved row and current saved row to hover');
  }
  if (!hoverGeometry.idleAt || !hoverGeometry.currentAt) {
    throw new Error(`could not locate the rows to hover: ${JSON.stringify(hoverGeometry)}`);
  }
  const dispatch = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });
  const readStyles = async () =>
    JSON.parse(
      (await evaluate(`(() => {
        const read = (s) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const c = getComputedStyle(el);
          const time = el.querySelector('.lb-session-time');
          const acts = el.closest('.lb-session-wrap')?.querySelector('.lb-session-actions');
          const actBtn = acts?.querySelector('.lb-row-action') ?? null;
          return {
            bg: c.backgroundColor,
            timeOpacity: time ? getComputedStyle(time).opacity : null,
            actionsOpacity: actBtn ? getComputedStyle(actBtn).opacity : null,
            actionsPointer: actBtn ? getComputedStyle(actBtn).pointerEvents : null,
          };
        };
        return JSON.stringify({
          idle: read(${JSON.stringify(hoverIdleSel)}),
          current: read(${JSON.stringify(selSavedCurrent)}),
        });
      })()`)) ?? {},
    );
  // Normalise an `rgb()`/`rgba()` string to a comparable tuple, because the
  // resolved value's spacing is the browser's business, not this check's.
  //
  // This is Node-side code, **not** inside a template literal, so the escapes
  // are single-backslash: `\\(` here would look for a literal backslash.
  const channels = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    return m ? m[1].split(',').map((s) => s.trim()) : null;
  };
  const sameColour = (a, b) => {
    const x = channels(a);
    const y = channels(b);
    if (!x || !y) return false;
    if (x.length !== y.length) return false;
    return x.every((v, i) => Math.abs(Number(v) - Number(y[i])) < 0.6);
  };

  await dispatch('mouseMoved', 1400, 880);
  await sleep(250);
  // Park the pointer **and** the keyboard: a focused row lights `:focus-within`,
  // which reveals its actions, and the static probe earlier in the run cannot
  // know where focus was left. This reading is the reliable one.
  await evaluate(`(() => { document.activeElement?.blur?.(); return true; })()`);
  await sleep(150);
  const rest = await readStyles();
  if (rest.idle?.bg !== hoverGeometry.idleRest?.bg) {
    throw new Error(
      `parking the pointer changed the idle row (${hoverGeometry.idleRest?.bg} -> ${rest.idle?.bg}): the probe cannot tell a hover from a rest`,
    );
  }
  // At rest: the row is flat, the time is readable, the actions are invisible.
  if (rest.idle?.bg !== 'rgba(0, 0, 0, 0)') {
    throw new Error(`an idle row is painted at rest (${rest.idle?.bg}), so it still reads as a card`);
  }
  if (rest.idle?.timeOpacity !== '1') {
    throw new Error(`an idle row's time is hidden at rest (opacity ${rest.idle?.timeOpacity})`);
  }
  if (rest.idle?.actionsOpacity !== '0') {
    throw new Error(`an idle row's actions are visible at rest (opacity ${rest.idle?.actionsOpacity})`);
  }
  if (rest.current?.actionsOpacity !== '0') {
    throw new Error(
      `the current row's actions are visible at rest (opacity ${rest.current?.actionsOpacity})`,
    );
  }
  if (rest.current?.timeOpacity !== '1') {
    throw new Error(
      `the current row's time is hidden at rest (opacity ${rest.current?.timeOpacity})`,
    );
  }

  await dispatch('mouseMoved', hoverGeometry.idleAt.x, hoverGeometry.idleAt.y);
  await sleep(300);
  const hovered = await readStyles();
  if (sameColour(hovered.idle?.bg, rest.idle?.bg)) {
    throw new Error(
      `hovering an idle row changes nothing (${hovered.idle?.bg}): the hover is a no-op`,
    );
  }
  if (!sameColour(hovered.idle?.bg, hoverGeometry.hoverWash)) {
    throw new Error(
      `a hovered session row is not filled with the neutral wash: got ${hovered.idle?.bg}, expected --lb-hover (${hoverGeometry.hoverWash})`,
    );
  }
  // The accent is the current row's, not the pointer's. This is the design's
  // fix 03 ("one signal") asserted as a colour.
  if (/rgba?\(5,\s*150,\s*105/.test(String(hovered.idle?.bg))) {
    throw new Error(`a hovered row wears the selected accent wash (${hovered.idle?.bg})`);
  }
  if (hovered.idle?.timeOpacity !== '0') {
    throw new Error(
      `the row's actions did not take the time's place (time opacity ${hovered.idle?.timeOpacity})`,
    );
  }
  if (hovered.idle?.actionsOpacity !== '1') {
    throw new Error(`a hovered row's actions did not appear (opacity ${hovered.idle?.actionsOpacity})`);
  }
  if (hovered.idle?.actionsPointer === 'none') {
    throw new Error('a hovered row\'s actions are visible but cannot be clicked');
  }
  // No reflow: the row is the same width before and during the reveal.
  if (hovered.idle?.w !== rest.idle?.w) {
    throw new Error(
      `revealing the actions moved the row (${rest.idle?.w}px -> ${hovered.idle?.w}px)`,
    );
  }

  // The current row: the pointer must not hand it the "you could open this"
  // fill. Read while the pointer is **on** it, not merely after.
  await dispatch('mouseMoved', hoverGeometry.currentAt.x, hoverGeometry.currentAt.y);
  await sleep(300);
  const onCurrent = await readStyles();
  if (onCurrent.current?.bg !== hoverGeometry.currentRest?.bg) {
    throw new Error(
      `the current session row takes the hover wash (${hoverGeometry.currentRest?.bg} -> ${onCurrent.current?.bg}): ` +
        'it is the conversation on screen, so a fill saying it can be opened is a lie',
    );
  }

  // Park the pointer again, so nothing below reads a hovered rail.
  await dispatch('mouseMoved', 1400, 880);
  await sleep(200);

  // ---- the actions: hidden at rest, and the current row's must not be clickable while invisible ----
  const rt = sk.retraction ?? {};
  if (rt.currentActionsPointer !== 'none') {
    throw new Error(
      `the current row's invisible actions still take the pointer (${rt.currentActionsPointer})`,
    );
  }
  // The idle row keeps its own actions interacting, which makes the pointer
  // rule a property of the current (disabled) row rather than of every row.
  if (rt.idleActionsPointer === 'none') {
    throw new Error('an idle row\'s actions are not reachable at all');
  }
  // A motion needs a transition; without one the buttons would jump.
  if (!String(rt.actionsTransition ?? '').includes('opacity')) {
    throw new Error(`the actions' reveal has no transition, so it jumps: ${rt.actionsTransition}`);
  }
  if (!String(rt.timeTransition ?? '').includes('opacity')) {
    throw new Error(`the time's fade has no transition, so it jumps: ${rt.timeTransition}`);
  }

  // The **light** shot is the one worth keeping, and it is the one this check
  // used to throw away: it switched the media feature, asserted the attribute,
  // and then switched back before capturing. The paint is exactly what an
  // attribute check cannot see — a card whose shadow was written for a dark
  // canvas is invisible here and red under the light tokens.
  const lightShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('render-check-light.png', Buffer.from(lightShot.result.data, 'base64'));
  console.log('screenshot: render-check-light.png (light)');

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
