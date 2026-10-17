/**
 * Turn-fold check: fold a turn in a real browser and look at what is left.
 *
 * The pure half is `tests/turn-fold.test.ts` (which rows a turn owns, how its body
 * is cut into work and reply, and what phase it is in). What that suite cannot see
 * is the half that makes the feature exist at all: whether the fold is actually
 * **applied**, whether the answer is still on screen when it is, and whether the
 * prompt that opened the turn survives it. Each of those fails silently — a fold
 * with a class that never lands looks exactly like an unfolded turn, and an answer
 * that is folded away looks like a turn that said nothing.
 *
 * Three defects this caught, in the order they were written:
 *
 *   - **the next turn's prompt was folded into the previous turn.** An echo is
 *     appended when the person presses Enter, and the head it opens only lands
 *     when the runtime answers `run_started` — so the question sat under the
 *     previous turn for that window, and folding that turn hid it. The check now
 *     reads the bubble's `innerText` while the turn above it is folded.
 *   - **find inside a folded turn counted hits the fold was hiding, and jumped to
 *     a clipped row.** `.collapse` keeps its layout boxes, so a match in a shut
 *     body reports an ordinary rect and nothing opens. `find/engine.ts` now walks
 *     the shut folds outwards; this check types a needle from the *thinking* into
 *     the real find bar and expects the turn to open.
 *   - **folding the turn took the answer with it.** The first shape collapsed a
 *     whole turn into its head line, which is not a chat: the middle is what a
 *     reader wants out of the way, not the reply. The body is now cut into work
 *     and reply (`streamBlocks.ts`), and the reply is drawn outside the fold —
 *     which is the assertion under "folded: the work goes away, the answer stays".
 *
 * Usage (the same three steps every `*-check.mjs` in this directory needs):
 *
 *   npm run dev
 *   chrome --headless=new --remote-debugging-port=9333 about:blank
 *   node scripts/turn-fold-check.mjs [url] [cdpPort]
 */

import assert from 'node:assert/strict';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
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
      problems.push(`exception: ${msg.params?.exceptionDetails?.exception?.description}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      problems.push(
        `console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`,
      );
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
      throw new Error(`eval threw: ${r.result.exceptionDetails.exception?.description}`);
    }
    return r.result?.result?.value;
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
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await send('Page.navigate', { url });

  // Wait for the navigation to **replace** the about:blank document before
  // evaluating anything. A probe that starts in the old document has its context
  // discarded under it mid-await, and the reply then carries no value at all —
  // which reads here as "the app never exposed its store", the most misleading
  // sentence this file can print.
  await sleep(2500);

  const ready = await evaluate(`(async () => {
    for (let i = 0; i < 60; i += 1) {
      if (window.__aigoStore && window.__aigoCreateBucket) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return \`\${location.href} root=\${document.getElementById('root')?.childElementCount ?? -1}\`;
  })()`);
  if (ready !== true) throw new Error(`the app did not expose its store (is this a dev build?) — page: ${ready}`);

  // ---- the session this check drives ----
  //
  // Same shape as `render-check.mjs`: a bucket made with the store's own factory,
  // because `applyRuntimeMessage` drops anything addressed to a key that does not
  // exist, and every payload below would vanish without one.
  const KEY = 'k-turn-fold';
  await evaluate(`(() => {
    const store = window.__aigoStore;
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/work/project', { ericai: false, maxSteps: 150 });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
    }));
    window.__k = ${JSON.stringify(KEY)};
    return 'ok';
  })()`);

  const apply = async (payload) => {
    await evaluate(
      `(() => { window.__aigoStore.getState().applyRuntimeMessage(window.__k, ${JSON.stringify(payload)}); return true; })()`,
    );
    await sleep(90);
  };

  /** The window appends the prompt echo itself; there is no wire message for it. */
  const prompt = async (text) => {
    await evaluate(`(() => {
      const store = window.__aigoStore;
      const s = store.getState();
      const b = s.sessions[window.__k];
      const at = Date.now();
      const entry = { kind: 'user', id: 'user-' + at + '-' + Math.round(Math.random() * 1e6), text: ${JSON.stringify(text)}, atMs: at };
      store.setState({ sessions: { ...s.sessions, [window.__k]: { ...b, entries: [...b.entries, entry] } } });
      return true;
    })()`);
    await sleep(90);
  };

  await apply({
    v: 1, t: 'init', protocol: 5, session_id: 's-fold', resumed: false,
    model: 'deepseek-chat', provider: 'deepseek', thinking: true, effort: 'high',
    effort_levels: ['low', 'high'], model_catalog: { models: [], aliases: [] },
    workspace: 'C:/work/project', max_steps: 150, stream: true, context_tokens: 65536,
    tools: [{ name: 'grep', risk: 'low', parallel_safe: true, interactive: false }],
    permissions: {}, audit_path: 'C:/work/project/.tudouni/audit/s-fold.jsonl', notices: [],
  });

  // ---- turn 1: finished, with thinking, a tool and an answer ----
  await prompt('fold this turn away');
  await apply({ v: 1, t: 'event', kind: 'run_started', run_id: 'r1', step: 0 });
  await apply({ v: 1, t: 'delta', run_id: 'r1', step: 1, channel: 'reasoning', text: 'let me look' });
  await apply({
    v: 1, t: 'event', kind: 'model_call', run_id: 'r1', step: 0, status: 'ok',
    reasoning: 'let me look', duration_ms: 2600,
    prompt_tokens: 18320, cached_tokens: 17000, completion_tokens: 120,
  });
  await apply({
    v: 1, t: 'event', kind: 'tool_call', run_id: 'r1', step: 0, tool_index: 0,
    tool: 'grep', call_id: 'c1', arguments: '{"pattern":"streamBlocks"}',
  });
  await apply({
    v: 1, t: 'event', kind: 'tool_result', run_id: 'r1', step: 0, tool_index: 0,
    status: 'ok', chars: 1840, duration_ms: 48, preview: 'src/streamBlocks.ts:102',
  });
  await apply({ v: 1, t: 'delta', run_id: 'r1', step: 2, channel: 'text', text: 'the folded answer' });
  await apply({
    v: 1, t: 'event', kind: 'model_call', run_id: 'r1', step: 1, status: 'ok',
    duration_ms: 1500, prompt_tokens: 19000, cached_tokens: 18300, completion_tokens: 80,
  });
  await apply({
    v: 1, t: 'event', kind: 'run_finished', run_id: 'r1', step: 2,
    stop_reason: 'answered', duration_ms: 7420,
  });
  await apply({
    v: 1, t: 'ui', kind: 'run_finished', run_id: 'r1',
    answer: 'the folded answer\n',
  });

  // ---- turn 2: still running, so the head has to say what it is doing ----
  await prompt('and this one is still running');
  await apply({ v: 1, t: 'event', kind: 'run_started', run_id: 'r2', step: 0 });
  await apply({ v: 1, t: 'delta', run_id: 'r2', step: 1, channel: 'reasoning', text: 'thinking about it' });
  await sleep(1100);

  /** The transcript, as the reader sees it. */
  const read = async () =>
    JSON.parse(
      (await evaluate(`(() => {
        const all = (s) => Array.from(document.querySelectorAll(s));
        const text = (el) => (el ? el.innerText.replace(/\\s+/g, ' ').trim() : '');
        const box = (el) => Math.round(el.getBoundingClientRect().height);
        return JSON.stringify({
          heads: all('.turn-head').map((el) => ({
            text: text(el),
            expanded: el.querySelector('.th-fold')?.getAttribute('aria-expanded'),
          })),
          prompts: all('.e-user').map(text),
          runs: all('.turn-run').map((el) => ({
            turn: el.dataset.turn,
            collapsed: el.classList.contains('is-collapsed'),
            height: box(el),
          })),
          answers: all('.e-answer').map((el) => ({ height: box(el), text: text(el) })),
        });
      })()`)) ?? '{}',
    );

  const click = async (selector, nth = 0) => {
    await evaluate(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
      if (!el) throw new Error('no element for ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`);
    await sleep(450);
  };

  // ---- 1. unfolded, the head says only how the turn stands ----
  const open = await read();
  assert.equal(open.heads.length, 2, 'two turns should be in the transcript');
  assert.equal(open.heads[0].expanded, 'true');
  assert.match(open.heads[0].text, /ended · completed\s/, `the open head: ${open.heads[0].text}`);
  assert.doesNotMatch(
    open.heads[0].text,
    /\d+\.\d+s/,
    `an *open* head must not carry the folded summary's figure: ${open.heads[0].text}`,
  );
  assert.ok(open.runs[0].height > 0, 'the open turn draws its work');
  assert.match(open.answers[0].text, /folded answer/, 'the answer is drawn');
  console.log('open:', open.heads[0].text);

  // ---- 2. folded: the work goes away, the answer stays ----
  await click('.turn-head .th-fold', 0);
  const folded = await read();
  assert.equal(folded.heads[0].expanded, 'false', 'the control reports itself folded');
  assert.equal(folded.runs[0].collapsed, true, 'the work carries the fold class');
  assert.equal(folded.runs[0].height, 0, `folded work has no height (got ${folded.runs[0].height})`);
  assert.match(folded.heads[0].text, /ended · completed · 7\.4s/, `the folded line: ${folded.heads[0].text}`);
  // The point of the shape: this is a chat, not a stub. The answer is still there.
  assert.ok(folded.answers[0].height > 0, 'the answer survives the fold');
  assert.match(folded.answers[0].text, /folded answer/, `the folded answer text: ${folded.answers[0].text}`);
  assert.equal(folded.prompts[0], 'you fold this turn away', 'the prompt above a folded turn stays readable');
  assert.equal(
    folded.prompts[1],
    'you and this one is still running',
    'the next turn’s prompt is not swallowed by the fold above it',
  );
  console.log('folded:', folded.heads[0].text, '+', folded.answers[0].text);

  // ---- 3. a running turn says what it is doing, and the figure moves ----
  await click('.turn-head .th-fold', 1);
  const running = await read();
  assert.equal(running.runs[1].height, 0, 'the running turn folds too');
  assert.match(running.heads[1].text, /thinking · \d/, `a live head names the phase: ${running.heads[1].text}`);
  const before = running.heads[1].text;
  await sleep(1600);
  const later = await read();
  assert.notEqual(later.heads[1].text, before, 'the elapsed figure advances while the turn runs');
  console.log('running, folded:', before, '→', later.heads[1].text);

  // ---- 4. find opens the work it found a hit in ----
  //
  // The needle is in the *thinking*, which the fold is hiding: a hit inside a shut
  // fold has to open it, or the jump lands on a row nothing draws.
  await evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    return true;
  })()`);
  await sleep(350);
  const typed = await evaluate(`(() => {
    const input = document.querySelector('.find-input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'let me look');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(typed, true, 'Ctrl+F did not open the find bar');
  await sleep(700);
  const jumped = await read();
  assert.equal(jumped.heads[0].expanded, 'true', 'a hit inside folded work opens the turn before jumping');
  console.log('find opened the turn:', jumped.heads[0].text);

  // ---- 5. and the toggle goes both ways ----
  await click('.turn-head .th-fold', 0);
  const reclined = await read();
  assert.equal(reclined.runs[0].height, 0, 'the turn folds again');
  assert.ok(reclined.answers[0].height > 0, 'and the answer is still drawn');
  await click('.turn-head .th-fold', 0);
  const reopened = await read();
  assert.ok(reopened.runs[0].height > 0, 'and the work comes back');

  // ---- 6. a new turn arrives in the state the turn above it is in ----
  //
  // The reading shape is inherited rather than reset: fold a turn and the next
  // one arrives folded; open the turn above and the next one arrives open. This
  // is the wiring, not the rule (`entries.ts` owns that) — the rule is fed the
  // transcript *before* the new head, and a version fed the post-append
  // transcript makes every new head its own predecessor and inherits nothing.
  await apply({ v: 1, t: 'event', kind: 'run_finished', run_id: 'r2', step: 1, stop_reason: 'answered', duration_ms: 3000 });
  await apply({ v: 1, t: 'ui', kind: 'run_finished', run_id: 'r2', answer: 'the second answer' });
  // The steps above left the two turns in whatever states their own assertions
  // needed, so this step *sets* the one it needs rather than assuming it.
  if ((await read()).heads[1].expanded === 'true') await click('.turn-head .th-fold', 1);
  assert.equal((await read()).heads[1].expanded, 'false', 'the second turn is folded');

  await prompt('third');
  await apply({ v: 1, t: 'event', kind: 'run_started', run_id: 'r3', step: 0 });
  const third = await read();
  assert.equal(third.heads.length, 3, 'a third turn should be on screen');
  assert.equal(third.heads[2].expanded, 'false', 'a turn opened under a folded turn arrives folded');
  console.log('inherited folded:', third.heads[2].text);

  // Settle it, open it, and start a fourth: this is the other direction.
  await apply({ v: 1, t: 'delta', run_id: 'r3', step: 1, channel: 'text', text: 'third answer' });
  await apply({ v: 1, t: 'event', kind: 'run_finished', run_id: 'r3', step: 1, stop_reason: 'answered', duration_ms: 800 });
  await apply({ v: 1, t: 'ui', kind: 'run_finished', run_id: 'r3', answer: 'third answer' });
  await click('.turn-head .th-fold', 2);
  assert.equal((await read()).heads[2].expanded, 'true', 'the third turn is open again');

  await prompt('fourth');
  await apply({ v: 1, t: 'event', kind: 'run_started', run_id: 'r4', step: 0 });
  const fourth = await read();
  assert.equal(fourth.heads.length, 4, 'a fourth turn should be on screen');
  assert.equal(fourth.heads[3].expanded, 'true', 'a turn opened under an open turn arrives open');
  console.log('inherited open:', fourth.heads[3].text);

  assert.deepEqual(problems, [], 'the page reported errors while folding');
  console.log('ok: fold keeps the answer, live phase, prompt, find, both directions, inheritance');

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
