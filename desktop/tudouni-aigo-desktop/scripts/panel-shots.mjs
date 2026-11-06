/**
 * Panel shot harness: open each workbench panel in a real browser and capture it.
 *
 * Usage: node scripts/panel-shots.mjs [outDir] [cdpPort] [url] [only]
 *
 * The panels read a zustand store, and in a plain browser there is no bridge, so
 * nothing is ever attached. Like `render-check.mjs`, this makes a session bucket
 * through the dev-only factory the app exposes and feeds it the payloads the Go
 * runtime sends, then opens one panel at a time.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.tmp/shots/panels';
const port = Number(process.argv[3] ?? 9333);
const url = process.argv[4] ?? 'http://127.0.0.1:5178/';
const only = process.argv[5] ?? '';
const width = Number(process.argv[6] ?? 1600);
const height = Number(process.argv[7] ?? 1000);
const scheme = process.argv[8] ?? 'light';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(outDir, { recursive: true });
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
      problems.push(`eval threw: ${detail}`);
      return undefined;
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
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  await send('Page.navigate', { url });
  await sleep(4000);

  // ---- seed a session, the way the runtime would ----
  const KEY = 'k-panels';
  // The dev-only handles are installed by `main.tsx` after the first render, so
  // a probe that runs on a fixed delay can beat them. Wait for them instead.
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate('typeof window.__aigoStore?.getState === "function"');
    if (ready === true) break;
    await sleep(250);
  }
  const seeded = await evaluate(`(() => {
    const store = window.__aigoStore;
    if (!store || typeof window.__aigoCreateBucket !== 'function') return 'no harness';
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/Users/XPS/WorkBuddy/tudouni-aigo', {
      ericai: false,
      maxSteps: null,
    });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
      workspaces: ['C:/Users/XPS/WorkBuddy/tudouni-aigo'],
    }));
    window.__aigoKey = ${JSON.stringify(KEY)};
    return 'ok';
  })()`);
  if (seeded !== 'ok') throw new Error(`seed failed: ${seeded}`);

  const apply = async (payload) => {
    await evaluate(
      `(() => { window.__aigoStore.getState().applyRuntimeMessage(window.__aigoKey, ${JSON.stringify(payload)}); return true; })()`,
    );
    await sleep(150);
  };

  await apply({
    v: 1,
    t: 'init',
    protocol: 18,
    session_id: '20261017-235800',
    resumed: false,
    model: 'deepseek-flash',
    provider: 'deepseek',
    thinking: true,
    effort: 'medium',
    effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    model_catalog: {
      models: [
        { provider: 'opencode-go', id: 'gpt-5', label: 'gpt-5', window: 200000, summary: '', note: '', vision: true, current: false, effort: 'high', effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { provider: 'opencode-go', id: 'gemini-3-pro', label: 'gemini-3-pro', window: 1000000, summary: '', note: '', vision: true, current: false, effort: '', effort_levels: [] },
        { provider: 'opencode-go', id: 'deepseek-v4', label: 'deepseek-v4', window: 128000, summary: '', note: '', vision: false, current: false, effort: 'medium', effort_levels: [] },
        { provider: 'deepseek', id: 'deepseek-flash', label: 'deepseek-flash', window: 128000, summary: '', note: '', vision: false, current: true, effort: 'medium', effort_levels: [] },
      ],
      aliases: [],
    },
    workspace: 'C:/Users/XPS/WorkBuddy/tudouni-aigo',
    max_steps: 150,
    stream: true,
    context_tokens: 128000,
    tools: [
      { name: 'shell', risk: 'high', parallel_safe: false, interactive: false },
      { name: 'read_file', risk: 'low', parallel_safe: true, interactive: false },
    ],
    permissions: {},
    audit_path: 'C:/Users/XPS/WorkBuddy/tudouni-aigo/.tudouni/audit/20261017-235800.jsonl',
    notices: [],
  });

  const panels = [
    ['tasks', '02-tasks', '.tk-row-name'],
    ['config', '05-configuration', '.pc-row-name, .pc-page, .cfg-row'],
    ['memory', '04-workspace-memory'],
    ['settings', '06-settings'],
    ['hooks', '08-hook-editor', '.hk-fold'],
    ['subagentPresets', '09-subagent-preset', '.pc-row-name, .sp-row'],
    ['learn', '12-learn-workspace'],
    ['codeintel', '13-code-intelligence'],
  ].filter(([kind]) => only === '' || only.split(',').includes(kind));

  // Per-panel fixtures, written as the store would hold them. The panels read
  // their facts from the store or from a config file on disk; in a browser the
  // file is unreachable, so anything the design sheet shows populated is seeded
  // here from the shape the runtime sends.
  const now = Date.now();
  const SEEDS = {
    tasks: `
      const mk = (o) => ({ description: '', prompt: 'Summarise the last week and update AGENTS.md.',
        workspace: { kind: 'active' }, model: '', enabled: true, autopilot: false,
        createdAtMs: ${now}, updatedAtMs: ${now}, ...o });
      window.__aigoStore.setState({ tasks: [
        mk({ id: 't-hi', name: 'hi', model: 'deepseek/deepseek-flash' }),
        mk({ id: 't-two', name: '', autopilot: true }),
        mk({ id: 't-three', name: '', autopilot: true, enabled: false }),
      ], taskRuns: [] });
    `,
    learn: `
      window.__aigoStore.setState({ savedSessions: { [window.__aigoKey]: { listed: true, items: Array.from({ length: 50 }, (_, i) => ({
        id: '2026100' + (i % 9) + '-1200' + (i % 60), preview: 'Session ' + i, archived: false,
        modifiedAt: Math.floor(${now} / 1000) - i * 3600, messages: 4, steps: 6, todos: '' })) } } });
    `,
  };

  for (const [kind, name, click] of panels) {
    const seed = SEEDS[kind];
    if (seed) {
      await evaluate(`(() => { const st = window.__aigoStore.getState(); ${seed}; return true; })()`);
      await sleep(200);
    }
    await evaluate(`(() => { window.__aigoStore.getState().openPanel(${JSON.stringify(kind)}); return true; })()`);
    await sleep(700);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.result?.data ?? shot.data, 'base64'));
    const box = await evaluate(`(() => {
      const d = document.querySelector('.dialog');
      if (!d) return 'no dialog';
      const b = d.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        title: d.querySelector('.dialog-title')?.textContent, foot: !!d.querySelector('.dialog-foot') });
    })()`);
    console.log(`${kind} -> ${file}`, box);

    // The second surface a row opens, when the design has one (the task editor,
    // a route's page, a hook's editor).
    if (click) {
      const hit = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(click)});
        if (!el) return 'no target';
        el.click();
        return 'clicked';
      })()`);
      if (hit === 'clicked') {
        await sleep(600);
        const s2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const f2 = join(outDir, `${name}-detail.png`);
        writeFileSync(f2, Buffer.from(s2.result?.data ?? s2.data, 'base64'));
        console.log(`${kind} detail -> ${f2}`);
      } else {
        console.log(`${kind} detail skipped: ${click}`);
      }
    }

    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(200);
  }

  if (problems.length) console.log('problems:\n' + problems.slice(0, 20).join('\n'));
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
