/**
 * The second surfaces, measured at the narrow rung.
 *
 * A list can shrink and just scroll; a **page** cannot — it is a form whose
 * fields, hint sentences and two-column rows are laid out on the assumption that
 * they fit. So the panels' second surfaces (a route's page, an MCP server's page,
 * the hook editor, a preset's page, the task editor) get their own pass: open the
 * list, click a row, then measure the page it opened.
 *
 * Usage: node scripts/probe-pages.mjs [cdpPort] [url] [width] [height]
 */

const port = Number(process.argv[2] ?? 9333);
const url = process.argv[3] ?? 'http://127.0.0.1:5178/';
const width = Number(process.argv[4] ?? 1280);
const height = Number(process.argv[5] ?? 800);

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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
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
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i += 1) {
    if ((await ev('typeof window.__aigoStore?.getState === "function"')) === true) break;
    await sleep(250);
  }

  // The panels read their config through the Tauri bridge, which a plain browser
  // does not have, so the config family cannot open a real page here. What this
  // probe covers is the surfaces that are driven by the store: the task editor,
  // the hook editor and a preset's page.
  const KEY = 'k-pages';
  await ev(`(() => {
    const store = window.__aigoStore;
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/Users/XPS/WorkBuddy/tudouni-aigo', { ericai: false, maxSteps: null });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
      workspaces: ['C:/Users/XPS/WorkBuddy/tudouni-aigo'],
      tasks: [{ id: 't1', name: 'a task with a name long enough to matter', description: 'and a description', prompt: 'do the thing', workspace: { kind: 'active' }, model: 'deepseek/deepseek-flash', enabled: true, autopilot: false, createdAtMs: 1, updatedAtMs: 1 }],
    }));
    window.__aigoKey = ${JSON.stringify(KEY)};
    return true;
  })()`);
  await sleep(400);

  const CASES = [
    { name: 'task editor', panel: 'tasks', click: '.tk-row-name' },
    { name: 'hook editor', panel: 'hooks', click: '.hk-fold' },
    { name: 'preset page', panel: 'subagentPresets', click: '.tk-row-name, .sp-row, [data-preset]' },
  ];

  let failures = 0;
  for (const kase of CASES) {
    await ev(`(() => { window.__aigoStore.getState().openPanel(${JSON.stringify(kase.panel)}); return true; })()`);
    await sleep(700);
    const hit = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(kase.click)});
      if (!el) return 'no target';
      el.click();
      return 'clicked';
    })()`);
    await sleep(700);
    if (hit !== 'clicked') {
      console.log(`\n${kase.name}: skipped (${hit})`);
      await ev(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
      await sleep(200);
      continue;
    }

    const raw = await ev(`(() => {
      const d = document.querySelector('.dialog');
      if (!d) return JSON.stringify({ missing: true });
      const body = d.querySelector('.dialog-body');
      const bs = body ? getComputedStyle(body) : null;
      const bb = body ? body.getBoundingClientRect() : null;
      const contentRight = body
        ? bb.x + Number.parseFloat(bs.borderLeftWidth) + Number.parseFloat(bs.paddingLeft) +
          body.clientWidth - Number.parseFloat(bs.paddingRight)
        : null;
      const past = [];
      if (body && contentRight !== null) {
        for (const el of body.querySelectorAll('*')) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          if (b.right > contentRight + 2) {
            past.push({ cls: String(el.className || el.tagName).slice(0, 48), over: Math.round(b.right - contentRight) });
          }
        }
      }
      // The design's two-column rows, and whether they are still two columns.
      const grid = d.querySelector('.wb-grid, .tk-name-row');
      const split = d.querySelector('.tk-editor, .sp-page, .wb-split');
      const fields = [...d.querySelectorAll('.wb-field, .cfg-field')].map((f) => {
        const b = f.getBoundingClientRect();
        return Math.round(b.width);
      });
      return JSON.stringify({
        title: d.querySelector('.dialog-title')?.textContent ?? '',
        dialogW: Math.round(d.getBoundingClientRect().width),
        bodyScrollsSideways: body ? body.scrollWidth > body.clientWidth + 2 : null,
        cols: split ? getComputedStyle(split).gridTemplateColumns : null,
        gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        fieldWidths: fields.slice(0, 8),
        minField: fields.length ? Math.min(...fields) : null,
        pastCount: past.length,
        past: past.slice(0, 5),
      });
    })()`);
    const m = JSON.parse(raw ?? '{}');
    console.log(`\n${kase.name}: "${m.title}" ${m.dialogW}px`);
    if (m.missing) {
      failures += 1;
      console.log('  FAIL no dialog');
    } else {
      console.log(`  columns ${m.cols}  grid ${m.gridCols}  min field ${m.minField}px`);
      if (m.bodyScrollsSideways) {
        failures += 1;
        console.log('  FAIL the body scrolls sideways');
      }
      if (m.pastCount > 0) {
        failures += 1;
        console.log(`  FAIL ${m.pastCount} element(s) past the body edge: ${JSON.stringify(m.past)}`);
      }
      // A field narrower than 180px cannot hold a label and a value on one line;
      // that is the width the design's two-up grid is drawn at.
      if (m.minField !== null && m.minField < 180) {
        failures += 1;
        console.log(`  FAIL a field is only ${m.minField}px wide`);
      }
      if (failures === 0) console.log('  ok');
    }

    await ev(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} finding(s)`}`);
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
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
