/**
 * Find check: drive `Ctrl+F` with real key events and measure what it did.
 *
 * `tests/find.test.tsx` covers the rules that can be read off an `Entry[]` and an
 * offset. Four things about this feature cannot be:
 *
 *   1. **Is `Ctrl+F` wired to it at all?** The key was previously swallowed by
 *      `useGlobalKeys`'s reload-key guard, and the guard runs before the terminal
 *      check — so removing it from that list is a one-line change whose failure
 *      mode is "the key does nothing", which no unit test can see.
 *   2. **Did a mark actually paint, and where?** A `Highlight` is a registry of
 *      live `Range`s. The prototype measured the trap: a commit that rewrites a
 *      text node leaves every range over that row empty and drawing nothing,
 *      while the registry still counts it. So this asserts liveness and geometry,
 *      not just the count.
 *   3. **Does the jump land on the hit?** The same estimate problem the turn rail
 *      documents — this checks that the current hit's own rect ends up inside the
 *      transcript's viewport.
 *   4. **Does `Esc` mean "close the search" rather than "interrupt the turn"?**
 *      Both are one key press away in a running conversation, and the wrong one
 *      is not undoable.
 *
 * Usage:
 *   npm run dev
 *   chrome --headless=new --remote-debugging-port=9333 about:blank
 *   node scripts/find-check.mjs [url] [cdpPort] [screenshotPath]
 */

import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const shotPath = process.argv[4] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = 'k-find-check';
const NEEDLE_ANSWER = 'alpha-marker';
const NEEDLE_USER = 'omega-prompt';
const NEEDLE_FOLDED = 'theta-thought';
/**
 * Turns, and paragraphs per answer.
 *
 * Sized so the transcript is **several screens tall**, which is the only way the
 * navigation assertions mean anything: with a conversation that fits in one
 * viewport every hit is already on screen, `scrollIntoView` legitimately does
 * nothing, and "the jump moved the transcript" passes or fails on the layout
 * rather than on the jump.
 */
const TURNS = 6;
const PARAS = 40;

async function main() {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  }).then((r) => r.json());

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      problems.push(`exception: ${d?.exception?.description ?? d?.text}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      problems.push(`console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`);
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
      const detail = r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      throw new Error(`eval threw: ${detail}\n--- expression ---\n${expression.slice(0, 500)}`);
    }
    return r.result?.result?.value;
  };

  const failures = [];
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(label);
  };

  /**
   * Type into the box the way a reader does: select what is there, then insert.
   *
   * `Input.insertText` goes through the browser's own editing pipeline, so the
   * box's `onChange` runs exactly as it does for a person — which matters here,
   * because "does the bar re-scan when the needle changes" is one of the things
   * this check is for. The `select()` is what makes the second search replace the
   * first needle rather than extend it, the same way a second `Ctrl+F` does.
   */
  const typeInto = async (text) => {
    await evaluate(`(() => {
      const el = document.querySelector('.find-input');
      if (el === null) return false;
      el.focus();
      el.select();
      return true;
    })()`);
    await send('Input.insertText', { text });
    await sleep(400);
  };

  /** One real key press: `keyDown` then `keyUp`, with `modifiers` (Ctrl = 2). */
  const key = async (name, code, vk, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: vk, modifiers });
    }
    await sleep(160);
  };
  const ctrlF = () => key('f', 'KeyF', 70, 2);
  const enter = () => key('Enter', 'Enter', 13);
  /** Shift+Enter, which walks the hits backwards. */
  const shiftEnter = () => key('Enter', 'Enter', 13, 8);
  const escape = () => key('Escape', 'Escape', 27);

  /** What the registry holds, and whether those ranges still draw. */
  const highlighted = () =>
    evaluate(`(() => {
      const all = CSS.highlights.get('find-match');
      const cur = CSS.highlights.get('find-current');
      const ranges = all ? [...all] : [];
      const current = cur ? [...cur][0] : null;
      const scroller = document.querySelector('.stream-scroll');
      const s = scroller ? scroller.getBoundingClientRect() : null;
      const r = current ? current.getBoundingClientRect() : null;
      return {
        matched: ranges.length,
        live: ranges.filter((x) => !x.collapsed).length,
        currentOnScreen: r !== null && s !== null ? Math.round(r.top - s.top) : null,
        viewport: scroller ? scroller.clientHeight : null,
        top: scroller ? Math.round(scroller.scrollTop) : null,
      };
    })()`);

  const barState = () =>
    evaluate(`(() => {
      const bar = document.querySelector('.find-bar');
      const count = document.querySelector('.find-count');
      return {
        open: bar !== null,
        focused: document.activeElement !== null && document.activeElement.classList.contains('find-input'),
        count: count ? count.textContent : null,
        folds: document.querySelectorAll('.e-reason .collapse.is-collapsed').length,
      };
    })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await send('Page.navigate', { url });
  /**
   * Wait for the app, not for a number of milliseconds.
   *
   * A cold Vite — one that has just optimised its dependencies — takes longer to
   * mount React than a warm one, and a fixed wait then reads as "the dev-only
   * handles are missing", which is a lie about the code. This bit the run that
   * first exercised this script after the dev server had been restarted.
   */
  const waitForMount = async () => {
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if ((await evaluate(`typeof window.__aigoCreateBucket === 'function'`)) === true) return true;
      await sleep(250);
    }
    return false;
  };
  if (!(await waitForMount())) {
    throw new Error(`the app never mounted at ${url} (waited 20s)`);
  }

  /* ---- a conversation: three restored turns, and one that stays running ---- */

  const ready = await evaluate(`(() => {
    const store = window.__aigoStore;
    if (typeof window.__aigoCreateBucket !== 'function') return 'no bucket factory';
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/work/project', { ericai: false, maxSteps: null });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
    }));
    window.__aigoKey = ${JSON.stringify(KEY)};
    return 'ok';
  })()`);
  if (ready !== 'ok') {
    // Say what is on the page rather than only that the handle was missing: the
    // two causes are a dev server that is not serving this app (a stale tab, a
    // build rather than `npm run dev`) and a boot that threw, and they are told
    // apart by what is in the body.
    const where = await evaluate(`(() => JSON.stringify({
      title: document.title,
      handles: Object.keys(window).filter((k) => k.startsWith('__aigo')),
      root: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
      body: document.body.innerText.slice(0, 200),
    }))()`);
    throw new Error(`the harness could not open a bucket: ${ready}\npage: ${where}`);
  }

  const messages = [];
  for (let t = 1; t <= TURNS; t += 1) {
    messages.push({ role: 'user', content: `question ${t} ${NEEDLE_USER}` });
    const paras = [`answer ${t} ${NEEDLE_ANSWER}`];
    for (let p = 2; p <= PARAS; p += 1) {
      paras.push(`Paragraph ${p} of answer ${t}, long enough to be a real line of prose.`);
    }
    messages.push({ role: 'assistant', content: paras.join('\n\n') });
  }

  await evaluate(`(() => {
    const store = window.__aigoStore;
    const key = window.__aigoKey;
    const send = (p) => store.getState().applyRuntimeMessage(key, p);
    send({ v: 1, t: 'init', protocol: 3, session_id: 's-find-check', resumed: false,
      model: 'deepseek-chat', provider: 'deepseek', thinking: true, effort: 'high',
      effort_levels: ['minimal','low','medium','high','xhigh','max'], workspace: 'C:/work/project',
      max_steps: 120, stream: true, context_tokens: 65536, tools: [], permissions: {},
      audit_path: 'C:/work/project/.tudouni/audit/s-find-check.jsonl', notices: [] });
    send({ v: 1, t: 'session_load', messages: ${JSON.stringify(messages)} });
    // The live turn: reasoning that folds, and a body that keeps streaming — so
    // the transcript ends in a row whose text changes under the reader, and a hit
    // that starts out inside a shut fold.
    const run = 'r-find';
    send({ v: 1, t: 'event', kind: 'run_started', session_id: 's-find-check', run_id: run,
      step: 0, ts: '2026-01-01T00:00:00Z', model: 'deepseek-chat', provider: 'deepseek' });
    send({ v: 1, t: 'event', kind: 'model_call', session_id: 's-find-check', run_id: run,
      step: 0, ts: '2026-01-01T00:00:01Z', status: 'ok', duration_ms: 1900,
      prompt_tokens: 1000, cached_tokens: 700, completion_tokens: 40,
      reasoning: 'Live thinking that carries ${NEEDLE_FOLDED} exactly once.' });
    send({ v: 1, t: 'delta', session_id: 's-find-check', run_id: run, step: 1,
      channel: 'text', text: 'A live body.', reset: false });
    return true;
  })()`);
  await sleep(900);

  const mounted = await evaluate(`(() => JSON.stringify({
    rows: document.querySelectorAll('.stream-inner > *').length,
    marked: document.querySelectorAll('[data-entry]').length,
    folds: document.querySelectorAll('.e-reason .collapse.is-collapsed').length,
  }))()`);
  console.log('transcript:', mounted);

  /* ---- 1. Ctrl+F raises the bar, and the keyboard goes into it ---- */

  console.log('\n1. Ctrl+F');
  await ctrlF();
  let bar = await barState();
  check('the bar is up', bar.open);
  check('the box has the keyboard', bar.focused);
  check('and it says nothing yet', bar.count === '', `count=${JSON.stringify(bar.count)}`);

  // A second Ctrl+F must re-focus, not toggle the bar away: a key that closed the
  // thing it opened reads as the key having failed.
  await evaluate(`(() => { document.querySelector('.stream-scroll').focus(); return true; })()`);
  await ctrlF();
  bar = await barState();
  check('a second Ctrl+F keeps it up and refocuses it', bar.open && bar.focused);

  /* ---- 2. typing finds every answer, and the marks are live ---- */

  console.log('\n2. searching');
  await typeInto(NEEDLE_ANSWER);
  bar = await barState();
  let marks = await highlighted();
  check('the count is every answer', bar.count === `1 of ${TURNS}`, `count=${JSON.stringify(bar.count)}`);
  check('every hit is a live range', marks.matched === TURNS && marks.live === TURNS, JSON.stringify(marks));
  check(
    'the current hit is inside the transcript’s viewport',
    marks.currentOnScreen !== null && marks.currentOnScreen >= 0 && marks.currentOnScreen < marks.viewport,
    `top=${marks.currentOnScreen} viewport=${marks.viewport}`,
  );

  // A **prompt**, which is the row people search a transcript for most, and the
  // one row shape whose `data-entry` element *is* its own content container. The
  // engine looked for the container among the row's descendants, so every prompt
  // was skipped — a hit that was counted as zero and had no counter to disagree
  // with. The live streamed body is the same shape, which is why the assertion
  // after it is about the row that is still being written.
  await typeInto(NEEDLE_USER);
  bar = await barState();
  check('a prompt is findable', bar.count === `1 of ${TURNS}`, `count=${JSON.stringify(bar.count)}`);

  await typeInto(NEEDLE_ANSWER);
  bar = await barState();
  check('and the needle can be replaced', bar.count === `1 of ${TURNS}`, `count=${JSON.stringify(bar.count)}`);

  /* ---- 3. Enter walks the hits, and each one is brought into view ---- */

  console.log('\n3. walking the hits');
  const first = marks.top;
  // Backwards from the first hit wraps to the last one, which is screens away —
  // so this press is the one that has to move the transcript, and the order of
  // the assertion matters: a jump that did nothing would leave the reader at the
  // top while the count said `6 of 6`.
  await shiftEnter();
  await sleep(300);
  bar = await barState();
  marks = await highlighted();
  check('Shift+Enter wraps back to the last hit', bar.count === `${TURNS} of ${TURNS}`, `count=${JSON.stringify(bar.count)}`);
  check(
    'the last hit is on screen',
    marks.currentOnScreen !== null && marks.currentOnScreen >= 0 && marks.currentOnScreen < marks.viewport,
    `top=${marks.currentOnScreen} viewport=${marks.viewport}`,
  );
  check('and the transcript went to it', marks.top > first, `scrollTop ${first} -> ${marks.top}`);

  await enter();
  await sleep(300);
  bar = await barState();
  marks = await highlighted();
  check('Enter then wraps forward to the first', bar.count === `1 of ${TURNS}`, `count=${JSON.stringify(bar.count)}`);
  check('and the transcript came back to the top', marks.top < first + 1, `scrollTop ${first} -> ${marks.top}`);

  /* ---- 4. a hit inside a shut fold is opened, not scrolled to blind ---- */

  console.log('\n4. a hit inside folded thinking');
  await typeInto(NEEDLE_FOLDED);
  bar = await barState();
  marks = await highlighted();
  check('the folded hit is found', bar.count === '1 of 1', `count=${JSON.stringify(bar.count)}`);
  check('the fold holding it was opened', bar.folds === 0, `shut folds left: ${bar.folds}`);
  check(
    'and the mark is on screen, alive',
    marks.live === 1 && marks.currentOnScreen !== null && marks.currentOnScreen < marks.viewport,
    JSON.stringify(marks),
  );

  /* ---- 5. Esc closes the search and does not interrupt the turn ---- */

  console.log('\n5. Esc, with a turn still running');
  await escape();
  await sleep(250);
  bar = await barState();
  const running = await evaluate(`(() => {
    const s = window.__aigoStore.getState();
    const entries = s.sessions[window.__aigoKey].entries;
    const last = [...entries].reverse().find((e) => e.kind === 'turn');
    return { open: s.findOpen, status: last ? last.status : null, query: s.findQuery };
  })()`);
  check('the bar is gone', !bar.open);
  check('the store agrees, needle and all', running.open === false && running.query === '');
  check('the turn was not interrupted', running.status === 'running', `status=${running.status}`);

  /* ---- 6. the session bar's own search button ---- */

  console.log('\n6. the button in the session bar');
  /** A real mouse press, like `window-controls-check.mjs` uses: a synthetic
   *  `.click()` bypasses hit testing, so it reports success on a control a person
   *  cannot actually reach. */
  const clickAt = async (selector) => {
    const at = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (at === null) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
    return true;
  };

  const buttonState = () =>
    evaluate(`(() => {
      const el = document.querySelector('.sb-find');
      return { present: el !== null, disabled: el !== null ? el.disabled : null };
    })()`);

  let button = await buttonState();
  check(
    'it is drawn beside the right rail’s toggle, and enabled',
    button.present && button.disabled === false,
    JSON.stringify(button),
  );
  check('the press lands on it', await clickAt('.sb-find'));
  bar = await barState();
  check('and it raises the bar with the keyboard in it', bar.open && bar.focused, JSON.stringify(bar));

  // Closed again first, so the next assertion is about the key rather than about
  // a flag the button left set.
  await escape();
  await sleep(250);
  check(
    'Esc closes what the button opened',
    (await evaluate(`window.__aigoStore.getState().findOpen`)) === false,
  );

  // The gate. On the board there is no conversation text on screen, so the
  // button is not drawn — and `Ctrl+F` must not leave a flag set that would
  // produce a bar out of nowhere once the board closes.
  await evaluate(`(() => { window.__aigoStore.getState().setBoardOpen(true); return true; })()`);
  await sleep(500);
  button = await buttonState();
  check('the board takes it away with the transcript', !button.present, JSON.stringify(button));
  await ctrlF();
  check(
    'and Ctrl+F there opens nothing',
    (await evaluate(`window.__aigoStore.getState().findOpen`)) === false,
  );
  await evaluate(`(() => { window.__aigoStore.getState().setBoardOpen(false); return true; })()`);
  await sleep(600);
  button = await buttonState();
  check('closing the board brings it back', button.present, JSON.stringify(button));

  /* ---- 7. a chunk under the reader’s cursor does not move the viewport ---- */

  console.log('\n7. a streamed chunk while the bar is up');
  await ctrlF();
  const focused = await evaluate(`(() => {
    const s = window.__aigoStore.getState();
    const input = document.querySelector('.find-input');
    return {
      hasBar: document.querySelector('.find-bar') !== null,
      value: input ? input.value : null,
      active: document.activeElement ? document.activeElement.className : null,
      selection: input ? input.selectionEnd - input.selectionStart : null,
      storeQuery: s.findQuery,
      focusToken: s.findFocus,
    };
  })()`);
  console.log('  after Ctrl+F:', JSON.stringify(focused));
  // Ask the engine directly, through the dev server's own module graph — a
  // **second instance** of the module (the trap `main.tsx` documents for the
  // store), so its cache is empty and a full pass tells the two failures apart:
  // "the scan cannot see these hits" from "the bar is not re-scanning".
  const direct = await evaluate(`(async () => {
    const mod = await import('/src/find/engine.ts');
    const s = window.__aigoStore.getState();
    const kinds = new Set(['user', 'stream', 'answer', 'reason']);
    const byId = new Map(s.sessions[window.__aigoKey].entries
      .filter((e) => kinds.has(e.kind))
      .map((e) => [e.id, e]));
    const r = mod.scanTranscript(byId, ${JSON.stringify(NEEDLE_USER)});
    return JSON.stringify({ hits: r.hits.length, rows: byId.size, refound: r.refound, ms: r.ms });
  })()`);
  const directResult = JSON.parse(direct ?? '{}');
  check(
    'the engine itself finds every prompt when asked directly',
    directResult.hits === TURNS,
    direct,
  );
  await typeInto('the');
  const beforeChunk = await evaluate(`(() => {
    const s = window.__aigoStore.getState();
    const stream = [...s.sessions[window.__aigoKey].entries].filter((e) => e.kind === 'stream');
    return {
      top: Math.round(document.querySelector('.stream-scroll').scrollTop),
      count: document.querySelector('.find-count').textContent,
      input: document.querySelector('.find-input') ? document.querySelector('.find-input').value : null,
      storeQuery: s.findQuery,
      streamChars: stream.reduce((n, e) => n + e.text.length, 0),
      streamRendered: (document.querySelector('.e-stream')?.textContent ?? '').length,
    };
  })()`);
  // Eight chunks, each of which adds a `the` to the row the reader is watching.
  // Applied one at a time, with the scroll read between them: a drift is a
  // symptom with a shape, and a single before/after pair cannot tell a one-off
  // layout adjustment from a follow that is being re-asserted per chunk.
  const drift = [];
  for (let i = 0; i < 8; i += 1) {
    await evaluate(`(() => {
      const store = window.__aigoStore;
      window.__aigoFlushSync(() => {
        store.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'delta',
          session_id: 's-find-check', run_id: 'r-find', step: 1, channel: 'text',
          text: ' more words in the body', reset: false });
      });
      return true;
    })()`);
    drift.push(await evaluate(`Math.round(document.querySelector('.stream-scroll').scrollTop)`));
  }
  await sleep(400);
  const afterChunk = await evaluate(`(() => {
    const s = window.__aigoStore.getState();
    const stream = [...s.sessions[window.__aigoKey].entries].filter((e) => e.kind === 'stream');
    return {
      top: Math.round(document.querySelector('.stream-scroll').scrollTop),
      count: document.querySelector('.find-count').textContent,
      input: document.querySelector('.find-input') ? document.querySelector('.find-input').value : null,
      storeQuery: s.findQuery,
      streamChars: stream.reduce((n, e) => n + e.text.length, 0),
      streamRendered: (document.querySelector('.e-stream')?.textContent ?? '').length,
    };
  })()`);
  console.log(`  trace: top ${beforeChunk.top} -> ${drift.join(', ')} -> ${afterChunk.top}`);
  console.log(`  text: ${JSON.stringify(beforeChunk)}`);
  console.log(`    ->  ${JSON.stringify(afterChunk)}`);
  check(
    'the reader’s position is not dragged by the streaming output',
    Math.abs(afterChunk.top - beforeChunk.top) < 50,
    `${beforeChunk.top} -> ${afterChunk.top}`,
  );
  check(
    'but the count still grew, so the marks follow the text',
    afterChunk.count !== beforeChunk.count,
    `${JSON.stringify(beforeChunk.count)} -> ${JSON.stringify(afterChunk.count)}`,
  );

  if (shotPath !== '') {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = shot.result?.data;
    if (typeof data === 'string') {
      writeFileSync(shotPath, Buffer.from(data, 'base64'));
      console.log(`\nscreenshot: ${shotPath}`);
    }
  }

  console.log('');
  if (problems.length > 0) {
    console.log('page problems:');
    for (const p of problems) console.log('   ' + p);
  }
  if (problems.length > 0 || failures.length > 0) {
    console.log(`FAILED: ${failures.length} assertion(s), ${problems.length} page problem(s)`);
    for (const f of failures) console.log(`   ${f}`);
    // `exitCode` rather than `process.exit`: exiting while the WebSocket is
    // still closing trips a libuv assertion on Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`), and the process then reports
    // `0xC0000409` instead of 1. Setting the code and returning lets Node close
    // the socket itself and exit honestly.
    await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
    ws.close();
    process.exitCode = 1;
    return;
  }

  console.log('PASS — Ctrl+F finds, walks, opens folds, and holds the reader’s place');
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
