/**
 * Measure the workbench panels' geometry, so a width change is checked by
 * numbers rather than by a screenshot nobody measures.
 *
 * The questions a resize can break, in the order they break:
 *
 *   1. Is the panel the width it claims? (The rung, per panel.)
 *   2. Does the two-column body still fit inside it — main + gap + rail == body?
 *   3. Does anything overflow its own box horizontally? A row whose content is
 *      wider than its container is clipped, and the clipped half is often the
 *      control at the far end (a row action, a select's caret), which then reads
 *      as a rendering bug rather than as a layout one.
 *   4. Does the head stay one line (or two, for a back row) and does the close
 *      sit at the panel's right edge?
 *
 * Usage: node scripts/probe-width.mjs [cdpPort] [url] [width] [height]
 */

const port = Number(process.argv[2] ?? 9333);
const url = process.argv[3] ?? 'http://127.0.0.1:5178/';
const width = Number(process.argv[4] ?? 1280);
const height = Number(process.argv[5] ?? 800);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PANELS = [
  ['tasks', 'Tasks', 800],
  ['config', 'Configuration', 1180],
  ['memory', 'Workspace memory', 800],
  ['settings', 'Settings', 1180],
  ['hooks', 'Hooks', 800],
  ['subagentPresets', 'Subagent presets', 800],
  ['learn', 'Learn this workspace', 800],
  ['codeintel', 'Code intelligence', 800],
];

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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const mid = ++id;
      pending.set(mid, r);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      return `THREW: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`;
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await send('Page.navigate', { url });

  for (let i = 0; i < 60; i += 1) {
    if ((await ev('typeof window.__aigoStore?.getState === "function"')) === true) break;
    await sleep(250);
  }

  // A bucket, so the panels that read a session have one to read.
  const KV = 'k-width';
  const seeded = await ev(`(() => {
    const store = window.__aigoStore;
    if (!store || typeof window.__aigoCreateBucket !== 'function') return 'no harness';
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KV)}, 'C:/Users/XPS/WorkBuddy/tudouni-aigo', { ericai: false, maxSteps: null });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KV)}]: bucket },
      order: s.order.includes(${JSON.stringify(KV)}) ? s.order : [...s.order, ${JSON.stringify(KV)}],
      activeKey: ${JSON.stringify(KV)},
      workspaces: ['C:/Users/XPS/WorkBuddy/tudouni-aigo'],
    }));
    window.__aigoKey = ${JSON.stringify(KV)};
    return 'ok';
  })()`);
  if (seeded !== 'ok') throw new Error(`seed failed: ${seeded}`);

  await ev(`(() => { window.__aigoStore.getState().applyRuntimeMessage(window.__aigoKey, ${JSON.stringify({
    v: 1,
    t: 'init',
    protocol: 18,
    session_id: '20261018-000000',
    resumed: false,
    model: 'deepseek-flash',
    provider: 'deepseek',
    thinking: true,
    effort: 'medium',
    effort_levels: ['minimal', 'low', 'medium', 'high'],
    model_catalog: { models: [], aliases: [] },
    workspace: 'C:/Users/XPS/WorkBuddy/tudouni-aigo',
    max_steps: 150,
    stream: true,
    context_tokens: 128000,
    tools: [],
    permissions: {},
    audit_path: 'C:/Users/XPS/WorkBuddy/tudouni-aigo/.tudouni/audit/x.jsonl',
    notices: [],
  })}); return true; })()`);
  await sleep(300);

  let failures = 0;
  const fail = (msg) => {
    failures += 1;
    console.log(`  FAIL ${msg}`);
  };

  for (const [kind, title, want] of PANELS) {
    await ev(`(() => { window.__aigoStore.getState().openPanel(${JSON.stringify(kind)}); return true; })()`);
    await sleep(700);

    const raw = await ev(`(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; };
      const d = document.querySelector('.dialog');
      if (!d) return JSON.stringify({ missing: true });
      const cs = getComputedStyle(d);
      const body = d.querySelector('.dialog-body');
      const head = d.querySelector('.dialog-head');
      const split = d.querySelector('.wb-split, .wm-layout, .tk-editor');
      const rail = d.querySelector('.wb-rail, .wm-rail, .tk-editor-side');
      const main = d.querySelector('.wb-main, .wm-col, .tk-editor-main');
      const headMain = d.querySelector('.wb-head-main');
      const close = head ? head.querySelector(':scope > .wb-head-main > .btn-icon:last-child, :scope > .btn-icon') : null;

      // Every descendant wider than its own scroll container, named by class.
      // 2px of slack: a sub-pixel rounding is not a defect.
      const overflows = [];
      for (const el of d.querySelectorAll('*')) {
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          const s = getComputedStyle(el);
          if (s.overflowX === 'hidden' || s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
          overflows.push({ cls: String(el.className || el.tagName).slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth });
        }
      }

      // **The symptom a shrink actually produces.** A panel whose contents no
      // longer fit does not throw and does not lose an element: the body starts
      // scrolling sideways, or a row's trailing control is clipped by the row's
      // own overflow:hidden.
      //
      // The body's content right edge is x + border + padding-left + clientWidth
      // - padding-right, **not** rect.right - padding: clientWidth excludes the
      // vertical scrollbar while rect.right includes it, so the lazy version
      // reports every full-width child as 12px past the edge.
      const bodyBox = body ? body.getBoundingClientRect() : null;
      const bodyStyle = body ? getComputedStyle(body) : null;
      const contentRight = body
        ? bodyBox.x +
          Number.parseFloat(bodyStyle.borderLeftWidth) +
          Number.parseFloat(bodyStyle.paddingLeft) +
          body.clientWidth -
          Number.parseFloat(bodyStyle.paddingRight)
        : null;
      const past = [];
      if (body && contentRight !== null) {
        for (const el of body.querySelectorAll('*')) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          if (b.right > contentRight + 2) {
            past.push({ cls: String(el.className || el.tagName).slice(0, 50), over: Math.round(b.right - contentRight) });
          }
        }
      }

      return JSON.stringify({
        cls: d.className,
        dialog: r(d),
        width: cs.width,
        body: body
          ? {
              ...r(body),
              display: getComputedStyle(body).display,
              cols: getComputedStyle(body).gridTemplateColumns,
              gap: getComputedStyle(body).columnGap,
              padX: getComputedStyle(body).paddingLeft,
              clientW: body.clientWidth,
              scrollW: body.scrollWidth,
            }
          : null,
        head: head ? r(head) : null,
        headMain: headMain ? r(headMain) : null,
        closeRight: close ? Math.round(close.getBoundingClientRect().right) : null,
        split: split
          ? {
              ...r(split),
              cols: getComputedStyle(split).gridTemplateColumns,
              gap: getComputedStyle(split).columnGap,
            }
          : null,
        main: main ? r(main) : null,
        rail: rail ? r(rail) : null,
        headPadRight: head ? getComputedStyle(head).paddingRight : null,
        viewportW: window.innerWidth,
        overflows: overflows.slice(0, 6),
        overflowCount: overflows.length,
        past: past.slice(0, 6),
        pastCount: past.length,
      });
    })()`);

    const m = JSON.parse(raw ?? '{}');
    console.log(`\n${kind} (${title})`);
    if (m.missing) {
      fail('no dialog opened');
      await ev(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
      continue;
    }
    console.log(`  dialog ${m.dialog.w}px  ${m.cls}`);

    const epsilon = 1;
    // `min(var(--wb-w), 100vw - 48px)` is the rule: the rung is an upper bound,
    // and a window too narrow to give it a 48px gutter wins. So the assertion is
    // "the panel is the rung, or the window clamped it" — not "the rung, always".
    const clamp = m.viewportW - 48;
    const expectedW = Math.min(want, clamp);
    if (Math.abs(m.dialog.w - expectedW) > epsilon) {
      fail(`width is ${m.dialog.w}, expected ${expectedW} (rung ${want}, clamp ${clamp})`);
    }
    if (m.head && m.dialog) {
      if (Math.abs(m.head.w - (m.dialog.w - 2)) > 2) {
        fail(`head is ${m.head.w} wide inside a ${m.dialog.w} dialog (border not accounted)`);
      }
    }
    if (m.closeRight !== null && m.dialog) {
      // The close sits at the head's right edge, less the head's padding.
      const pad = Number.parseFloat(String(m.headPadRight));
      const expected = m.dialog.x + m.dialog.w - 1 - pad;
      if (Math.abs(m.closeRight - expected) > 2) {
        fail(`close button right edge ${m.closeRight}, expected ${expected} (padding ${pad})`);
      }
    }
    if (m.split && m.main && m.rail) {
      // The claim: the two columns plus their gap fill the body's content box.
      // `clientWidth` and not `width`: the body scrolls vertically, and a
      // scrollbar eats into the box the columns are laid out in — measuring the
      // border box instead reports the scrollbar as a layout gap.
      //
      // **Only when there are two tracks.** Below the 1000px breakpoint the rail
      // folds under the main column on purpose, and both then measure full width;
      // summing them would report a stack as an overflow.
      const inner = Number.parseFloat(String(m.body.padX)) * 2;
      const content = m.body.clientW - inner;
      const gap = Number.parseFloat(String(m.split.gap));
      const tracks = String(m.split.cols).trim().split(/\s+/);
      if (tracks.length < 2) {
        console.log(`  stacked (${m.split.cols}), rail folded under the main column`);
      } else {
        const used = m.main.w + m.rail.w + gap;
        if (Math.abs(used - content) > 2) {
          fail(
            `columns ${m.main.w} + gap ${gap} + ${m.rail.w} = ${used} does not fill the body's content box ${content}`,
          );
        }
        console.log(`  split ${m.split.cols} (gap ${gap}) → main ${m.main.w}px, rail ${m.rail.w}px of ${content}`);
      }
    } else if (m.split) {
      console.log(`  split ${m.split.cols} (gap ${m.split.gap}), no rail found`);
    }
    if (m.overflowCount > 0) {
      fail(`${m.overflowCount} element(s) overflow horizontally: ${JSON.stringify(m.overflows)}`);
    } else {
      console.log('  no horizontal overflow');
    }
    if (m.body && m.body.scrollW > m.body.clientW + 2) {
      fail(`the body scrolls sideways: scrollWidth ${m.body.scrollW} > clientWidth ${m.body.clientW}`);
    }
    if (m.pastCount > 0) {
      fail(`${m.pastCount} element(s) extend past the body's right edge: ${JSON.stringify(m.past)}`);
    }

    await ev(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(200);
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} finding(s)`}`);
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  // Close the socket and let the loop drain before exiting: `process.exit` with
  // a still-open WebSocket trips a libuv assertion on Windows, which reports as a
  // crash *after* a passing run and reads like the probe failed.
  await new Promise((resolve) => {
    ws.addEventListener('close', resolve, { once: true });
    ws.close();
    setTimeout(resolve, 500);
  });
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
