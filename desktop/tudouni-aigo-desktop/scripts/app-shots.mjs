/**
 * Shots of the **running desktop app**, not a browser fixture.
 *
 * `panel-shots.mjs` mounts the same components in a plain browser, which is the
 * only way to reach a panel with no runtime behind it. This one attaches to the
 * real window instead — WebView2 is launched with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334`, so the
 * live app is a CDP page like any other — and drives the real store, with the
 * real runtime's session and the real configuration files behind it.
 *
 * Usage: node scripts/app-shots.mjs [outDir] [port] [kinds...]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.tmp/shots/app';
const port = Number(process.argv[3] ?? 9334);
// Comma- or space-separated, like `panel-shots.mjs`: an argument list is easier
// to type one way and the two harnesses should not disagree about it.
const only = process.argv.slice(4).flatMap((a) => a.split(',')).filter(Boolean);

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
      problems.push(`eval threw: ${detail}`);
      return undefined;
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // A reload before shooting: the window is a long-lived WebView, so a run that
  // attached after an HMR edit would otherwise photograph a tree that is one
  // save behind what is on disk — and it also clears the console buffer, whose
  // replayed `[vite] Failed to reload` lines from an earlier broken save would
  // otherwise be reported as this run's problems.
  await send('Page.reload', { ignoreCache: true });
  await sleep(4000);
  // `Runtime.enable` replays the console messages buffered by the execution
  // context that existed when this script attached — which is the *old* page.
  // Anything logged before the reload is history; only what the reloaded tree
  // says from here on belongs to this run.
  problems.length = 0;

  const panels = [
    ['tasks', '02-tasks', '.tk-row-name'],
    ['config', '05-configuration', null],
    ['memory', '04-workspace-memory'],
    ['settings', '06-settings'],
    ['hooks', '08-hook-editor', '.hk-fold'],
    ['subagentPresets', '09-subagent-preset', null],
    ['learn', '12-learn-workspace'],
    ['codeintel', '13-code-intelligence'],
  ].filter(([kind]) => only.length === 0 || only.includes(kind));

  for (const [kind, name, click] of panels) {
    await evaluate(`(() => { window.__aigoStore.getState().openPanel(${JSON.stringify(kind)}); return true; })()`);
    await sleep(900);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.result?.data ?? shot.data, 'base64'));
    const box = await evaluate(`(() => {
      const d = document.querySelector('.dialog');
      if (!d) return 'no dialog';
      const b = d.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        title: d.querySelector('.dialog-title')?.textContent });
    })()`);
    console.log(`${kind} -> ${file}`, box);
    if (click) {
      const hit = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(click)});
        if (!el) return 'no target';
        el.click();
        return 'clicked';
      })()`);
      if (hit === 'clicked') {
        await sleep(700);
        const s2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const f2 = join(outDir, `${name}-detail.png`);
        writeFileSync(f2, Buffer.from(s2.result?.data ?? s2.data, 'base64'));
        console.log(`${kind} detail -> ${f2}`);
      }
    }
    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);
  }

  if (problems.length) console.log('problems:\n' + problems.slice(0, 20).join('\n'));
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
