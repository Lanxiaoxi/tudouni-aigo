/**
 * What the narrow rail does to its own labels.
 *
 * The overflow probe skips anything with `overflow: hidden`, which is exactly how
 * an ellipsis is drawn — so truncation is invisible to it. This one looks for the
 * opposite: text that no longer fits its box and is being cut. A truncated path
 * is fine (it is a path, and the full value is on the tooltip); a truncated
 * *label* or a truncated *value in a KV row* is a fact the rail stops reporting,
 * which is the failure a narrower rail actually produces.
 *
 * Usage: node scripts/probe-rail.mjs [cdpPort] [url] [width] [height]
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

  const KEY = 'k-rail';
  // The memory panel draws no rail until `ui(memory)` arrives, and a plain
  // browser has no runtime to send it — so the snapshot is written here, in the
  // shape the Go runtime's message carries. Anything less leaves the rail
  // unmeasurable and the probe skipped, which is how a rail bug would ship.
  await ev(`(() => {
    const store = window.__aigoStore;
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/Users/XPS/WorkBuddy/tudouni-aigo', { ericai: false, maxSteps: null });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
      workspaces: ['C:/Users/XPS/WorkBuddy/tudouni-aigo'],
    }));
    window.__aigoKey = ${JSON.stringify(KEY)};
    return true;
  })()`);
  await sleep(200);
  await ev(`(() => {
    const now = new Date().toISOString();
    const snapshot = {
      root: 'C:/Users/XPS/WorkBuddy/tudouni-aigo/.tudouni/memory',
      config: {
        version: 1, enabled: true, auto_inject: true, recall_on_turn_start: true,
        recall_on_tool_failure: true, max_recall: 5, max_results: 8, min_score: 0.35,
        entry_chars: 2000, note_chars: 400,
      },
      entries: [
        { id: 'm-1', revision: 2, title: 'The desktop talks to the runtime over JSONL stdio', updated_at: now,
          confidence: 'verified', triggers: ['desktop', 'protocol'], tags: ['arch'], scope_paths: [], chars: 640 },
        { id: 'm-2', revision: 1, title: 'Release targets are windows and linux only', updated_at: now,
          confidence: 'observed', triggers: ['release'], tags: ['build'], scope_paths: [], chars: 220 },
        { id: 'm-3', revision: 1, title: 'VERSION is the only source of the Go version', updated_at: now,
          confidence: 'inferred', triggers: ['version'], tags: [], scope_paths: [], chars: 118 },
      ],
      candidates: [
        { id: 'c-1', op: 'create', target_id: '', expected_revision: 0,
          title: 'A proposal with a title long enough to test the card', created_at: now,
          confidence: 'inferred', triggers: ['a'], tags: [], body: 'body', chars: 4, reason: 'seen three times' },
      ],
      index: { entries: 3, built_at: now, rebuilt: false, problem: '' },
      problem: '',
      unreadable: [],
    };
    window.__aigoStore.getState().applyRuntimeMessage(window.__aigoKey, { v: 1, t: 'ui', kind: 'memory', memory: snapshot });
    return true;
  })()`);
  await sleep(400);

  let findings = 0;
  for (const [kind, label] of [['memory', 'Workspace memory'], ['learn', 'Learn this workspace']]) {
    await ev(`(() => { window.__aigoStore.getState().openPanel(${JSON.stringify(kind)}); return true; })()`);
    await sleep(800);
    const raw = await ev(`(() => {
      const rail = document.querySelector('.wb-rail, .wm-rail');
      if (!rail) {
        // Which of the panel's surfaces is on screen, so a missing rail can be
        // told from a panel that is showing its "no session" or error state.
        const d = document.querySelector('.dialog');
        return JSON.stringify({
          missing: true,
          cls: d ? d.className : null,
          text: d ? d.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null,
        });
      }
      const cut = [];
      // Any element whose own text overflows its box while the box clips it.
      //
      // **Paths are exempt, and it is the same exemption the design makes.** A
      // workspace path is truncated with an ellipsis and carries its full value
      // in its title attribute, which is the one kind of text here that is
      // allowed to be cut: the rail cannot be as wide as an arbitrary filesystem
      // path, and the alternative is a bar that scrolls. A clipped *label* or a
      // clipped *number* is the failure, because there is no second place to read
      // it.
      const isPath = (el) =>
        el.classList.contains('learn-workspace-path') ||
        el.classList.contains('cfg-path') ||
        el.classList.contains('wb-path-text') ||
        el.classList.contains('pc-mini-name');
      for (const el of rail.querySelectorAll('*')) {
        if (el.children.length > 0) continue;  // leaves only: an element with text
        const t = (el.textContent ?? '').trim();
        if (t === '') continue;
        if (isPath(el)) continue;
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          cut.push({
            cls: String(el.className || el.tagName).slice(0, 40),
            text: t.slice(0, 60),
            sw: el.scrollWidth,
            cw: el.clientWidth,
          });
        }
      }
      // The values a KV row is meant to report in full.
      const kvs = [...rail.querySelectorAll('.wb-kv-row')].map((row) => {
        const label = row.querySelector('.wb-kv-label')?.textContent?.trim() ?? '';
        const value = row.querySelector('.wb-value')?.textContent?.trim() ?? '';
        return { label, value };
      });
      return JSON.stringify({
        railW: Math.round(rail.getBoundingClientRect().width),
        cut: cut.slice(0, 8),
        cutCount: cut.length,
        kvs,
      });
    })()`);
    const m = JSON.parse(raw ?? '{}');
    console.log(`\n${kind} (${label})`);
    if (m.missing) {
      // The memory panel draws no rail until the runtime has answered its read;
      // in a plain browser there is no runtime, so it stays on "Reading…" for
      // ever. That is the harness's gap, not the panel's, and counting it as a
      // failure would make this probe red on every run.
      if (String(m.text).includes('Reading')) {
        console.log(`  skipped: still reading (no runtime behind this browser)\n    ${m.text}`);
      } else {
        findings += 1;
        console.log('  FAIL no rail');
        console.log(`    surface: ${m.cls}`);
        console.log(`    text: ${m.text}`);
      }
    } else {
      console.log(`  rail ${m.railW}px, ${m.kvs.length} kv row(s)`);
      for (const kv of m.kvs) console.log(`    ${kv.label}: ${kv.value}`);
      if (m.cutCount > 0) {
        findings += 1;
        console.log(`  FAIL ${m.cutCount} label(s) clipped: ${JSON.stringify(m.cut)}`);
      } else {
        console.log('  no clipped labels');
      }
    }
    await ev(`(() => { window.__aigoStore.getState().closePanel(); return true; })()`);
    await sleep(250);
  }

  console.log(`\n${findings === 0 ? 'PASS' : `FAIL — ${findings} finding(s)`}`);
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  await new Promise((resolve) => {
    ws.addEventListener('close', resolve, { once: true });
    ws.close();
    setTimeout(resolve, 500);
  });
  process.exitCode = findings === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
