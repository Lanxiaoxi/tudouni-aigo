/**
 * Window controls check: can a person actually click minimize / maximize / close?
 *
 * This exists because that question is **invisible to every other check here**,
 * and because it silently regressed once already. The title bar draws correctly,
 * the buttons show hover styling, `tsc` is clean, the unit tests pass — and a
 * real click does nothing, because a modal layer is over them and the browser
 * never delivers the event. Nothing on screen is wrong; the buttons are just
 * dead.
 *
 * ## Why this cannot be a DOM assertion
 *
 * `document.elementFromPoint` gives a *hint* (is the mask on top?) and the
 * assertions below do check it. But the decisive fact is "does a click emit the
 * IPC command", and that needs two things a normal page does not have:
 *
 *   1. a **fake `__TAURI_INTERNALS__`** that records every `invoke`, installed
 *      before the application module loads;
 *   2. **CDP's real mouse events** (`Input.dispatchMouseEvent`), not synthetic
 *      `.click()`.
 *
 * Point 2 is not a preference, it is the whole lesson of this check. A synthetic
 * `.click()` is delivered straight to the element and **bypasses hit testing
 * entirely** — so it reports success on a button a person cannot reach. The first
 * version of the probe that found this bug used synthetic clicks and reported
 * that everything was fine; the failure only appeared once real mouse events were
 * dispatched at the coordinates a person would aim at.
 *
 * ## What it checks
 *
 *   - each of the three buttons emits its command with **nothing** open (baseline);
 *   - the same three emit it **with a panel open** — the case that was broken;
 *   - the same, with a **blocking approval modal** up, which is the hardest case
 *     and the one that matters most (a person must always be able to move or
 *     close the window, especially when the runtime is stuck on an approval);
 *   - a real double-click on the title text toggles maximize **once**, not twice
 *     (`internal_toggle_maximize` from Tauri's own `drag.js`; an `onDoubleClick`
 *     in `TitleBar.tsx` used to send a second `toggle_maximize`, and one on plus
 *     one off is net zero).
 *
 * Usage:
 *   node scripts/window-controls-check.mjs [url] [cdpPort]
 *
 * Needs `npm run dev` running and a CDP-enabled browser. The Tauri `drag.js` is
 * read from the pinned crate in the local cargo registry; if it is not there the
 * double-click check is skipped and said so, rather than being faked.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The pinned Tauri's own `drag.js`, which is what handles the double-click. */
function findDragScript() {
  const registry = join(homedir(), '.cargo', 'registry', 'src');
  if (!existsSync(registry)) return null;
  for (const index of readdirSync(registry)) {
    const dir = join(registry, index);
    for (const crate of readdirSync(dir)) {
      if (!crate.startsWith('tauri-2.')) continue;
      const script = join(dir, crate, 'src', 'window', 'scripts', 'drag.js');
      if (existsSync(script)) return { version: crate, path: script };
    }
  }
  return null;
}

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function main() {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  ).then((r) => r.json());

  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(
        r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text,
      );
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // ---- the fake host, installed before any application script runs ----
  //
  // It records every `invoke` and answers the handful of commands the app makes
  // at start-up. `metadata.currentWindow.label` is required by
  // `getCurrentWindow()`, and the event commands by `listen`.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__ipc = [];
      window.__TAURI_INTERNALS__ = {
        transformCallback(cb) { const i = (window.__cb = (window.__cb || 0) + 1); window['_' + i] = cb; return i; },
        unregisterCallback() {},
        convertFileSrc: (p) => p,
        metadata: { currentWindow: { label: 'main' } },
        invoke(cmd, args) {
          window.__ipc.push(cmd);
          if (cmd === 'plugin:event|listen') return Promise.resolve(args && args.handler);
          if (cmd === 'plugin:event|unlisten') return Promise.resolve(null);
          if (cmd === 'plugin:window|is_maximized') return Promise.resolve(window.__maximized === true);
          if (cmd === 'plugin:window|internal_toggle_maximize'
              || cmd === 'plugin:window|toggle_maximize') {
            window.__maximized = !window.__maximized;
          }
          return Promise.resolve(null);
        },
      };
    `,
  });

  // Tauri's own drag.js, exactly as the crate ships it (only the OS name, which
  // the real build substitutes at compile time, is filled in here).
  const drag = findDragScript();
  if (drag) {
    const source = readFileSync(drag.path, 'utf8').replace('__TEMPLATE_os_name__', "'windows'");
    await send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  await send('Page.navigate', { url });
  await sleep(3500);

  const ready = await evaluate(`typeof window.__aigoStore?.getState === 'function'`);
  if (!ready) throw new Error('the app did not expose its store — is `npm run dev` up?');
  console.log(`host: fake __TAURI_INTERNALS__ recording IPC`);
  console.log(`drag.js: ${drag ? `${drag.version} (the pinned crate's own)` : 'NOT FOUND — double-click check skipped'}`);
  console.log('');

  /** Where a real click at the element's centre lands, and what it emits. */
  async function clickControl(selector) {
    const at = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit ? hit.className || hit.tagName : null,
               inControl: !!(hit && el.contains(hit)) };
    })()`);
    if (!at) throw new Error(`${selector} is not in the document`);
    await evaluate('window.__ipc.length = 0');
    // A real press and release at the coordinates a person would aim at. Two
    // events because that is what a click is; `clickCount: 1` so it is not read
    // as a double-click.
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1,
    });
    await sleep(180);
    return { ...at, ipc: await evaluate('window.__ipc.slice()') };
  }

  const BUTTONS = [
    ['.wc:not(.wc-close)', 'plugin:window|minimize'],
    ['.wc:nth-of-type(2)', 'plugin:window|toggle_maximize'],
    ['.wc-close', 'plugin:window|close'],
  ];

  // ---- 1. the baseline: nothing open ----
  console.log('nothing open:');
  for (const [selector, command] of BUTTONS) {
    const r = await clickControl(selector);
    check(r.ipc.includes(command), `${command} reached the host (hit ${r.hit})`);
  }

  // ---- 2. a panel open — the reported failure ----
  //
  // `/files` is a modal layer drawn **over** the title bar. Before the fix the
  // mask was on top and Radix had set `pointer-events: none` on `body`, which the
  // title bar inherited: no click was ever delivered.
  console.log('');
  console.log('with a panel open:');
  await evaluate(`window.__aigoStore.getState().openPanel('files')`);
  await sleep(500);
  const panelUp = await evaluate(`!!document.querySelector('.overlay-mask')`);
  check(panelUp, 'the panel really opened (an overlay-mask is in the DOM)');

  for (const [selector, command] of BUTTONS) {
    const r = await clickControl(selector);
    check(r.inControl, `a real click lands on the button, not the mask (hit ${r.hit})`);
    check(r.ipc.includes(command), `${command} reached the host`);
  }

  // **A panel closes, and that is correct rather than a leak.** The title bar is
  // raised above the mask, so a click on it is also a click on the page behind
  // the mask, and `DialogPrimitive` reads an outside-pointer event as "dismiss" —
  // so the panel goes away *and* the window command is sent. Both are the
  // person's intent in the only reading available: they aimed at the window
  // frame, and a panel that stayed up would be the one state where clicking the
  // frame does nothing.
  //
  // The approval modal is the opposite, and deliberately so — it is checked
  // below. There, "outside" cannot mean "dismiss", because a stray click is not a
  // decision.
  check(
    !(await evaluate(`!!document.querySelector('.overlay-mask')`)),
    'clicking the frame over a panel both sends the command and dismisses the panel',
  );

  await evaluate(`window.__aigoStore.setState({ panel: null })`);
  await sleep(300);

  // ---- 3. a blocking approval modal — the case that matters most ----
  //
  // This is the state where a person is most likely to need the window controls:
  // the runtime is waiting for a decision and will wait for ever. `PermissionModal`
  // also prevents outside-pointer events, so the two properties are checked
  // together — the buttons work **and** the prompt is not answered by accident.
  console.log('');
  console.log('with a blocking approval modal:');
  await evaluate(`window.__aigoStore.setState({
    modal: {
      kind: 'permission',
      key: 'k-check',
      req: {
        id: 'p1', tool: 'shell', risk: 'high',
        arguments: { command: 'rm -rf build' },
        remember: null, remember_hint: null,
        allow_trust_all: false, trust_all_hint: null,
      },
    },
  })`);
  await sleep(500);
  check(
    await evaluate(`!!document.querySelector('.overlay-mask')`),
    'the approval modal is up',
  );

  for (const [selector, command] of BUTTONS) {
    const r = await clickControl(selector);
    check(r.inControl, `a real click lands on the button, not the mask (hit ${r.hit})`);
    check(r.ipc.includes(command), `${command} reached the host`);
  }

  check(
    await evaluate(`!!document.querySelector('.overlay-mask')`),
    'the approval is still waiting after clicking the title bar',
  );

  await evaluate(`window.__aigoStore.setState({ modal: null })`);
  await sleep(300);

  // ---- 4. double-clicking the drag region toggles maximize once ----
  //
  // Tauri 2.12 injects its own `drag.js`, which sends `internal_toggle_maximize`
  // on `detail === 2`. `TitleBar.tsx` used to add its own `onDoubleClick` sending
  // `toggle_maximize`, so one real double-click sent both — on, then off, net
  // zero — and the window appeared not to respond.
  if (drag) {
    console.log('');
    console.log('double-clicking the drag region:');
    const at = await evaluate(`(() => {
      const el = document.querySelector('.tb-title');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await evaluate('window.__ipc.length = 0; window.__maximized = false');
    for (const clickCount of [1, 2]) {
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount,
      });
      await sleep(120);
    }
    await sleep(250);
    const ipc = await evaluate('window.__ipc.slice()');
    const toggles = ipc.filter(
      (c) => c === 'plugin:window|toggle_maximize' || c === 'plugin:window|internal_toggle_maximize',
    );
    check(toggles.length === 1, `exactly one maximize toggle was sent (got ${toggles.length}: ${JSON.stringify(ipc)})`);
    check(
      await evaluate('window.__maximized === true'),
      'the window really ended up maximized, not toggled back',
    );
  }

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log('PASS — the window controls are reachable through every overlay,');
  console.log('       and a double-click on the title bar toggles maximize once.');
}

main().catch((error) => {
  console.error('');
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
