/**
 * Shots of the **Configuration** family's second surfaces.
 *
 * `app-shots.mjs` opens each panel and captures its first screen. The route
 * page, the MCP server page and the web-search tab are one click deeper than
 * that, and the design gives each of them its own sheet — so this script drives
 * the live window the way a person would (open the panel, click a tab, click a
 * row, hover a row) and captures what comes back.
 *
 * It also exercises the three interactions the restructure moved: the transport
 * radio (which still clears the other field), the footer's two-press delete, and
 * Discard. None of them saves, so nothing here can reach the real config file —
 * closing the panel discards the draft, and the mutations it makes (adding a
 * preset, deleting the draft's routes) live only in that draft.
 *
 * Usage: node scripts/cfg-surfaces.mjs [outDir] [port]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.tmp/shots/cfg';
const port = Number(process.argv[3] ?? 9334);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(outDir, { recursive: true });
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target; is the app running with the debug port?');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const problems = [];
  const checks = [];
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
      problems.push(`console.error: ${(msg.params?.args ?? []).map((a) => a.value ?? a.description).join(' ')}`);
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
      problems.push(`eval threw: ${detail}`);
      return undefined;
    }
    return r.result?.result?.value;
  };

  const shot = async (name) => {
    // A sibling panel with a syntax error puts Vite's error overlay over the
    // whole window (this is a shared checkout). It is not this panel's problem,
    // so it is dismissed before the shot rather than baked into it.
    await evaluate(`(() => {
      document.querySelectorAll('vite-error-overlay').forEach((el) => el.remove());
      return true;
    })()`);
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(png.result?.data ?? png.data, 'base64'));
    console.log(`-> ${file}`);
    return file;
  };

  /** Click the first element matching `sel` (a row's own buttons included). */
  const click = async (sel, index = 0) => {
    const hit = await evaluate(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if (!el) return 'no target';
      el.click();
      return 'ok';
    })()`);
    if (hit !== 'ok') problems.push(`click ${sel}[${index}]: ${hit}`);
    await sleep(450);
    return hit === 'ok';
  };

  /** A real pointer move, so `:hover` and React's `onMouseEnter` both fire. */
  const hover = async (sel, index = 0) => {
    const box = await evaluate(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + Math.min(b.height / 2, 14)) };
    })()`);
    if (box === null) {
      problems.push(`hover ${sel}[${index}]: no target`);
      return false;
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await sleep(300);
    return true;
  };

  /** Park the pointer away from the panel, so a shot is taken at rest. The
   *  pointer outlives a run, and a row left hovered paints its `Edit`. */
  const mouseOff = async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none' });
    await sleep(200);
  };

  const text = async (sel, index = 0) =>
    evaluate(
      `(() => document.querySelectorAll(${JSON.stringify(sel)})[${index}]?.textContent?.trim() ?? null)()`,
    );

  const has = async (sel) => evaluate(`(() => document.querySelector(${JSON.stringify(sel)}) !== null)()`);

  const check = (what, ok, detail) => {
    checks.push(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail === undefined ? '' : ` (${detail})`}`);
  };

  /** The panel's own geometry — the numbers that have to match the sheet. */
  const report = async (label) => {
    const box = await evaluate(`(() => {
      const d = document.querySelector('.dialog');
      if (!d) return 'no dialog';
      const b = d.getBoundingClientRect();
      const body = d.querySelector('.dialog-body');
      return JSON.stringify({ w: Math.round(b.width), h: Math.round(b.height),
        scroll: body ? Math.round(body.scrollHeight) : null,
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
        title: d.querySelector('.dialog-title')?.textContent });
    })()`);
    console.log(`${label}: ${box}`);
  };

  const openPanel = async (kind) => {
    await evaluate(`(() => { window.__aigoStore.getState().openPanel(${JSON.stringify(kind)}); return true; })()`);
    await sleep(900);
  };
  const closePanel = async () => {
    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(300);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(400);

  // ---- the routes list ----
  await openPanel('config');
  await mouseOff();
  await shot('05-configuration');
  await report('05');
  check('the routes list has a rail', await has('.wb-rail .pc-preview'));
  check('the path bar sits in the main column', await has('.wb-main .cfg-path-row'));
  await hover('.tk-row', 1);
  const hoveredName = await text('.wb-rail .pc-preview-name');
  check('the rail follows the hovered row', hoveredName !== null && hoveredName !== 'opencode-go', hoveredName);
  await shot('05-configuration-hover');
  await mouseOff();
  await hover('.tk-row', 0);
  await mouseOff();

  // ---- one route's page ----
  await click('.tk-row-name');
  await report('07');
  await shot('07-route-detail');
  check('the route page keeps its save verbs in the footer', (await has('.dialog-foot .btn-primary')) === true);
  check('the destructive verb is in the footer', (await has('.dialog-foot .cfg-foot-delete')) === true);
  check('the rail no longer offers the delete', (await has('.wb-rail .pc-delete')) === false);
  const scrolled = await evaluate(`(() => {
    const b = document.querySelector('.dialog-body');
    if (!b) return 'no body';
    b.scrollTop = b.scrollHeight;
    return b.scrollTop > 0 ? 'ok' : 'no scroll';
  })()`);
  await sleep(400);
  console.log(`route page scroll: ${scrolled}`);
  await shot('07-route-detail-models');
  await evaluate(`(() => { const b = document.querySelector('.dialog-body'); if (b) b.scrollTop = 0; return true; })()`);
  await click('.wb-back');

  // ---- web search ----
  await click('.tk-filters .tk-chip', 1);
  await report('11');
  await shot('11-web-search');
  check('web search has a rail of its own', await has('.wb-rail .pc-readout'));

  // ---- the MCP servers list, then one server ----
  await click('.tk-filters .tk-chip', 2);
  await report('10-list');
  await shot('10-mcp-list');
  await click('.tk-row-name');
  await report('10');
  await shot('10-mcp-detail');

  // The transport radio still clears the other field: switching a URL server to
  // `Command` must drop the URL and show the command fields.
  await click('.tk-choice-row', 0);
  check('choosing Command clears the URL', (await has('.pc-page input[placeholder="npx"]')) === true);
  check(
    '...and the URL field is gone',
    (await has('.pc-page input[placeholder="https://mcp.example.com/mcp"]')) === false,
  );
  await click('.tk-choice-row', 1);
  // **Not a regression, a pre-existing consequence.** Choosing `Command` clears
  // the URL (the runtime refuses a server that names both), and the fields are
  // rendered from whether a URL is present — so switching back has no URL to
  // restore and the page stays on `Command`. The panel behaved this way before
  // the restructure; this asserts it stayed that way rather than pretending.
  check(
    'switching a URL server to Command is one-way, as before',
    (await has('.pc-page input[placeholder="https://mcp.example.com/mcp"]')) === false,
  );

  // The two-press delete: the first press only arms, and the label says so.
  await click('.cfg-foot-delete');
  const armed = await text('.cfg-foot-delete');
  check('the footer delete arms on the first press', /confirm|again/i.test(armed ?? ''), armed);

  await evaluate(`(() => {
    const b = document.querySelector('.dialog-body');
    if (b) b.scrollTop = b.scrollHeight;
    return true;
  })()`);
  await sleep(300);
  await shot('10-mcp-detail-advanced');
  await click('.wb-back');

  // ---- an empty routes tab (the one surface with no rail) ----
  await click('.tk-filters .tk-chip', 0);
  await closePanel();

  /** Delete every draft route from its page, stopping if the panel goes away —
   *  a Vite full reload (another panel being edited in the same checkout)
   *  remounts the window and takes the open panel with it. */
  const emptyRoutes = async () => {
    for (let i = 0; i < 12; i += 1) {
      if ((await has('.dialog')) !== true) return false;
      if ((await has('.tk-row-name')) !== true) return true;
      await click('.tk-row-name');
      await click('.cfg-foot-delete');
      await click('.cfg-foot-delete');
    }
    return false;
  };

  let emptied = false;
  for (let attempt = 0; attempt < 3 && !emptied; attempt += 1) {
    await openPanel('config');
    emptied = await emptyRoutes();
    if (!emptied) {
      console.log(`attempt ${attempt + 1}: the panel went away mid-run (a reload?), retrying`);
      await closePanel();
    }
  }
  check('every draft route can be removed from its page', emptied === true);
  if (emptied) {
    await mouseOff();
    await shot('05-configuration-empty');
    check('the empty list draws the blank state', await has('.tk-blank'));
    check('the empty list has no rail', (await has('.wb-rail')) === false);
  }
  await closePanel();

  // ---- subagent presets: list, a new preset's page, discard ----
  await openPanel('subagentPresets');
  await mouseOff();
  await shot('09-subagent-presets');
  await report('09-list');
  if (await click('.dialog-head .btn-primary')) {
    await report('09');
    await mouseOff();
    await shot('09-subagent-preset');
    check('the preset page carries the document default', await has('.sp-page .rs-select'));
    await click('.wb-back');
    check('the list shows the preset just added', (await text('.tk-row-name')) !== null);
    await mouseOff();
    await shot('09-subagent-presets-added');
    // Discard rewinds the draft, so the added preset goes away again.
    await click('.dialog-foot .btn-ghost');
    const back = await evaluate(`(() => document.querySelectorAll('.tk-row-name').length)()`);
    check('Discard rewinds the draft', back === 0, `${back} rows`);
  }
  await closePanel();

  console.log(checks.join('\n'));
  if (problems.length) console.log('problems:\n' + problems.slice(0, 20).join('\n'));
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
