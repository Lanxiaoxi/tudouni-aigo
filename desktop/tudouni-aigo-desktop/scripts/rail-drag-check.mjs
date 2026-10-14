/**
 * Rail drag check: drag both rails' handles in a real browser and measure what
 * moves.
 *
 * `tests/rail-drag.test.ts` asserts the drag *geometry* and the stylesheet's
 * wiring as text. What it cannot assert is the thing that actually breaks when a
 * CSS custom property is written on the wrong element or a handle is anchored to
 * the wrong edge: **whether the rail on screen gets wider, and in the direction
 * the pointer moved**. That is geometry against a real layout engine, so it
 * needs a browser — the same reasoning `turn-rail-check.mjs` gives for measuring
 * the turn rail rather than arguing about it.
 *
 * Five facts, none of them visible to the test suite:
 *   1. The handle exists on **both** rails, and each one sits on its rail's
 *      inner edge (the left rail's right edge, the right rail's left edge) —
 *      read from the handle's own bounding box against its rail's.
 *   2. Dragging the left rail's handle **right** widens the left rail, and
 *      dragging the right rail's handle **left** widens the right rail. Both
 *      directions are measured, because one sign serves one rail and mirroring
 *      it is a single keystroke — and the right rail shipped the wrong sign
 *      once.
 *   3. The two rails move independently: dragging one leaves the other's width
 *      byte-identical.
 *   4. Double-click hands the width back to the stylesheet, and the dragged
 *      width survives a reload (it is a persisted preference, not a transient
 *      style) — and **a narrower window does not throw it away**, which is the
 *      reason the `@media` fallbacks are `var(..., fallback)` rather than bare
 *      lengths.
 *   5. Only the rail being dragged is marked `is-resizing`, checked **while the
 *      button is still down** — the flag's whole job is to keep the *other*
 *      rail's handle from painting, and it exists only mid-gesture.
 *
 * The drag is driven with **real CDP mouse events** (`Input.dispatchMouseEvent`)
 * rather than by calling the store: the handlers are pointer-event based and
 * their whole job is the mapping from pointer travel to width, so driving the
 * store directly would assert the arithmetic while skipping the wiring — which
 * is the half that breaks.
 *
 * Usage:
 *   chrome --headless=new --remote-debugging-port=9333 about:blank
 *   node scripts/rail-drag-check.mjs [url] [cdpPort]
 */

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      problems.push(
        `console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`,
      );
    }
  });

  /**
   * A CDP call, with a deadline.
   *
   * The deadline is not decoration: a command Chrome never answers leaves this
   * promise pending forever, and a check that hangs prints nothing and looks
   * exactly like a check that is thinking. Ten seconds is far beyond any of
   * these round trips.
   */
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      const timer = setTimeout(() => {
        if (!pending.has(mid)) return;
        pending.delete(mid);
        problems.push(`CDP ${method} did not answer within 10s`);
        console.error(`  CDP timeout: ${method}`);
        resolve({});
      }, 10000);
      pending.set(mid, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      const detail =
        r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      problems.push(`eval threw: ${detail}`);
      console.error(`  eval threw: ${detail}`);
      return undefined;
    }
    if (r.result?.result?.value === undefined) {
      console.error(`  eval returned nothing; raw reply: ${JSON.stringify(r).slice(0, 400)}`);
      problems.push(`eval returned nothing: ${JSON.stringify(r).slice(0, 200)}`);
      return undefined;
    }
    return r.result?.result?.value;
  };

  const fail = (message) => {
    problems.push(message);
    console.error(`FAIL ${message}`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // Wide enough that both rails are laid out: `global.css` hides them below
  // 1024px, and a drag check against a `display: none` rail measures nothing.
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
  await sleep(3500);

  // **Start from the stylesheet's own defaults.** A dragged width is persisted
  // in `localStorage`, which outlives the browser profile — so a previous run of
  // this check (or a real session on the same profile) would leave the rails at
  // whatever width it last ended on, and every assertion below would be reading
  // relative to a state this run did not create. Clearing it also makes the
  // double-click assertion meaningful: "back to the default" only means
  // something when the default is where it started.
  await evaluate(`(() => { localStorage.removeItem('aigo.prefs'); return true; })()`);
  await send('Page.reload', { ignoreCache: false });
  await sleep(3000);

  /* ---------------- helpers, run in the page ---------------- */

  /**
   * A handle's centre in viewport coordinates, plus the rail's own box and the
   * handle's offset inside it. Read together so the edge assertion and the drag
   * origin come from one measurement.
   */
  const probe = (selector) => `(() => {
    const rail = document.querySelector('${selector}');
    if (!rail) return JSON.stringify({ missing: true });
    const handle = rail.querySelector('.rail-drag');
    if (!handle) return JSON.stringify({ missing: true, railOnly: true });
    const r = rail.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    return JSON.stringify({
      rail: { left: r.left, right: r.right, width: r.width, height: r.height },
      handle: { left: h.left, right: h.right, width: h.width, cx: h.left + h.width / 2, cy: h.top + h.height / 2 },
      // How far the handle's own edges sit from the rail's, which is what says
      // *which* edge it hangs on.
      fromRailLeft: h.left - r.left,
      fromRailRight: r.right - h.right,
    });
  })()`;

  const railWidths = () => `(() => {
    const l = document.querySelector('.app-rail-left');
    const r = document.querySelector('.app-rail-right');
    return JSON.stringify({
      left: l ? l.getBoundingClientRect().width : null,
      right: r ? r.getBoundingClientRect().width : null,
      leftVar: l ? l.style.getPropertyValue('--rail-w-dragged') : null,
      rightVar: r ? r.style.getPropertyValue('--rail-w-dragged') : null,
      resizing: [
        l && l.classList.contains('is-resizing'),
        r && r.classList.contains('is-resizing'),
      ],
    });
  })()`;

  const parse = (raw) => JSON.parse(raw ?? '{}');

  /**
   * A real drag: mouse down on the handle, a few moves, mouse up. The moves are
   * broken up because a single jump would not exercise the pointermove handler
   * the way a hand does — and `setPointerCapture` plus the document listeners
   * are exactly what a one-shot `dispatchMouseEvent` would not prove.
   *
   * `onHold` runs **while the button is still down**, which is the only moment
   * the drag's own transient state (which rail is marked `is-resizing`) exists.
   */
  const drag = async (cx, cy, dx, steps = 8, onHold) => {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: cx,
      y: cy,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i += 1) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cx + (dx * i) / steps,
        y: cy,
        button: 'left',
        buttons: 1,
      });
      await sleep(16);
    }
    if (onHold) await onHold();
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: cx + dx,
      y: cy,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await sleep(250); // let the width transition (if any) settle
  };

  /* ---------------- 1. both handles exist, on the inner edges ---------------- */

  const left = parse(await evaluate(probe('.app-rail-left')));
  const right = parse(await evaluate(probe('.app-rail-right')));

  console.log('left rail :', JSON.stringify(left));
  console.log('right rail:', JSON.stringify(right));

  if (left.missing) fail('the left rail has no drag handle (or no rail at all)');
  if (right.missing) fail('the right rail has no drag handle (or no rail at all)');

  if (!left.missing && !right.missing) {
    // The inner edge is the one facing the conversation. The left rail's is its
    // right edge, so its handle must sit flush against `rail.right`; the right
    // rail's is its left edge, flush against `rail.left`. Each is asserted
    // against the *other* edge too, so a handle that somehow spans the rail
    // cannot pass by touching both.
    if (left.fromRailRight > 1.5) {
      fail(
        `the left rail's handle is ${left.fromRailRight.toFixed(1)}px from its right edge — ` +
          'it must sit on the inner (right) edge',
      );
    }
    if (right.fromRailLeft > 1.5) {
      fail(
        `the right rail's handle is ${right.fromRailLeft.toFixed(1)}px from its left edge — ` +
          'it must sit on the inner (left) edge',
      );
    }
    if (left.fromRailLeft < 1.5) fail("the left rail's handle is on the outer edge, not the inner one");
    if (right.fromRailRight < 1.5) fail("the right rail's handle is on the outer edge, not the inner one");
  }

  const before = parse(await evaluate(railWidths()));
  console.log('widths before:', JSON.stringify(before));

  /* ---------------- 2. dragging outward widens, per rail ---------------- */

  // Left rail: the pointer moves **right** (+90) and the rail must get wider.
  if (!left.missing && left.handle) {
    await drag(left.handle.cx, left.handle.cy, 90, 8, async () => {
      // Mid-drag, and the half of `resizing` that names a rail: only the dragged
      // one may carry `is-resizing`. A shared boolean would put it on both, and
      // both handles paint the drag colour — two stripes glowing for one
      // gesture, on opposite sides of the window.
      const held = parse(await evaluate(railWidths()));
      console.log('mid-drag left  :', JSON.stringify(held));
      if (!held.resizing[0]) fail('the dragged (left) rail is not marked `is-resizing` mid-drag');
      if (held.resizing[1]) fail("dragging the left rail marked the *right* one `is-resizing` too");
    });
    const after = parse(await evaluate(railWidths()));
    console.log('after left +90 :', JSON.stringify(after));

    if (!(after.left > before.left + 40)) {
      fail(
        `dragging the left rail's handle right must widen it: ${before.left} -> ${after.left}`,
      );
    }
    if (after.right !== before.right) {
      fail(
        `dragging the left rail moved the right rail: ${before.right} -> ${after.right}`,
      );
    }
    if (after.leftVar === null || after.leftVar === '') {
      fail('the left rail did not write --rail-w-dragged, so the width is not a dragged one');
    }

    // Reset, so the next measurement starts from the stylesheet's own default.
    await evaluate(`(() => {
      const h = document.querySelector('.app-rail-left .rail-drag');
      const r = h.getBoundingClientRect();
      h.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return true;
    })()`);
    await sleep(250);
    const reset = parse(await evaluate(railWidths()));
    console.log('after dblclick :', JSON.stringify(reset));
    if (reset.leftVar !== '') {
      fail(`double-click must hand the width back to the stylesheet, left var is "${reset.leftVar}"`);
    }
    if (Math.abs(reset.left - before.left) > 1.5) {
      fail(`double-click must restore the default width: ${before.left} -> ${reset.left}`);
    }
  }

  /* ---------------- 3. the right rail, the mirrored direction ---------------- */

  if (!right.missing && right.handle) {
    const baseline = parse(await evaluate(railWidths()));
    // The mirrored gesture: the pointer moves **left** (−90) and the *right*
    // rail widens. If the left rail's sign were copied here, this is the
    // assertion that catches it — the rail would narrow instead.
    await drag(right.handle.cx, right.handle.cy, -90);
    const after = parse(await evaluate(railWidths()));
    console.log('after right -90:', JSON.stringify(after));

    if (!(after.right > baseline.right + 40)) {
      fail(
        `dragging the right rail's handle left must widen it: ${baseline.right} -> ${after.right}`,
      );
    }
    if (after.left !== baseline.left) {
      fail(`dragging the right rail moved the left rail: ${baseline.left} -> ${after.left}`);
    }
    if (after.rightVar === null || after.rightVar === '') {
      fail('the right rail did not write --rail-w-dragged');
    }
    if (after.resizing[0] || after.resizing[1]) {
      fail('a rail is still marked `is-resizing` after the pointer was released');
    }
  }

  /* ---------------- 4. the dragged width survives a reload ---------------- */

  const remembered = parse(await evaluate(railWidths()));
  await send('Page.reload', { ignoreCache: false });
  await sleep(3000);
  const reloaded = parse(await evaluate(railWidths()));
  console.log('after reload   :', JSON.stringify(reloaded));

  if (Math.abs(reloaded.right - remembered.right) > 1.5) {
    fail(
      `the dragged width must be remembered as a preference: ` +
        `${remembered.right} before the reload, ${reloaded.right} after`,
    );
  }

  /* ---------------- 5. a narrower window does not throw the width away -------- */

  // The narrow-window `@media` rules carry their own fallbacks (216/236px), and
  // the point of writing them as `var(--rail-w-dragged, …)` is that a width the
  // person chose is **not** suspended by the window getting narrower. A bare
  // length there would silently discard it, and on screen that reads as "my
  // sidebar reset itself when I resized the window".
  const dragged = reloaded;
  if (dragged.right > 300) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    const narrow = parse(await evaluate(railWidths()));
    console.log('at 1100px wide :', JSON.stringify(narrow));
    if (Math.abs(narrow.right - dragged.right) > 1.5) {
      fail(
        `the narrow-window rule threw the dragged width away: ` +
          `${dragged.right} -> ${narrow.right} at 1100px`,
      );
    }
  } else {
    console.log('(skipped the narrow-window check: no dragged width to carry)');
  }

  /* ---------------- report ---------------- */

  // The CDP socket keeps the event loop alive after the last assertion, so a
  // check that has finished would sit there looking like one that is still
  // working. Close it and say so; the exit code is the answer.
  ws.close();

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nPASS — both rails drag from their inner edge, in their own direction, on their own field.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
