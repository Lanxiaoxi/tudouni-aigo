/**
 * Close check: does the X button actually ask, and does a session behind the
 * window actually say something?
 *
 * Two features live here, and neither can be checked from markup:
 *
 *   1. **The minimize-or-close prompt.** The claim is not "a dialog exists" but
 *      "one `CloseRequested` from Rust raises it, and answering it reaches the
 *      bridge with the right choice" — and, for a remembered choice, that it does
 *      **not** raise anything and answers by itself.
 *   2. **Session notifications.** The claim is "a status *transition* produces a
 *      notification, and a session somebody is watching produces none". A
 *      notification that should not have been sent looks exactly like one that
 *      should have, so the only way to tell is to count them.
 *
 * ## Why this needs a fake host AND a fake `Notification`
 *
 * `window://close-requested` is emitted by the Rust side, so the page alone can
 * never produce one — the fake `__TAURI_INTERNALS__` below therefore keeps a
 * **registry of event listeners** and can fire into them, which the existing
 * window-controls check has no need of.
 *
 * Delivery is the plugin's, and in a browser there is none: the plugin ends in
 * `new window.Notification(...)` (`@tauri-apps/plugin-notification`), so a stub
 * that records constructions is exactly the boundary being tested — the rule and
 * the sentence, not the OS toast. Replacing the whole global is deliberate: the
 * plugin reads `window.Notification.permission` on every send, so a stub with
 * `permission === 'granted'` is also what keeps the permission round trip out of
 * the way.
 *
 * Clicks are **CDP's real mouse events**, for the reason the other check
 * documents: a synthetic `.click()` bypasses hit testing, and a dialog button
 * that cannot be reached is precisely the failure this is for.
 *
 * Usage:
 *   node scripts/close-notify-check.mjs [url] [cdpPort]
 *
 * Needs `npm run dev` running and a CDP-enabled browser.
 */

import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5178/';
const port = Number(process.argv[3] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function main() {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
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
      throw new Error(
        r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text,
      );
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  // ---- the fake host ----
  //
  // Records every `invoke`, answers the window commands the front end asks for,
  // and — the part the other check does not need — keeps an **event registry** so
  // a test can fire `window://close-requested` the way Rust does.
  //
  // `transformCallback` is the real bridge's own mechanism: it stores the handler
  // on `window._<n>` and returns `n`, which is what a backend event calls. Firing
  // an event is therefore "call the stored handler for that name", and the
  // registry is what maps a name back to it.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__ipc = [];
      window.__args = [];
      window.__listeners = {};
      window.__focused = true;
      window.__minimized = false;
      window.__notifications = [];
      window.__errors = [];

      addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));

      // The plugin's last hop is \`new window.Notification(title, options)\`, so
      // recording constructions is the same boundary the OS would see.
      window.Notification = class {
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
        constructor(title, options) {
          window.__notifications.push({ title, body: (options && options.body) || '' });
        }
      };

      /**
       * The internals object the real event bridge calls **before** invoking
       * unlisten. Without it every \`unlisten()\` throws on its first statement,
       * the listener is never removed, and the stale closure stays reachable —
       * which under StrictMode's mount / unmount / remount means a *cancelled*
       * handler is the one an emitted event reaches. Its writes are skipped, so
       * a working hook looks broken. This is the harness being faithful, not the
       * application being forgiving.
       */
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event, eventId) {
          const ids = window.__listeners[event] || [];
          window.__listeners[event] = ids.filter((i) => i !== eventId);
        },
      };

      /**
       * Fire an event at every listener registered for it.
       *
       * **Every** one, because the real bridge keys listeners by id and a page
       * legitimately has several for one name. The callbacks live under an
       * underscore-prefixed global: transformCallback returns the number, and
       * the backend reaches the handler through that prefixed name — looking it
       * up by the bare number would be window[7], which is nothing at all.
       */
      window.__emit = (name, payload) => {
        const ids = window.__listeners[name] || [];
        for (const id of ids) window['_' + id]({ event: name, id, payload });
        return ids.length > 0;
      };

      window.__TAURI_INTERNALS__ = {
        transformCallback(cb, once) {
          const i = (window.__cb = (window.__cb || 0) + 1);
          window['_' + i] = cb;
          return i;
        },
        unregisterCallback() {},
        convertFileSrc: (p) => p,
        metadata: { currentWindow: { label: 'main' } },
        invoke(cmd, args) {
          window.__ipc.push(cmd);
          window.__args.push(args === undefined ? null : args);
          if (cmd === 'plugin:event|listen') {
            // One slot per **id**, not one per name: the real bridge keys
            // listeners by id, and a page legitimately has more than one for a
            // name (StrictMode mounts, unmounts and remounts). A single slot is
            // what let a cancelled closure answer an event.
            if (args && args.event) {
              const ids = window.__listeners[args.event] || [];
              window.__listeners[args.event] = [...ids, args.handler];
            }
            return Promise.resolve(args && args.handler);
          }
          if (cmd === 'plugin:event|unlisten') return Promise.resolve(null);
          if (cmd === 'plugin:window|is_focused') return Promise.resolve(window.__focused);
          if (cmd === 'plugin:window|is_minimized') return Promise.resolve(window.__minimized);
          if (cmd === 'plugin:window|is_maximized') return Promise.resolve(false);
          return Promise.resolve(null);
        },
      };
    `,
  });

  await send('Page.navigate', { url });
  await sleep(3500);

  const ready = await evaluate(`typeof window.__aigoStore?.getState === 'function'`);
  if (!ready) throw new Error('the app did not expose its store — is `npm run dev` up?');
  console.log(`host: fake __TAURI_INTERNALS__ (IPC + event registry) and a recording Notification`);
  console.log('');

  /** Where a real click at the element's centre lands, and what it emits. */
  async function clickAt(selector) {
    const at = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit ? hit.className || hit.tagName : null,
               inControl: !!(hit && el.contains(hit)) };
    })()`);
    if (!at) throw new Error(`${selector} is not in the document`);
    await evaluate('window.__ipc.length = 0; window.__args.length = 0');
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1,
    });
    await sleep(200);
    return {
      ...at,
      ipc: await evaluate('window.__ipc.slice()'),
      args: await evaluate('window.__args.slice()'),
    };
  }

  /** The argument object that went with one command, or null. */
  const argsFor = (result, cmd) => {
    const idx = result.ipc.indexOf(cmd);
    return idx < 0 ? null : result.args[idx];
  };

  /* ============================================================
     Part 1 — the close prompt
     ============================================================ */

  // Forget any policy a previous run of this check left behind.
  await evaluate(`window.__aigoStore.getState().setClosePolicy('ask')`);
  await evaluate(`window.__aigoStore.getState().setClosePrompt(false)`);
  await sleep(200);

  console.log('a close request, with no remembered choice:');
  await evaluate('window.__ipc.length = 0; window.__args.length = 0');
  const fired = await evaluate(`window.__emit('window://close-requested', null)`);
  check(fired, 'the close request reached the front end listener');
  await sleep(400);

  const acked = await evaluate(`window.__ipc.indexOf('close_prompt_ack') >= 0`);
  check(acked, 'the front end acknowledged the prompt (close_prompt_ack)');
  const dialogUp = await evaluate(`!!document.querySelector('.close-choice')`);
  check(dialogUp, 'the prompt is on screen (a .close-choice is in the DOM)');
  // The title is read from the table, so this also catches a key that never
  // resolved — `T` returns the key itself for an unknown one.
  const title = await evaluate(
    `(document.querySelector('.dialog-title') || {}).textContent || ''`,
  );
  check(/minimize or close/i.test(title), `the prompt says what it is asking (got "${title}")`);
  check(
    await evaluate(`!!document.querySelector('.overlay-mask')`),
    'the prompt is a real overlay layer',
  );

  // Esc must be a way out: the prompt has to be dismissible, or one stray click
  // on the frame becomes a forced choice between hiding the window and ending
  // every session.
  console.log('');
  console.log('dismissing it:');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  const cancelIdx = (await evaluate('window.__ipc.slice()')).indexOf('close_prompt_answer');
  const cancelArgs = cancelIdx < 0 ? null : (await evaluate('window.__args.slice()'))[cancelIdx];
  check(
    cancelArgs !== null && cancelArgs.choice === 'cancel',
    `Esc answered "cancel" (got ${JSON.stringify(cancelArgs)})`,
  );
  check(
    !(await evaluate(`!!document.querySelector('.close-choice')`)),
    'the prompt is gone after a dismissal',
  );
  // And the window is still there: a dismissal must not close anything.
  check(
    (await evaluate('window.__ipc.slice()')).indexOf('window_destroy') < 0,
    'a dismissal closed no window',
  );

  // A second request must still be answerable. This is the regression that a
  // dismissal failing to clear Rust's state would cause: the next X would be read
  // as "already asking" and ignored, and the window could only be closed once.
  console.log('');
  console.log('asking again after a dismissal:');
  await evaluate('window.__ipc.length = 0; window.__args.length = 0');
  check(
    await evaluate(`window.__emit('window://close-requested', null)`),
    'a second close request is delivered',
  );
  await sleep(400);
  check(
    await evaluate(`!!document.querySelector('.close-choice')`),
    'and the prompt is raised again, not swallowed',
  );

  // ---- answering it ----
  console.log('');
  console.log('answering "minimize":');
  const minClick = await clickAt('.close-choice');
  check(minClick.inControl, `a real click lands on the button (hit ${minClick.hit})`);
  const minArgs = argsFor(minClick, 'close_prompt_answer');
  check(
    minArgs !== null && minArgs.choice === 'minimize',
    `the bridge was told "minimize" (got ${JSON.stringify(minArgs)})`,
  );
  check(
    minClick.ipc.indexOf('window_destroy') < 0,
    'minimize did not destroy the window',
  );
  check(
    !(await evaluate(`!!document.querySelector('.close-choice')`)),
    'and the prompt went away',
  );
  check(
    (await evaluate(`window.__aigoStore.getState().closePolicy`)) === 'ask',
    'an unremembered answer kept the policy at "ask"',
  );

  // ---- remembering ----
  //
  // The third of the feature that is easiest to get wrong: a checkbox that
  // records nothing looks identical to one that works, until the next close.
  console.log('');
  console.log('remembering the choice:');
  await evaluate('window.__ipc.length = 0; window.__args.length = 0');
  await evaluate('window.__localStorageBefore = localStorage.getItem("aigo.prefs")');
  await evaluate(`window.__emit('window://close-requested', null)`);
  await sleep(400);
  await evaluate(`document.querySelector('.close-remember input').click()`);
  await sleep(150);
  const rememberedClick = await clickAt('.close-choice');
  check(
    argsFor(rememberedClick, 'close_prompt_answer')?.choice === 'minimize',
    'the remembered answer still reached the bridge',
  );
  check(
    (await evaluate(`window.__aigoStore.getState().closePolicy`)) === 'minimize',
    'the choice was recorded in the store',
  );
  const stored = await evaluate(`localStorage.getItem('aigo.prefs') || ''`);
  check(
    stored.includes('"closePolicy":"minimize"'),
    'and persisted, so the next launch remembers it',
  );

  // The payoff: with a choice remembered, the question is not asked again.
  console.log('');
  console.log('closing again, with the choice remembered:');
  await evaluate('window.__ipc.length = 0; window.__args.length = 0');
  check(
    await evaluate(`window.__emit('window://close-requested', null)`),
    'the close request is delivered',
  );
  await sleep(400);
  check(
    !(await evaluate(`!!document.querySelector('.close-choice')`)),
    'no prompt is raised — the remembered choice is applied directly',
  );
  const directArgs = await evaluate(`(() => {
    const i = window.__ipc.indexOf('close_prompt_answer');
    return i < 0 ? null : window.__args[i];
  })()`);
  check(
    directArgs !== null && directArgs.choice === 'minimize',
    `and the answer went out anyway (got ${JSON.stringify(directArgs)})`,
  );

  // Put it back, so the rest of the check and any later run start clean.
  await evaluate(`window.__aigoStore.getState().setClosePolicy('ask')`);
  await evaluate(`window.__aigoStore.getState().setClosePrompt(false)`);
  await sleep(200);

  /* ============================================================
     Part 2 — notifications
     ============================================================ */

  /**
   * Empty the window, then install one session.
   *
   * The store is driven directly because that is where the transitions happen —
   * the rule under test is the one that watches the store, and the statuses come
   * from `selectRowStatus`, which no fake can shortcut.
   */
  const reset = `
    window.__notifications.length = 0;
    window.__aigoStore.setState({
      sessions: {}, order: [], activeKey: null,
      pendingModals: [], modal: null, notifyEnabled: true, closePrompt: false,
    });
  `;
  /** One live session, with the facts `selectRowStatus` reads. It starts `idle`. */
  const addSession = (key, extra = '') => `
    (() => {
      const s = window.__aigoStore;
      const b = window.__aigoCreateBucket(${JSON.stringify(key)}, 'C:/work/proj', {
        ericai: false, maxSteps: null,
      });
      b.sessionId = 'sess-${key}';
      b.ready = true;
      ${extra}
      const st = s.getState();
      s.setState({
        sessions: { ...st.sessions, [${JSON.stringify(key)}]: b },
        order: [...st.order, ${JSON.stringify(key)}],
      });
    })();
  `;
  /**
   * One field of one session, so a status moves while everything else stays put.
   *
   * This is a status *change* rather than a fresh session, and that is the whole
   * mechanism: the notifier keeps its last observation per session, so only a
   * transition can produce a notification.
   */
  const patchSession = (key, patch) => `
    (() => {
      const s = window.__aigoStore;
      const st = s.getState();
      const cur = st.sessions[${JSON.stringify(key)}];
      s.setState({ sessions: { ...st.sessions, [${JSON.stringify(key)}]: { ...cur, ${patch} } } });
    })();
  `;

  const notes = () => evaluate('window.__notifications.slice()');

  /**
   * Raise a blocking question from one session.
   *
   * Both halves are set, because that is what `enqueueModal` does and the two
   * are read by different things: `pendingModals` is what `selectRowStatus`
   * counts as `asking`, and `modal` is the head that `selectModalVisible`
   * judges for whether the prompt is actually drawn.
   */
  const openQuestion = (key) => `
    window.__aigoStore.setState({
      pendingModals: [{ kind: 'question', key: ${JSON.stringify(key)}, req: {
        id: 'q1', question: 'Which one?', header: '', options: [], multi_select: false,
      } }],
      modal: { kind: 'question', key: ${JSON.stringify(key)}, req: {
        id: 'q1', question: 'Which one?', header: '', options: [], multi_select: false,
      } },
    });
  `;

  const closeQuestion = () => `
    window.__aigoStore.setState({ pendingModals: [], modal: null });
  `;

  console.log('');
  console.log('a session appearing is not news:');
  await evaluate(reset);
  await sleep(200);
  await evaluate(addSession('n1'));
  await sleep(400);
  check(
    (await notes()).length === 0,
    `no notification for a session seen for the first time (got ${JSON.stringify(await notes())})`,
  );

  console.log('');
  console.log('a background session finishing:');
  // `unseen` is what the store sets when `run_finished` lands for a session that
  // was not on screen — the "it finished while you were looking elsewhere" case.
  await evaluate(patchSession('n1', 'unseen: true'));
  await sleep(400);
  const finished = await notes();
  check(finished.length === 1, `exactly one notification (got ${finished.length})`);
  check(
    finished[0]?.title === 'Finished',
    `and it says what happened (got ${JSON.stringify(finished[0])})`,
  );
  check(
    (finished[0]?.body ?? '').includes('proj') && (finished[0]?.body ?? '').includes('sess-n1'),
    `and which session it was (got ${JSON.stringify(finished[0]?.body)})`,
  );

  console.log('');
  console.log('a session that asks for an answer, with the window minimized:');
  // **The meaningful `asking` case, and the reason a rendered prompt is not one.**
  // A request drawn over the transcript is already in front of the person, so
  // `isWatched` counts it as being seen and stays quiet — the notification would
  // be a second copy of something visible. What is NOT seen is a request that
  // arrives while the window is in the tray, and that is the one that has to
  // speak up: nothing moves until somebody answers it.
  await evaluate(reset);
  await sleep(200);
  await evaluate(addSession('n1'));
  await sleep(400);
  await evaluate(`window.__aigoStore.setState({ activeKey: 'n1' })`);
  await evaluate(`window.__focused = false`);
  await evaluate(`window.__minimized = true`);
  await evaluate(`window.__emit('tauri://blur', null)`);
  await sleep(500);
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(openQuestion('n1'));
  await sleep(500);
  const asking = await notes();
  check(asking.length === 1, `exactly one notification (got ${asking.length})`);
  check(
    asking[0]?.title === 'Waiting for your answer',
    `the most urgent case is worded as such (got ${JSON.stringify(asking[0])})`,
  );

  console.log('');
  console.log('the same request, with the prompt actually on screen:');
  // Now with the window back in front, the prompt is rendered over the
  // conversation — so it is being watched, and saying so again would be noise.
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(`window.__focused = true`);
  await evaluate(`window.__minimized = false`);
  await evaluate(`window.__emit('tauri://focus', null)`);
  await sleep(500);
  await evaluate(closeQuestion());
  await sleep(400);
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(openQuestion('n1'));
  await sleep(500);
  check(
    (await notes()).length === 0,
    `nothing is said about a prompt already in front of the person (got ${JSON.stringify(await notes())})`,
  );

  console.log('');
  console.log('a session that stops with an error, in the background:');
  // `runtimeExit` with `requested: false` is the child dying unasked, which
  // `selectRowStatus` reads as `broken`. The request above is cleared first so
  // this is one transition and not two.
  await evaluate(reset);
  await sleep(200);
  await evaluate(addSession('n1'));
  await sleep(400);
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'runtimeExit: { code: 1, requested: false }'));
  await sleep(500);
  const broken = await notes();
  check(broken.length === 1, `exactly one notification (got ${broken.length})`);
  check(
    broken[0]?.title === 'Stopped with an error',
    `and it does not claim the work finished (got ${JSON.stringify(broken[0])})`,
  );

  console.log('');
  console.log('a request nobody collects a second time:');
  // One request is one notification, however many times the state is re-read.
  // The status stays `asking` throughout, and an unchanged status is never news
  // — otherwise every unrelated store write would raise another toast.
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(`window.__aigoStore.setState({})`);
  await evaluate(patchSession('n1', 'runtimeExit: { code: 1, requested: false }'));
  await sleep(400);
  check(
    (await notes()).length === 0,
    `an unchanged status says nothing (got ${JSON.stringify(await notes())})`,
  );

  console.log('');
  console.log('the session somebody is looking at:');
  // `activeKey` is this session and the window is in the foreground, so this is
  // the one case where a real transition must stay silent.
  await evaluate(reset);
  await sleep(200);
  await evaluate(addSession('n1'));
  await sleep(400);
  await evaluate(`window.__aigoStore.setState({ activeKey: 'n1' })`);
  await evaluate(`window.__focused = true`);
  await evaluate(`window.__emit('tauri://focus', null)`);
  await sleep(500);
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'unseen: true'));
  await sleep(500);
  check(
    (await notes()).length === 0,
    `nothing is said about a session on screen in a focused window (got ${JSON.stringify(await notes())})`,
  );

  console.log('');
  console.log('the same transition, with the window merely unfocused:');
  // **The most common real case: alt-tabbing away with the window still on
  // screen.** `isWatched` requires focused **and** not minimized, so this tests
  // the focus half on its own — the minimized case below would otherwise hide a
  // broken focus path, because minimize alone is already enough to be
  // "not foreground".
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'unseen: false'));
  await sleep(400);
  await evaluate(`window.__focused = false`);
  await evaluate(`window.__minimized = false`);
  check(
    await evaluate(`window.__emit('tauri://blur', null)`),
    'the blur event reached the listener',
  );
  await sleep(500);
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'unseen: true'));
  await sleep(500);
  const blurred = await notes();
  check(
    blurred.length === 1,
    `an unfocused window still hears about it (got ${JSON.stringify(blurred)})`,
  );
  check(
    blurred[0]?.title === 'Finished',
    `and the wording is the same as any other finished turn (got ${JSON.stringify(blurred[0])})`,
  );

  console.log('');
  console.log('the same transition, with the window minimized:');
  // The other half of `focused && !minimized`, and the case the feature was
  // asked for: a window in the tray has no attention on it at all, and this
  // session is the one on screen — so a rule that read "on screen" as "watched"
  // would stay silent at exactly the moment the notification is the only way to
  // learn the work finished.
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'unseen: false'));
  await sleep(400);
  await evaluate(`window.__focused = true`);
  await evaluate(`window.__minimized = true`);
  check(await evaluate(`window.__emit('tauri://focus', null)`), 'the focus event reached the listener');
  await sleep(500);
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'unseen: true'));
  await sleep(500);
  const minimized = await notes();
  check(
    minimized.length === 1,
    `a minimized window still hears about it (got ${JSON.stringify(minimized)})`,
  );
  check(
    minimized[0]?.title === 'Finished',
    `and the wording is the same as any other finished turn (got ${JSON.stringify(minimized[0])})`,
  );

  console.log('');
  console.log('a session that is merely idle:');
  // `idle` is where a session that has never been spoken to sits and where one
  // goes after being read. A rule that fired here would announce nothing having
  // happened — twice.
  await evaluate(reset);
  await sleep(200);
  await evaluate(addSession('n1'));
  await sleep(400);
  await evaluate(`window.__focused = true`);
  await evaluate(`window.__minimized = false`);
  await evaluate(`window.__emit('tauri://focus', null)`);
  await sleep(500);
  await evaluate(patchSession('n1', 'unseen: true'));
  await sleep(500);

  await evaluate(`window.__notifications.length = 0`);
  await evaluate(patchSession('n1', 'unseen: false'));
  await sleep(500);
  check(
    (await notes()).length === 0,
    `nothing is said about a session returning to idle (got ${JSON.stringify(await notes())})`,
  );

  console.log('');
  console.log('notifications switched off:');
  await evaluate(`window.__notifications.length = 0`);
  await evaluate(`window.__aigoStore.getState().setNotifyEnabled(false)`);
  await sleep(200);
  await evaluate(patchSession('n1', 'unseen: true'));
  await sleep(500);
  check(
    (await notes()).length === 0,
    `nothing is sent while the setting is off (got ${JSON.stringify(await notes())})`,
  );
  await evaluate(`window.__aigoStore.getState().setNotifyEnabled(true)`);
  await sleep(200);

  // Nothing above may have thrown in the background: an unhandled rejection
  // inside the hook looks exactly like a rule that decided to be quiet.
  const errors = await evaluate('window.__errors.slice()');
  check(errors.length === 0, `no unhandled errors in the page (got ${JSON.stringify(errors)})`);

  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();

  console.log('');
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log('PASS — the X button asks and remembers, and a session behind the');
  console.log('       window says so — exactly once, and only when it should.');
}

main().catch((error) => {
  console.error('');
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
