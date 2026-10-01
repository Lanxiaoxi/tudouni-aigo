/**
 * What one streamed delta costs, against the length of the conversation.
 *
 * This exists because the cost of a streamed chunk is the one number in this
 * interface that is allowed to grow with the session — and it grew once already:
 * `EntryView` was made `memo` for exactly that reason (see its docstring). A
 * `memo` boundary is not a promise that the *remaining* work is flat, so the
 * shape has to be measured rather than reasoned about, and measured the same way
 * twice, which is what a script is for.
 *
 * It drives the **real** store the tree renders, through the guarded handle
 * `main.tsx` exposes, and feeds it the payloads the Go runtime actually sends.
 * Nothing is stubbed: the reducer, the store, React and the DOM are the
 * application's own.
 *
 * ## It measures a production bundle, and that is not a detail
 *
 * Run against the dev server, this reports the wrong answer. A dev build runs
 * `StrictMode`'s deliberate double render and the JSX dev runtime's per-prop
 * validation, while the shipped application does neither — and both are large
 * enough to swamp the thing being measured. Measured on this machine, one delta
 * at 80 turns of history: **~19ms from the dev server, ~7ms from the production
 * bundle**, for identical data. So the numbers below are only comparable to
 * themselves when both runs come from the same mode, which is why the script
 * prints the mode it detected and refuses to run without the handle.
 *
 * ## The three figures, and why they are not one number
 *
 *   - **`reducer`** — `applyDelta` alone, on a frozen array. Pure, no store, no
 *     React. This is the scan-and-copy that runs on every chunk, and it is the
 *     part that *has* to be O(history) unless the reducer is made incremental.
 *   - **`sync`** — `flushSync(() => applyRuntimeMessage(...))`: the reducer, the
 *     store write, React's render and the DOM commit, all inside the timed
 *     window. This is the cost a person waits for per chunk.
 *   - **`frame`** — the same, but measured to the second `requestAnimationFrame`
 *     afterwards, so the browser's own layout and paint are included. It has a
 *     floor of one vsync interval (16.7ms at 60Hz) that no amount of JavaScript
 *     work can go below, so it is reported to show *how many* vsyncs a delta
 *     occupies, not as a substitute for `sync`.
 *
 * `sync` and `reducer` are medians, not means: the first chunk of a turn pays to
 * create a streaming row, and one garbage collection during a 200-sample run
 * would otherwise move a mean by more than the effect being looked for.
 *
 * ## Running it
 *
 *   # 1. a production bundle that kept the handles
 *   VITE_PERF_HARNESS=true npx vite build --outDir .perf-build --base ./
 *   npx vite preview --outDir .perf-build --port 5179 --strictPort
 *
 *   # 2. a browser with a debugging port
 *   chrome --headless=new --remote-debugging-port=9333 about:blank
 *
 *   # 3. measure
 *   node scripts/stream-perf.mjs http://127.0.0.1:5179/ 9333 40,80,160
 *
 * The dev server works too (`npm run dev`, port 5178) and is the right target
 * for checking that a change did not break the interface — but its absolute
 * numbers are not the application's.
 */

const url = process.argv[2] ?? 'http://127.0.0.1:5179/';
const port = Number(process.argv[3] ?? 9333);
const turnsList = (process.argv[4] ?? '40,80,160').split(',').map((n) => Number(n.trim()));

/** Timed deltas per configuration. The median is reported, so a couple of
 *  hundred is a stable figure and keeps the whole run to seconds. */
const SAMPLES = 200;
/** Deltas dropped before timing starts, so the one-off cost of creating a fresh
 *  streaming row is not charged to every chunk after it. */
const WARMUP = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The payloads, and they are the ones that matter to the measurement.
 *
 * The answer is Chinese prose around a fenced code block, because a finished
 * `answer` row is rendered by `react-markdown`: its cost is the cost of parsing
 * markdown, and an answer of plain short lines would measure something the
 * application does not have to do. The size is what a real answer tends to be —
 * big enough that the parse is real, small enough to be plausible.
 */
const ANSWER = [
  '这一段的结论是先把读取路径收窄，再决定要不要动缓存。原因有两个：',
  '',
  '1. 读路径上的那次 `resolve()` 对每个路径都会走一次系统调用；',
  '2. 缓存一旦按错误的键建立，线上表现是"偶发地读到旧内容"，比慢更难查。',
  '',
  '所以先改读路径：',
  '',
  '```go',
  'func (w *Workspace) resolve(p string) (string, error) {',
  '\tif filepath.IsAbs(p) {',
  '\t\treturn filepath.Clean(p), nil',
  '\t}',
  '\treturn filepath.Join(w.root, filepath.Clean(p)), nil',
  '}',
  '```',
  '',
  '改完之后再量一次，如果还是慢，问题就不在这里。',
].join('\n');

/** The user side of a turn: short, as they are. */
const QUESTION = '这一段的结论是什么？先把理由说清楚。';

/** One streamed chunk, at the size the runtime actually forwards. */
const CHUNK = '读路径先收窄，再决定要不要动缓存';

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
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      const detail =
        r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      throw new Error(`eval threw: ${detail}`);
    }
    if (r.result?.result?.value === undefined) {
      throw new Error(`eval returned nothing: ${JSON.stringify(r).slice(0, 300)}`);
    }
    return r.result.result.value;
  };

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

  const rows = [];

  for (const turns of turnsList) {
    // A reload per configuration: the transcript must start empty, or the
    // second measurement is taken on top of the first one's history.
    await send('Page.navigate', { url });
    await sleep(2500);

    const ready = await evaluate(`(async () => {
      for (let i = 0; i < 80 && !window.__aigoStore; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        store: typeof window.__aigoStore?.getState === 'function',
        bucket: typeof window.__aigoCreateBucket === 'function',
        flush: typeof window.__aigoFlushSync === 'function',
      };
    })()`);
    if (!ready.store || !ready.bucket) {
      throw new Error(
        'the app did not expose its store — is this a dev server or a ' +
          'VITE_PERF_HARNESS build? (see the header of this file)',
      );
    }
    if (!ready.flush) {
      throw new Error(
        'no `__aigoFlushSync`: the bundle predates this harness hook. Without a ' +
          'synchronous flush, React batches the store notification into a later ' +
          'task and the measurement reports the reducer as the whole cost.',
      );
    }

    const measured = await evaluate(`(async () => {
      const flushSync = window.__aigoFlushSync;
      const applyDelta = window.__aigoApplyDelta;
      const store = window.__aigoStore;
      const KEY = 'k-perf';
      const bucket = window.__aigoCreateBucket(KEY, 'C:/work/project', {
        ericai: false, maxSteps: null,
      });
      store.setState((s) => ({
        sessions: { ...s.sessions, [KEY]: bucket },
        order: s.order.includes(KEY) ? s.order : [...s.order, KEY],
        activeKey: KEY,
      }));
      const apply = (m) => store.getState().applyRuntimeMessage(KEY, m);

      apply({
        v: 1, t: 'init', protocol: 3, session_id: 's-perf', resumed: false,
        model: 'deepseek-chat', provider: 'deepseek', thinking: true, effort: 'high',
        effort_levels: ['low', 'high'], model_catalog: { models: [], aliases: [] },
        workspace: 'C:/work/project', max_steps: 120, stream: true,
        context_tokens: 65536, tools: [], permissions: {}, audit_path: '', notices: [],
      });

      // ${turns} turns of history, shaped the way \`session_load\` delivers it:
      // the store rebuilds the transcript from the stored messages, which is
      // exactly how a resumed session comes to have a long one.
      const messages = [];
      for (let i = 0; i < ${turns}; i += 1) {
        messages.push({ role: 'user', content: ${JSON.stringify(QUESTION)} });
        messages.push({ role: 'assistant', content: ${JSON.stringify(ANSWER)} });
      }
      apply({ v: 1, t: 'session_load', session_id: 's-perf', messages, resumed: false,
              created_at: '', modified_at: '' });
      // A turn in flight, so a delta belongs to something.
      apply({ v: 1, t: 'event', kind: 'run_started', session_id: 's-perf',
              run_id: 'r-perf', step: 0, ts: '' });

      const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await settle();

      const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
      const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };

      // --- reducer alone, on a frozen array, with no store and no React
      let reducerSamples = [];
      {
        const frozen = store.getState().sessions[KEY].entries;
        const t = [];
        for (let i = 0; i < ${SAMPLES}; i += 1) {
          const a = performance.now();
          applyDelta(frozen, 'r-perf', 99, 'text', ${JSON.stringify(CHUNK)}, 'r-perf', null);
          t.push(performance.now() - a);
        }
        reducerSamples = t.slice(${WARMUP});
      }

      // --- the whole thing a person waits for, per chunk
      const sync = [];
      const frame = [];
      for (let i = 0; i < ${SAMPLES} + ${WARMUP}; i += 1) {
        const msg = { v: 1, t: 'delta', session_id: 's-perf', run_id: 'r-perf',
                      step: 1, channel: 'text', text: ${JSON.stringify(CHUNK)}, reset: false };
        const t0 = performance.now();
        flushSync(() => apply(msg));
        const t1 = performance.now();
        await settle();
        const t2 = performance.now();
        if (i >= ${WARMUP}) { sync.push(t1 - t0); frame.push(t2 - t0); }
      }

      const st = store.getState().sessions[KEY];
      return JSON.stringify({
        entries: st.entries.length,
        domRows: document.querySelectorAll('.stream-inner > *').length,
        reducer: { med: median(reducerSamples), p90: p90(reducerSamples), n: reducerSamples.length },
        sync: { med: median(sync), p90: p90(sync) },
        frame: { med: median(frame), p90: p90(frame) },
      });
    })()`);

    const m = JSON.parse(measured);
    rows.push({ turns, ...m });
    console.log(
      `${String(turns).padStart(4)} turns  ${String(m.entries).padStart(4)} entries  ` +
        `${String(m.domRows).padStart(4)} rows   ` +
        `reducer ${m.reducer.med.toFixed(2)}ms   ` +
        `sync ${m.sync.med.toFixed(2)}ms (p90 ${m.sync.p90.toFixed(2)})   ` +
        `frame ${m.frame.med.toFixed(1)}ms`,
    );
  }

  console.log('');
  const first = rows[0];
  const last = rows[rows.length - 1];
  const growth = (a, b) => (a > 0 ? (b / a).toFixed(2) : 'n/a');
  console.log(
    `growth ${first.turns} -> ${last.turns} turns:  ` +
      `reducer ${growth(first.reducer.med, last.reducer.med)}x   ` +
      `sync ${growth(first.sync.med, last.sync.med)}x   ` +
      `frame ${growth(first.frame.med, last.frame.med)}x`,
  );
  // The figure to watch: a flat reducer and a flat sync mean the front end does
  // not get slower as the conversation grows. Anything above ~1.5x across a
  // doubling of history is a regression back towards the shape `EntryView`'s
  // `memo` was added to fix.
  console.log(
    `\n${JSON.stringify(rows.map((r) => ({
      turns: r.turns,
      reducerMs: +r.reducer.med.toFixed(3),
      syncMs: +r.sync.med.toFixed(2),
      frameMs: +r.frame.med.toFixed(1),
    })))}`,
  );

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e.message ?? e);
  process.exit(1);
});
