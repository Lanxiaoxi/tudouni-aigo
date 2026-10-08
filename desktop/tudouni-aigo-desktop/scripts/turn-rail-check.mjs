/**
 * Turn rail check: drive the real interface with a real conversation and measure
 * what the rail does.
 *
 * `tests/turn-rail.test.ts` covers the rules that can be read off an `Entry[]`.
 * Three things about this feature cannot be: where the lane sits, where a jump
 * actually lands, and whether the mark the rail calls "current" is the turn the
 * reader is looking at. All three are geometry, so all three need a browser.
 *
 * **The numbers this prints are the ones quoted in `stream.css`**, which is why
 * the floating-overlay alternative is measured rather than argued: the rail
 * exists as a flex lane instead of a 28px overlay at `right: 12px`, and the
 * difference is only visible at a window size where the transcript's centred
 * gutter has gone. This script puts it back and measures the overlap.
 *
 * The session is driven through the store exactly as `render-check.mjs` does —
 * the store's own actions, the store's own payload shapes — so nothing here is a
 * mock. Sixty turns, each with a long answer, for two reasons: the transcript has
 * to be long enough that most of it is **not laid out** (`content-visibility:
 * auto`), which is the condition under which a jump can land wrong; and the rail
 * has to be taller than its frame, which is the condition under which it has to
 * scroll itself.
 *
 * Usage:
 *   node scripts/turn-rail-check.mjs [url] [cdpPort] [screenshotPath]
 */

import { writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const shotPath = process.argv[4] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many turns to drive. Enough that the rail overflows its own frame. */
const TURNS = 60;
/** A long answer, so the transcript is many screens tall. */
const BODY = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} of the answer.`).join('\n\n');

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

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      const detail =
        r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      throw new Error(`eval threw: ${detail}`);
    }
    return r.result?.result?.value;
  };
  const probe = async (expression) => JSON.parse((await evaluate(expression)) ?? 'null');

  await send('Runtime.enable');
  await send('Page.enable');
  // 1440×900 with both rails open, which is the window the `stream.css` numbers
  // were taken at — the narrowest ordinary desktop case, and the one where the
  // transcript's gutter is under the most pressure.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(2500);

  // ---- the harness bucket, exactly as `render-check.mjs` makes it ----
  const KEY = 'k-rail';
  const ready = await evaluate(`(() => {
    const store = window.__aigoStore;
    if (typeof window.__aigoCreateBucket !== 'function') return 'no bucket factory';
    const bucket = window.__aigoCreateBucket(${JSON.stringify(KEY)}, 'C:/work/project', {
      ericai: false,
      maxSteps: null,
    });
    store.setState((s) => ({
      sessions: { ...s.sessions, [${JSON.stringify(KEY)}]: bucket },
      order: s.order.includes(${JSON.stringify(KEY)}) ? s.order : [...s.order, ${JSON.stringify(KEY)}],
      activeKey: ${JSON.stringify(KEY)},
    }));
    window.__aigoKey = ${JSON.stringify(KEY)};
    return 'ok';
  })()`);
  if (ready !== 'ok') throw new Error(`could not open a session bucket: ${ready}`);

  const apply = async (payload) => {
    const ok = await evaluate(
      `(() => { window.__aigoStore.getState().applyRuntimeMessage(window.__aigoKey, ${JSON.stringify(
        payload,
      )}); return true; })()`,
    );
    if (ok !== true) throw new Error(`failed to apply ${payload.t}`);
    await sleep(6);
  };

  await apply({
    v: 1,
    t: 'init',
    protocol: 3,
    session_id: 's-rail',
    resumed: false,
    model: 'deepseek-chat',
    provider: 'deepseek',
    thinking: true,
    effort: 'high',
    effort_levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    model_catalog: { models: [], aliases: [] },
    workspace: 'C:/work/project',
    max_steps: 120,
    stream: true,
    context_tokens: 65536,
    tools: [{ name: 'shell', risk: 'high', parallel_safe: false, interactive: false }],
    permissions: {},
    audit_path: 'C:/work/project/.tudouni/audit/s-rail.jsonl',
    notices: [],
  });

  /** One turn, driven the way the application drives it. */
  const driveTurn = async (n) => {
    // The echo, through the store's own action — the rail's prompt rule depends on
    // the echo arriving *before* the head, and typing it in by hand would test the
    // rule against an arrangement nothing produces. `sendTo` drops the message (no
    // bridge in a plain browser), which is the same thing it does while booting.
    await evaluate(`(() => {
      const s = window.__aigoStore.getState();
      const key = window.__aigoKey;
      window.__aigoStore.setState((cur) => ({
        sessions: { ...cur.sessions, [key]: { ...cur.sessions[key], draft: 'question ${n}' } },
      }));
      s.submitDraft();
      return true;
    })()`);
    await sleep(6);
    await apply({
      v: 1,
      t: 'event',
      kind: 'run_started',
      session_id: 's-rail',
      run_id: `r-${n}`,
      step: 0,
      ts: '2026-01-01T00:00:00Z',
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    await apply({
      v: 1,
      t: 'event',
      kind: 'model_call',
      session_id: 's-rail',
      run_id: `r-${n}`,
      step: 0,
      ts: '2026-01-01T00:00:01Z',
      status: 'ok',
      duration_ms: 900,
      prompt_tokens: 1000,
      cached_tokens: 700,
      completion_tokens: 40,
    });
    await apply({
      v: 1,
      t: 'ui',
      kind: 'run_finished',
      run_id: `r-${n}`,
      answer: `answer ${n}\n\n${BODY}`,
    });
  };

  // ---- one turn: the lane is not taken yet ----
  await driveTurn(1);
  const one = await probe(`(() => JSON.stringify({
    marks: document.querySelectorAll('.turn-rail-mark').length,
    rail: !!document.querySelector('.turn-rail'),
    scrollW: Math.round(document.querySelector('.stream-scroll').getBoundingClientRect().width),
    bodyW: Math.round(document.querySelector('.stream-body').getBoundingClientRect().width),
  }))()`);
  console.log('one turn:', JSON.stringify(one));
  if (one.rail) throw new Error('the rail was drawn for a single turn');
  if (one.scrollW !== one.bodyW) {
    throw new Error(`the lane was reserved with nothing in it: ${one.scrollW} of ${one.bodyW}`);
  }

  // ---- the conversation ----
  for (let n = 2; n <= TURNS; n += 1) await driveTurn(n);
  await sleep(300);

  const layout = await probe(`(() => {
    const q = (s) => document.querySelector(s);
    const r = (el) => el.getBoundingClientRect();
    const scroll = q('.stream-scroll');
    const inner = q('.stream-inner');
    const rail = q('.turn-rail');
    const rows = [...document.querySelectorAll('.stream-inner > *')];
    // The right edge of the text: the widest row box on screen. Rows off screen
    // are skipped by content-visibility, so only the laid-out ones count — and an
    // overlay can only collide with a row somebody can see.
    const textRight = Math.max(...rows.map((el) => r(el).right));
    const scroller = r(scroll);
    const railBox = r(rail);
    return JSON.stringify({
      marks: document.querySelectorAll('.turn-rail-mark').length,
      frames: document.querySelectorAll('.turn-rail').length,
      appStreamW: Math.round(r(q('.app-stream')).width),
      bodyW: Math.round(r(q('.stream-body')).width),
      scrollW: Math.round(scroller.width),
      innerW: Math.round(r(inner).width),
      textRight: Math.round(textRight),
      railLeft: Math.round(railBox.left),
      railRight: Math.round(railBox.right),
      gapTextToRail: Math.round(railBox.left - textRight),
      railFrameH: Math.round(r(q('.turn-rail-scroll')).height),
      railContentH: Math.round(q('.turn-rail-marks').getBoundingClientRect().height),
      railScrollTop: Math.round(q('.turn-rail-scroll').scrollTop),
      viewportH: Math.round(scroller.height),
      docH: Math.round(scroll.scrollHeight),
      active: [...document.querySelectorAll('.turn-rail-mark')].findIndex((m) =>
        m.classList.contains('is-active'),
      ),
    });
  })()`);
  console.log('layout:', JSON.stringify(layout, null, 1));

  if (layout.marks !== TURNS) throw new Error(`the rail drew ${layout.marks} marks for ${TURNS} turns`);
  if (layout.frames !== 1) throw new Error(`there are ${layout.frames} rails, not one`);
  // The whole reason for the lane: a mark must never sit over the text.
  if (layout.gapTextToRail <= 0) {
    throw new Error(`a mark is over the text: gap ${layout.gapTextToRail}px`);
  }
  if (layout.railContentH <= layout.railFrameH) {
    throw new Error(
      `the rail did not overflow its frame (${layout.railContentH} in ${layout.railFrameH}): ` +
        'the self-scrolling path is untested',
    );
  }
  // The rail's own answer, checked against the geometry rather than against a
  // number written here. The rule is "the last turn whose heading is above the
  // fold", so the rail's answer must be that turn, or the one after it when its
  // heading has just crossed into the landing band — never the one *before* it.
  //
  // That last case is not hypothetical: the mark for the turn that has just
  // started is the one the rail's anchor map is most likely to be missing, and a
  // missing anchor reads as `Infinity`, i.e. "never scrolled past" — so the rail
  // would highlight the previous turn, which is the rail disagreeing with the
  // transcript about where the reader is.
  const truth = await probe(`(() => {
    const scroll = document.querySelector('.stream-scroll');
    const origin = scroll.getBoundingClientRect().top;
    const tops = [...document.querySelectorAll('.turn-head')].map(
      (el) => el.getBoundingClientRect().top - origin,
    );
    let past = 0;
    for (let i = 0; i < tops.length; i += 1) if (tops[i] <= 0) past = i;
    const active = [...document.querySelectorAll('.turn-rail-mark')].findIndex((m) =>
      m.classList.contains('is-active'),
    );
    return JSON.stringify({ past, active, headTop: Math.round(tops[tops.length - 1]) });
  })()`);
  console.log('at rest:', JSON.stringify(truth));
  if (truth.active !== truth.past && truth.active !== truth.past + 1) {
    throw new Error(
      `the rail highlights mark ${truth.active + 1} while the last heading above the fold is ` +
        `turn ${truth.past + 1} (the next one is ${truth.headTop}px below the top)`,
    );
  }

  // ---- what the floating alternative would have done ----
  //
  // The measurement `stream.css` quotes. The lane is taken out of the flow and
  // put where an overlay would sit — 28px wide at `right: 12px`, vertically
  // centred — and the same two edges are compared.
  const floating = await probe(`(() => {
    const rail = document.querySelector('.turn-rail');
    const before = rail.getAttribute('style');
    rail.style.cssText =
      'position:absolute;right:12px;top:50%;transform:translateY(-50%);padding:0;width:28px;';
    const rows = [...document.querySelectorAll('.stream-inner > *')];
    const textRight = Math.max(...rows.map((el) => el.getBoundingClientRect().right));
    const overlay = rail.getBoundingClientRect();
    rail.setAttribute('style', before ?? '');
    return JSON.stringify({
      overlayLeft: Math.round(overlay.left),
      overlayRight: Math.round(overlay.right),
      textRight: Math.round(textRight),
      overlap: Math.round(Math.max(0, textRight - overlay.left)),
    });
  })()`);
  console.log('floating alternative:', JSON.stringify(floating));
  if (floating.overlap <= 0) {
    throw new Error(
      'an overlay would NOT have overlapped at this window size — the lane may still be ' +
        'worth having, but the numbers in stream.css need re-measuring',
    );
  }

  const landing = Number(
    (
      await probe(
        `(() => JSON.stringify({ m: getComputedStyle(document.querySelector('.turn-head')).scrollMarginTop }))()`,
      )
    ).m.replace('px', ''),
  );
  console.log('scroll-margin-top:', landing);

  // ---- the mechanism a jump depends on ----
  //
  // A jump lifts `content-visibility` for the length of the scroll, because the
  // rows past the viewport otherwise contribute a 120px estimate and the document
  // is shorter than it really is — which is what clamps a far jump at the bottom.
  // A selector that misses looks *exactly* like a jump that cannot reach, so the
  // mechanism is measured instead of assumed.
  const mechanism = await probe(`(() => {
    const scroll = document.querySelector('.stream-scroll');
    const row = document.querySelector('.stream-inner > *');
    const before = getComputedStyle(row).contentVisibility;
    scroll.classList.add('is-landing');
    const during = getComputedStyle(row).contentVisibility;
    scroll.classList.remove('is-landing');
    return JSON.stringify({ before, during });
  })()`);
  console.log('landing mechanism:', JSON.stringify(mechanism));
  if (mechanism.during !== 'visible') {
    throw new Error(
      `the .is-landing rule does not lift content-visibility (still "${mechanism.during}")`,
    );
  }

  // ---- a jump lands on the turn that was clicked ----
  //
  // Three times: a short jump inside the laid-out window, a long one, and the
  // last turn, whose row was added after the rail's anchor map was built.
  const jumpTo = async (index) => {
    await evaluate(`(() => {
      const marks = [...document.querySelectorAll('.turn-rail-mark')];
      marks[${index}].click();
      return true;
    })()`);
    await sleep(220);
    return probe(`(() => {
      const scroll = document.querySelector('.stream-scroll');
      const heads = [...document.querySelectorAll('.turn-head')];
      const origin = scroll.getBoundingClientRect().top;
      const tops = heads.map((el) => Math.round((el.getBoundingClientRect().top - origin) * 10) / 10);
      const active = [...document.querySelectorAll('.turn-rail-mark')].findIndex((m) =>
        m.classList.contains('is-active'),
      );
      return JSON.stringify({
        landed: tops[${index}] ?? null,
        active,
        scrollTop: Math.round(scroll.scrollTop),
      });
    })()`);
  };

  for (const index of [7, 41, TURNS - 1]) {
    const at = await jumpTo(index);
    console.log(`jump to mark ${index + 1}:`, JSON.stringify(at));
    if (at.landed === null) throw new Error(`turn ${index + 1} has no head to measure`);
    // The head belongs `scroll-margin-top` below the top — that inset is the point
    // of it. What is checked is that it is *there* and not thousands of px away,
    // which is what happens when the target is computed from estimates: with
    // `content-visibility: auto` the rows between are not laid out, so the
    // document is short and the scroll clamps at the bottom. Sub-pixel slack,
    // because `scrollTop` is fractional.
    if (Math.abs(at.landed - landing) > 1) {
      throw new Error(
        `the jump to turn ${index + 1} landed ${at.landed}px from the top, not the ${landing}px ` +
          'landing inset — with content-visibility the rows in between are estimates, so the ' +
          'document is shorter than it is and the scroll clamps at the bottom',
      );
    }
    if (at.active !== index) {
      throw new Error(`after jumping to turn ${index + 1} the rail highlights mark ${at.active + 1}`);
    }
  }

  // ---- the rail's own frame keeps the reader's mark inside it ----
  const follow = await probe(`(() => {
    const frame = document.querySelector('.turn-rail-scroll').getBoundingClientRect();
    const active = document.querySelector('.turn-rail-mark.is-active').getBoundingClientRect();
    return JSON.stringify({
      frameTop: Math.round(frame.top),
      frameBottom: Math.round(frame.bottom),
      markTop: Math.round(active.top),
      markBottom: Math.round(active.bottom),
      railScrollTop: Math.round(document.querySelector('.turn-rail-scroll').scrollTop),
    });
  })()`);
  console.log('frame follow:', JSON.stringify(follow));
  if (follow.markTop < follow.frameTop - 1 || follow.markBottom > follow.frameBottom + 1) {
    throw new Error('the rail did not scroll its own frame to the reader\u2019s turn');
  }

  // ---- one tab stop, and the marks say which turn they are ----
  const access = await probe(`(() => {
    const marks = [...document.querySelectorAll('.turn-rail-mark')];
    return JSON.stringify({
      tabbable: marks.filter((m) => m.tabIndex === 0).length,
      first: marks[0].getAttribute('aria-label'),
      last: marks[marks.length - 1].getAttribute('aria-label'),
      nav: document.querySelector('.turn-rail').getAttribute('aria-label'),
      current: marks.filter((m) => m.getAttribute('aria-current') === 'true').length,
    });
  })()`);
  console.log('accessibility:', JSON.stringify(access));
  if (access.tabbable !== 1) throw new Error(`the rail has ${access.tabbable} tab stops, not one`);
  if (!access.first?.includes('1') || !access.last?.includes(String(TURNS))) {
    throw new Error(`the marks are not named after their turns: ${access.first} … ${access.last}`);
  }
  if (!access.nav) throw new Error('the rail has no accessible name');
  if (access.current !== 1) throw new Error(`the rail marks ${access.current} turns as current`);

  // ---- the hover card ----
  await evaluate(`(() => {
    const marks = [...document.querySelectorAll('.turn-rail-mark')];
    marks[4].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    marks[4].dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  const preview = await probe(`(() => {
    const el = document.querySelector('.turn-rail-preview');
    if (!el) return JSON.stringify({ shown: false });
    const box = el.getBoundingClientRect();
    const frame = document.querySelector('.turn-rail').getBoundingClientRect();
    return JSON.stringify({
      shown: true,
      prompt: el.querySelector('.turn-rail-prompt')?.textContent ?? '',
      response: el.querySelector('.turn-rail-response')?.textContent ?? '',
      role: el.getAttribute('role'),
      insideFrame: box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
      leftOfRail: box.right <= frame.left,
    });
  })()`);
  console.log('hover card:', JSON.stringify(preview));
  if (!preview.shown) throw new Error('hovering a mark showed no card');
  if (preview.prompt !== 'question 5') throw new Error(`the card showed the wrong prompt: ${preview.prompt}`);
  if (!preview.response.startsWith('answer 5')) {
    throw new Error(`the card showed the wrong answer: ${preview.response.slice(0, 40)}`);
  }
  if (preview.role !== 'tooltip') throw new Error('the card is not a tooltip');
  if (!preview.insideFrame) throw new Error('the card escaped the rail\u2019s own frame');
  if (!preview.leftOfRail) throw new Error('the card is not to the left of the rail');

  // ---- the active mark tracks the reader ----
  await evaluate(`(() => { document.querySelector('.stream-scroll').scrollTop = 0; return true; })()`);
  await sleep(220);
  const atTop = await probe(`(() => JSON.stringify({
    active: [...document.querySelectorAll('.turn-rail-mark')].findIndex((m) =>
      m.classList.contains('is-active'),
    ),
  }))()`);
  console.log('at the top:', JSON.stringify(atTop));
  if (atTop.active !== 0) throw new Error(`at the top the rail highlights mark ${atTop.active + 1}`);

  if (shotPath !== '') {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
    console.log(`screenshot: ${shotPath}`);
  }

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();

  console.log('');
  if (problems.length > 0) {
    console.log(`FAIL — ${problems.length} runtime problem(s):`);
    for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`PASS — ${TURNS} turns, one mark each, no mark over the text, jumps land.`);
}

main().catch((e) => {
  console.error('');
  console.error('FAIL:', e.message);
  process.exit(1);
});
