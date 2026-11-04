/**
 * Fixture shots for the two panels whose data the browser harness does not seed.
 *
 * `panel-shots.mjs` opens every workbench panel with a bare session; Hooks and
 * Code intelligence then draw their loading / empty states because their
 * snapshots only arrive from the runtime. This script feeds the same store the
 * two `ui(...)` messages a runtime would send, so the screenshots show the
 * editor and the index instead of two blank panels.
 *
 * Usage: node scripts/panel-fixtures.mjs [outDir] [cdpPort] [url] [kinds] [w] [h]
 *
 * Hooks is captured twice: the list, then the first hook's editor (the
 * `.hk-fold` press the panel-shots harness knows about). Code intelligence is
 * captured in the first-run shape the sheet draws, then again with an index and
 * a locked selection.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.tmp/shots/fixtures';
const port = Number(process.argv[3] ?? 9333);
const url = process.argv[4] ?? 'http://127.0.0.1:5178/';
const only = process.argv[5] ?? '';
const width = Number(process.argv[6] ?? 1280);
const height = Number(process.argv[7] ?? 900);

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

  const shot = async (name) => {
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(png.result?.data ?? png.data, 'base64'));
    console.log(`${name} -> ${file}`);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url });
  await sleep(4000);

  const KEY = 'k-fixtures';
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
    await sleep(200);
  };

  await apply({
    v: 1,
    t: 'init',
    protocol: 18,
    session_id: '20261104-213000',
    resumed: false,
    model: 'deepseek-flash',
    provider: 'deepseek',
    thinking: true,
    effort: 'medium',
    effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    model_catalog: { models: [], aliases: [] },
    workspace: 'C:/Users/XPS/WorkBuddy/tudouni-aigo',
    max_steps: 150,
    stream: true,
    context_tokens: 128000,
    tools: [],
    permissions: {},
    audit_path: 'C:/Users/XPS/WorkBuddy/tudouni-aigo/.tudouni/audit/20261104-213000.jsonl',
    notices: [],
  });

  const now = Date.now();
  const minutesAgo = (m) => new Date(now - m * 60_000).toISOString();

  const hookEntry = (o) => ({
    event: 'pre_tool_use',
    name: 'hook-1',
    matcher: '',
    command: '',
    shell: false,
    timeout_ms: null,
    max_output_bytes: null,
    fail_closed: null,
    enabled: true,
    status_message: '',
    state: 'active',
    activity: null,
    timeout_effective: null,
    fail_closed_effective: null,
    executable_found: null,
    ...o,
  });

  const hooks = {
    path: 'C:/Users/XPS/.tudouni/hooks.json',
    scripts_dir: 'C:/Users/XPS/.tudouni/scripts',
    disabled: false,
    file: { exists: true, revision: 'rev-fixture-1', problem: '' },
    defaults: { timeout_ms: null, max_output_bytes: null },
    entries: [
      hookEntry({
        command: 'npm run lint -- --fix',
        activity: {
          runs: 3,
          failures: 0,
          last: {
            class: 'success',
            status: 'ok',
            at: minutesAgo(12),
            duration_ms: 412,
            exit_code: 0,
            reason: '',
            tool: 'shell',
          },
        },
      }),
      // The second hook carries the document's one blocking problem, so the
      // editor of the first still shows the alert band and the footer count the
      // sheet draws.
      hookEntry({
        event: 'stop',
        name: 'notify',
        command: '',
        state: 'pending',
        activity: null,
      }),
    ],
    events: [
      {
        name: 'pre_tool_use',
        gate: true,
        tool_event: true,
        can_decide: true,
        default_timeout_ms: 3000,
        workspace_allowed: false,
      },
      {
        name: 'stop',
        gate: false,
        tool_event: false,
        can_decide: true,
        default_timeout_ms: 30000,
        workspace_allowed: true,
      },
    ],
    scripts: [],
    workspace: {
      path: 'C:/Users/XPS/WorkBuddy/tudouni-aigo',
      exists: true,
      trusted: true,
      problem: '',
      entries: [],
      trust_command: 'tudouni hooks trust',
    },
    limits: {
      max_timeout_ms: 60000,
      max_per_event: 20,
      max_output_bytes: 65536,
      default_output: 16384,
      gate_timeout_ms: 30000,
      default_timeout: 3000,
      stderr_reason_cap: 4096,
    },
  };

  const codeintelFirstRun = {
    workspace: 'C:/Users/XPS/WorkBuddy/tudouni-aigo',
    enabled: false,
    indexed: false,
    path: '.tudouni/index/graph.db',
    size_bytes: 0,
    files: 0,
    nodes: 0,
    edges: 0,
    unresolved: 0,
    pending: 0,
    ambiguous_edges: 0,
    deferred: 0,
    heuristic: 0,
    deferred_by_language: {},
    heuristic_by_language: {},
    stale: { added: 0, changed: 0, removed: 0, checked: 0, count: 0 },
    parser: true,
    building: false,
    problem: '',
    candidates: ['', 'dsh-smooth-stream'],
  };

  const codeintelIndexed = {
    ...codeintelFirstRun,
    enabled: true,
    indexed: true,
    size_bytes: 18_420_736,
    files: 4218,
    nodes: 61_204,
    edges: 148_902,
    unresolved: 3120,
    stale: { added: 2, changed: 4, removed: 1, checked: 4218, count: 7 },
    indexed_at: minutesAgo(32),
    repos: [''],
    candidates: undefined,
    last: {
      full: true,
      ok: true,
      files: 4218,
      nodes: 61_204,
      edges: 148_902,
      unresolved: 3120,
      problem: '',
      at: minutesAgo(32),
    },
  };

  const wanted = (kind) => only === '' || only.split(',').includes(kind);

  if (wanted('hooks')) {
    await apply({ v: 1, t: 'ui', kind: 'hooks', hooks });
    await evaluate(`(() => { window.__aigoStore.getState().openPanel('hooks'); return true; })()`);
    await sleep(700);
    await shot('08-hook-editor');
    const clicked = await evaluate(`(() => {
      const el = document.querySelector('.hk-fold');
      if (!el) return 'no target';
      el.click();
      return 'clicked';
    })()`);
    if (clicked === 'clicked') {
      await sleep(600);
      await shot('08-hook-editor-detail');

      // Back, then Add hook: the new row must open its editor, because the list
      // no longer has an inline form to expand.
      await evaluate(`(() => { document.querySelector('.wb-back')?.click(); return true; })()`);
      await sleep(300);
      const added = await evaluate(`(() => {
        const el = [...document.querySelectorAll('.dialog-head .btn')].find((b) => /Add hook/i.test(b.textContent ?? ''));
        if (!el) return 'no add button';
        el.click();
        return 'clicked';
      })()`);
      if (added === 'clicked') {
        await sleep(500);
        await shot('08-hook-editor-new');
      } else {
        console.log(`hooks add skipped: ${added}`);
      }
    } else {
      console.log(`hooks editor skipped: ${clicked}`);
    }
    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);

    // The empty list: the state a fresh install shows.
    await apply({ v: 1, t: 'ui', kind: 'hooks', hooks: { ...hooks, entries: [] } });
    await evaluate(`(() => { window.__aigoStore.getState().openPanel('hooks'); return true; })()`);
    await sleep(700);
    await shot('08-hook-editor-empty');
    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);
  }

  if (wanted('codeintel')) {
    await apply({ v: 1, t: 'ui', kind: 'codeintel', codeintel: codeintelFirstRun });
    await evaluate(`(() => { window.__aigoStore.getState().openPanel('codeintel'); return true; })()`);
    await sleep(700);
    await shot('13-code-intelligence');
    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);

    await apply({ v: 1, t: 'ui', kind: 'codeintel', codeintel: codeintelIndexed });
    await evaluate(`(() => { window.__aigoStore.getState().openPanel('codeintel'); return true; })()`);
    await sleep(700);
    await shot('13-code-intelligence-indexed');
    await evaluate(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);
  }

  if (problems.length) console.log('problems:\n' + problems.slice(0, 20).join('\n'));
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
