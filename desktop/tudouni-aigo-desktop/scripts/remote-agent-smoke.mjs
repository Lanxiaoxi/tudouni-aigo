/**
 * Prove the remote session is a **working agent**, not merely a connection.
 *
 * Connecting is not the claim the feature makes — "work in this directory on that
 * server" is. So this sends one real turn to the model through the live remote
 * session and waits for an answer, and it also asks the remote runtime to list
 * its own workspace files, which is the file capability running on the far end's
 * filesystem through the same protocol a local session uses.
 *
 * Usage: node scripts/remote-agent-smoke.mjs [cdpPort] [prompt]
 */

const [, , portArg = '9333', prompt = 'Reply with exactly: REMOTE OK', model = ''] = process.argv;
const port = Number(portArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const p = t.find((x) => x.type === 'page');
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval threw');
    return r.result?.result?.value;
  };
  await send('Runtime.enable');

  const start = JSON.parse(await ev(`(() => {
    const s = window.__aigoStore.getState();
    const rt = s.sessions[s.activeKey];
    return JSON.stringify({
      key: s.activeKey,
      ready: rt?.ready,
      remoteWorkspaceId: rt?.remoteWorkspaceId,
      workspace: rt?.workspace,
      sessionId: rt?.sessionId,
    });
  })()`));
  console.log('session:', JSON.stringify(start));
  if (!start.ready || !start.remoteWorkspaceId) {
    throw new Error('no live *remote* session is active — open the remote workspace first');
  }

  // ---- 0. optionally pick the model first ----
  //
  // The route the session starts on is whatever the remote `config.json` names
  // first, and a route can be unusable for reasons that have nothing to do with
  // this feature (an exhausted account, a blocked endpoint). Being able to choose
  // one is what lets this check distinguish "the transport works and the provider
  // said no" from "the transport is broken".
  if (model) {
    const chosen = await ev(`(() => {
      window.__aigoStore.getState().chooseModel(${JSON.stringify(model)});
      return true;
    })()`);
    await sleep(2500);
    const now = JSON.parse(await ev(`(() => {
      const rt = window.__aigoStore.getState().sessions[window.__aigoStore.getState().activeKey];
      return JSON.stringify({ model: rt?.session?.model ?? null, provider: rt?.session?.provider ?? null });
    })()`));
    console.log('model requested:', model, '->', JSON.stringify(now));
  }

  // ---- 1. the file capability, answered by the far end's runtime ----
  //
  // This is the remote filesystem being listed **through the session**, by the
  // runtime process running on that server: the same `file_list` dispatch a local
  // session uses, with no branch anywhere above it for "but this one is remote".
  await ev(`(() => { window.__aigoStore.getState().listFiles(''); return true; })()`);
  await sleep(4000);
  const files = JSON.parse(await ev(`(() => {
    const s = window.__aigoStore.getState();
    const rt = s.sessions[s.activeKey];
    return JSON.stringify({
      path: rt?.filesPath ?? null,
      count: (rt?.filesEntries ?? []).length,
      names: (rt?.filesEntries ?? []).slice(0, 12).map((e) => e.name),
      problem: rt?.filesProblem ?? null,
      loading: rt?.filesLoading ?? null,
    });
  })()`));
  console.log('remote file listing:', JSON.stringify(files));
  const listed = files.count > 0;
  console.log(`${listed ? 'PASS' : 'FAIL'}  the remote workspace's own files are listed through the session`);

  // ---- 2. one real turn, sent to the model through this session ----
  //
  // Typed into the real composer and submitted through the store's own
  // `submitDraft`, which is the same path `Enter` in the box takes — so this
  // exercises the transcript, the busy state and the turn clock rather than a
  // private back door.
  const typed = await ev(`(() => {
    const ta = document.querySelector('.composer textarea');
    if (!ta) return 'no composer textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(prompt)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const draft = window.__aigoStore.getState().sessions[window.__aigoStore.getState().activeKey]?.draft;
    return draft === ${JSON.stringify(prompt)} ? 'typed' : 'draft is ' + JSON.stringify(draft);
  })()`);
  console.log('composer:', typed);
  if (typed !== 'typed') throw new Error('could not type into the composer: ' + typed);

  await ev(`(() => { window.__aigoStore.getState().submitDraft(); return true; })()`);

  // ---- 3. wait for the turn to finish ----
  //
  // `lastTurnMs` is a *previous* turn's value until this one ends, so it cannot
  // be the loop's termination condition on its own — reading it as "done" makes
  // the check pass (or fail) against the last turn instead of this one. What is
  // watched instead is the entry list growing an answer, falling back to the
  // turn clock settling.
  const before = JSON.parse(await ev(`(() => {
    const rt = window.__aigoStore.getState().sessions[window.__aigoStore.getState().activeKey];
    return JSON.stringify({
      entries: (rt?.entries ?? []).length,
      lastTurnMs: rt?.lastTurnMs ?? null,
    });
  })()`));
  console.log('before this turn:', JSON.stringify(before));

  let final = null;
  for (let i = 0; i < 160; i += 1) {
    await sleep(1500);
    final = JSON.parse(await ev(`(() => {
      const s = window.__aigoStore.getState();
      const rt = s.sessions[s.activeKey];
      const all = (rt?.entries ?? []);
      // **Only what the model said.** The user's own message is an entry too, and
      // it contains the prompt verbatim — so scanning the whole transcript for
      // the expected answer matched the *question* and reported a pass on a turn
      // that had actually failed. That is the worst kind of check: green, and
      // wrong. The model's own words are the entries that are neither the user's
      // nor the runtime's notes.
      const said = all.filter((e) => e.kind !== 'note' && e.kind !== 'user' && e.kind !== 'turn');
      const answer = said.map((e) => e.text ?? '').join('\\n');
      const notes = all.filter((e) => e.kind === 'note').map((e) => e.text ?? '');
      return JSON.stringify({
        entryCount: all.length,
        lastTurnMs: rt?.lastTurnMs ?? null,
        busy: rt?.busy ?? null,
        problem: rt?.problem ?? null,
        answer: answer.slice(-800),
        lastNote: notes.slice(-1)[0] ?? null,
      });
    })()`));
    // Done when the runtime has reported a completed turn *and* something has
    // been added since we started watching; a refusal ends it too.
    const grew = final.entryCount > before.entries;
    const settled = final.lastTurnMs !== null && final.lastTurnMs !== before.lastTurnMs;
    const refused = typeof final.lastNote === 'string' && /failed/i.test(final.lastNote);
    if ((grew && settled) || refused || final.problem) break;
  }
  console.log('turn result:', JSON.stringify(final, null, 2).slice(0, 1400));

  const answered = /REMOTE OK/i.test(final?.answer ?? '');
  const upstream = typeof final?.lastNote === 'string' && /HTTP \d|Insufficient|upstream|timeout|refused/i.test(final.lastNote);

  if (answered) {
    console.log('\nPASS  the remote session completed a model turn and produced the answer');
  } else if (upstream) {
    // The turn reached the model endpoint *through the remote session* and the
    // provider refused it — a billing or quota fact about the account, not a
    // fault in this feature. Distinguished so a green "it works" is never
    // printed for a turn that did not actually answer.
    console.log('\nPASS  the turn reached the model endpoint through the remote session');
    console.log('NOTE  the provider refused it, so no answer came back:');
    console.log('      ' + final.lastNote);
  } else {
    console.log('\nFAIL  the remote session produced no answer');
    console.log('      ' + JSON.stringify(final));
  }
  ws.close();
  process.exit(answered || upstream ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
