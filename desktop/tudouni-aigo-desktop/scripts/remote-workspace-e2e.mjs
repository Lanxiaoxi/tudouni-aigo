/**
 * Drive the add-remote-workspace wizard in the **real window** and connect to a
 * real server over real SSH.
 *
 * This is the check the feature needs and that no unit test can give: it presses
 * the same buttons a person presses, over the app's own IPC bridge
 * (`__TAURI_INTERNALS__`), against a host that is actually there. Everything the
 * wizard claims — that a host can be picked from `~/.ssh/config`, that a
 * connection is attempted before anything is saved, that the remote directory
 * listing is the far end's own, that the Runtime is installed, and that the
 * session comes up **in the chosen directory** — is only true if the end-to-end
 * path works.
 *
 * The last one is the point. The remote command used to run in the account's home
 * directory, which the runtime refuses as a workspace, so every remote session
 * died on start-up with "this cannot be the workspace: /home/<user>". A unit test
 * on `build_remote_command` would have caught it; this proves it in the window.
 *
 * Usage:
 *   node scripts/remote-workspace-e2e.mjs <cdpPort> <host> <user> <password> [dir]
 */

import { writeFileSync } from 'node:fs';

const [, , portArg = '9333', host, user, password, wantedDir] = process.argv;
if (!host || !user || !password) {
  console.error('usage: node scripts/remote-workspace-e2e.mjs <port> <host> <user> <password> [dir]');
  process.exit(2);
}
const port = Number(portArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every problem found, so one run reports all of them rather than the first. */
const problems = [];
const step = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ''}`);
};

/**
 * The remote directory this run chose, once step 3 has picked one.
 *
 * A module-level slot rather than a threaded argument, because it is read from
 * inside a `Runtime.evaluate` template where the only thing that matters is that
 * the *whole run* means one directory: the wait loop below has to find **this
 * run's** workspace among the saved ones, and a previous run's row is
 * indistinguishable from it by shape.
 */
let chosenRemotePath = null;
const remotePathWanted = () => chosenRemotePath;

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5178')) ?? targets[0];
  if (!page) throw new Error('no page target — is the app running with remote debugging?');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`exception: ${msg.params?.exceptionDetails?.exception?.description ?? ''}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(`console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) {
      const detail = r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text;
      throw new Error(`eval threw: ${detail}`);
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);

  // ---- 1. the app is up and exposes its store ----
  const ready = await evaluate(`(async () => {
    for (let i = 0; i < 60 && !window.__aigoStore; i += 1) await new Promise((r) => setTimeout(r, 100));
    const s = window.__aigoStore?.getState?.();
    return JSON.stringify({ store: !!s, hosted: '__TAURI_INTERNALS__' in window, keys: Object.keys(s ?? {}).length });
  })()`);
  const R = JSON.parse(ready ?? '{}');
  step('the window is up and the store is exposed', R.store === true, ready);
  step('the page is hosted by Tauri (IPC available)', R.hosted === true);
  if (!R.store || !R.hosted) throw new Error('cannot drive the wizard without the store and the bridge');

  // ---- 2. start from a clean slate ----
  //
  // **The harness clears the saved hosts and workspaces first, and this is not
  // tidiness.** Saved rows live in `localStorage`, which survives a restart, so
  // a run that reused whatever a previous run left behind would be asserting on
  // state this run did not create — and the "same directory twice" check below
  // would fail on a leftover row rather than on the dedupe rule it is about. A
  // test whose result depends on the order the suite was run in is not a test.
  //
  // `aigo.prefs` is removed as well as the in-memory rows, because the store
  // writes through to it on every mutation and would otherwise restore them.
  const cleared = await evaluate(`(() => {
    const s = window.__aigoStore.getState();
    for (const entry of [...s.remoteWorkspaces]) s.removeRemoteWorkspace(entry.id);
    for (const host of [...s.sshHosts]) s.removeSshHost(host.id);
    localStorage.removeItem('aigo.prefs');
    const after = window.__aigoStore.getState();
    return JSON.stringify({ hosts: after.sshHosts.length, workspaces: after.remoteWorkspaces.length });
  })()`);
  const CL = JSON.parse(cleared ?? '{}');
  step('the harness starts from no saved host or workspace', CL.hosts === 0 && CL.workspaces === 0, cleared);

  // ---- 3. the bridge actually answers: read ~/.ssh/config ----
  const aliases = await evaluate(`(async () => {
    const doc = await window.__TAURI_INTERNALS__.invoke('read_ssh_config');
    return JSON.stringify({ path: doc.path, exists: doc.exists, problem: doc.problem, hosts: doc.hosts.map((h) => h.alias) });
  })()`);
  const A = JSON.parse(aliases ?? '{}');
  step('read_ssh_config answers over the real bridge', typeof A.path === 'string', aliases);
  // This is the case-folding bug's visible symptom: a file full of Host blocks
  // reporting zero hosts. `tudouni` is in the user's own config.
  step(
    'the user\'s own Host blocks are listed (not silently dropped)',
    Array.isArray(A.hosts) && A.hosts.length > 0,
    `hosts=${JSON.stringify(A.hosts)}`,
  );

  // ---- 3. open the wizard from the sidebar's add menu ----
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('.lb-section-head button[aria-haspopup="menu"]')
      ?? document.querySelector('.lb-new button');
    if (!trigger) return 'no add-workspace trigger found';
    trigger.click();
    return 'clicked';
  })()`);
  step('the add-workspace menu opens', opened === 'clicked', String(opened));
  await sleep(500);

  const remoteItem = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.plus-item')];
    const remote = items.find((el) => /remote/i.test(el.textContent ?? ''));
    if (!remote) return 'no remote entry in the menu';
    remote.click();
    return 'clicked';
  })()`);
  step('the Remote entry opens the wizard', remoteItem === 'clicked', String(remoteItem));
  await sleep(900);

  // **The menu must be gone once it has been answered.** It is a Radix popover,
  // so it stays mounted until something closes it — and choosing "Remote" opens
  // a *dialog*, which left the popover floating over the sidebar as though it
  // were still waiting for the answer it had just been given. Found by looking
  // at a screenshot rather than by any assertion, which is why there is one now.
  const menuGone = await evaluate(`(() => {
    const menu = document.querySelector('.plus-menu');
    if (!menu) return 'gone';
    const box = menu.getBoundingClientRect();
    return 'still on screen at ' + Math.round(box.x) + ',' + Math.round(box.y);
  })()`);
  step('the add-workspace menu closes once an item is chosen', menuGone === 'gone', String(menuGone));

  const dialog = await evaluate(`(() => {
    const d = document.querySelector('.rw-dialog');
    if (!d) return JSON.stringify({ open: false });
    return JSON.stringify({
      open: true,
      step: d.getAttribute('data-step'),
      title: d.querySelector('.dialog-title')?.textContent ?? null,
      steps: [...d.querySelectorAll('.rw-step-name')].map((el) => el.textContent),
      hosts: [...d.querySelectorAll('.rw-host')].map((el) => el.textContent?.replace(/\\s+/g, ' ').trim()),
      hasManual: !!d.querySelector('.rw-new'),
    });
  })()`);
  const D = JSON.parse(dialog ?? '{}');
  step('the wizard opens on the host step', D.open === true && D.step === 'host', dialog);
  step('all three steps are named', Array.isArray(D.steps) && D.steps.length === 3, JSON.stringify(D.steps));
  step('the SSH config hosts are offered as choices', Array.isArray(D.hosts) && D.hosts.length > 0, JSON.stringify(D.hosts));

  // ---- 4. pick the target host from the list ----
  const picked = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.rw-host')];
    const target = rows.find((el) => (el.textContent ?? '').includes(${JSON.stringify(user)}));
    if (!target) return 'the target host is not in the list: ' + rows.map((r) => r.textContent).join(' | ');
    target.click();
    return 'clicked';
  })()`);
  step(`the host for ${user} is selectable`, picked === 'clicked', String(picked));
  await sleep(600);

  const onConnect = await evaluate(`(() => {
    const d = document.querySelector('.rw-dialog');
    return JSON.stringify({
      step: d?.getAttribute('data-step'),
      // The address actually being dialled, as the wizard states it.
      target: d?.querySelector('.rw-target')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      hasPassword: !!d?.querySelector('input[type="password"]'),
    });
  })()`);
  const C = JSON.parse(onConnect ?? '{}');
  step('picking a host moves to the connect step', C.step === 'connect', onConnect);
  step('the wizard states which host it will dial', typeof C.target === 'string' && C.target.includes(host), String(C.target));
  step('a password field is offered', C.hasPassword === true);

  // ---- 5. type the password and connect ----
  await evaluate(`(() => {
    const input = document.querySelector('.rw-dialog input[type="password"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(password)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);

  const connectClicked = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.rw-dialog .dialog-foot button')];
    const go = btns.find((b) => /connect/i.test(b.textContent ?? ''));
    if (!go) return 'no Connect button';
    if (go.disabled) return 'the Connect button is disabled';
    go.click();
    return 'clicked';
  })()`);
  step('the Connect button is pressable', connectClicked === 'clicked', String(connectClicked));

  // The dial plus the probes plus the listing: give it real time.
  let workspaceStep = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    workspaceStep = await evaluate(`(() => {
      const d = document.querySelector('.rw-dialog');
      return JSON.stringify({
        step: d?.getAttribute('data-step'),
        problem: d?.querySelector('.rw-note.is-bad')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      });
    })()`);
    const W = JSON.parse(workspaceStep ?? '{}');
    if (W.step === 'workspace' || W.problem) break;
  }
  const W0 = JSON.parse(workspaceStep ?? '{}');
  step('connecting to the real host succeeds', W0.step === 'workspace', `step=${W0.step} problem=${W0.problem}`);

  if (W0.step !== 'workspace') {
    console.log('\n--- could not reach the workspace step; stopping here ---');
    console.log('console errors:', consoleErrors.slice(0, 8));
    ws.close();
    process.exit(1);
  }

  // ---- 6. what the far end reported ----
  const facts = await evaluate(`(() => {
    const d = document.querySelector('.rw-dialog');
    return JSON.stringify({
      facts: [...d.querySelectorAll('.rw-facts .fact')].map((el) => el.textContent?.replace(/\\s+/g, ' ').trim()),
      path: d.querySelector('.rw-path')?.textContent?.trim() ?? null,
      dirs: [...d.querySelectorAll('.rw-dir-name')].map((el) => el.textContent),
      willUse: d.querySelector('.rw-note.is-ok')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      cannotUse: d.querySelector('.rw-note.is-warn')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      platformProblem: [...d.querySelectorAll('.rw-note.is-bad')].map((el) => el.textContent?.replace(/\\s+/g, ' ').trim()),
      openLabel: [...d.querySelectorAll('.dialog-foot button')].map((b) => ({ label: b.textContent?.trim(), disabled: b.disabled })),
    });
  })()`);
  const F = JSON.parse(facts ?? '{}');
  console.log('   facts:', JSON.stringify(F.facts));
  console.log('   home :', F.path, ' dirs:', JSON.stringify(F.dirs));
  step('the remote home directory is reported', typeof F.path === 'string' && F.path.startsWith('/'), String(F.path));
  step('the platform is reported as a fact', Array.isArray(F.facts) && F.facts.some((f) => /linux/i.test(f)), JSON.stringify(F.facts));
  step('the far end\'s real directories are listed', Array.isArray(F.dirs) && F.dirs.length > 0, JSON.stringify(F.dirs));
  step(
    'the home directory is refused as a workspace, with a reason',
    typeof F.cannotUse === 'string' && F.cannotUse.length > 0,
    String(F.cannotUse),
  );

  // ---- 7. browse into a real project directory ----
  const wanted = wantedDir ?? F.dirs?.[0];
  const browsed = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.rw-dir')];
    const target = rows.find((el) => (el.querySelector('.rw-dir-name')?.textContent ?? '') === ${JSON.stringify(wanted)});
    if (!target) return 'not listed: ' + rows.map((r) => r.querySelector('.rw-dir-name')?.textContent).join(',');
    target.click();
    return 'clicked';
  })()`);
  step(`browsing into ${wanted} works`, browsed === 'clicked', String(browsed));
  await sleep(3000);

  const afterBrowse = await evaluate(`(() => {
    const d = document.querySelector('.rw-dialog');
    return JSON.stringify({
      path: d.querySelector('.rw-path')?.textContent?.trim() ?? null,
      note: d.querySelector('.rw-note.is-ok')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      problem: d.querySelector('.rw-note.is-warn')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
      dirs: [...d.querySelectorAll('.rw-dir-name')].map((el) => el.textContent),
    });
  })()`);
  const B = JSON.parse(afterBrowse ?? '{}');
  console.log('   now at:', B.path, ' dirs:', JSON.stringify(B.dirs));
  step('the browser moved into the chosen directory', typeof B.path === 'string' && B.path.endsWith(`/${wanted}`), String(B.path));
  step('the chosen directory is accepted as a workspace', typeof B.note === 'string' && B.note.includes(B.path), String(B.note));
  // Record it, so the wait after the open can find **this** run's workspace row
  // among however many earlier runs left behind.
  chosenRemotePath = B.path;

  // ---- 8. open it: save + install + connect ----
  const opened1 = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.rw-dialog .dialog-foot button')];
    const go = btns.find((b) => /open|install/i.test(b.textContent ?? ''));
    if (!go) return 'no open button';
    if (go.disabled) return 'the open button is disabled';
    const label = go.textContent.trim();
    go.click();
    return 'clicked:' + label;
  })()`);
  step('the Open button is pressable', String(opened1).startsWith('clicked'), String(opened1));
  console.log('   open button said:', opened1);

  // The install uploads a ~9MB archive over SFTP plus the session handshake.
  //
  // **Every wait below is scoped to the workspace this run just created.** A
  // previous run's session can still be live and `ready`, and a loop that merely
  // asked "is some session ready" would break on that one and then report a
  // mid-transition snapshot of *this* open as a failure — the config answer's
  // SFTP write is still in flight at that moment, so the prompt is legitimately
  // still up. Multi-session is a feature; the harness has to say which session it
  // means.
  const wantedWorkspaceId = JSON.parse(await evaluate(`(() => {
    const s = window.__aigoStore.getState();
    const mine = s.remoteWorkspaces.find((w) => w.remotePath === ${JSON.stringify(remotePathWanted())});
    return JSON.stringify({ id: mine?.id ?? null });
  })()`)).id;
  console.log('   waiting on workspace id:', wantedWorkspaceId);

  // **A config-sync prompt may legitimately appear here, and answering it is
  // part of the flow rather than a failure.** A fresh remote account has a
  // `config.json` with no usable route, so the wizard's own connect step
  // reports "no model configured yet"; when the workspace is then opened the
  // saved host's policy is `ask` and both sides have changed, so the app asks
  // which config wins *before* connecting. That ordering is the fix — the
  // session used to start against the remote file and die with exit code 2
  // while the question was still on screen.
  let sessionState = null;
  let answeredSync = false;
  for (let i = 0; i < 180; i += 1) {
    await sleep(2000);

    // Answer the config prompt once, the way a person would: send the local
    // configuration (which has real routes) to the remote host.
    if (!answeredSync) {
      const promptUp = await evaluate(`(() => {
        const d = [...document.querySelectorAll('.dialog')].find((el) =>
          /configuration conflict/i.test(el.querySelector('.dialog-title')?.textContent ?? ''));
        if (!d) return 'none';
        const btns = [...d.querySelectorAll('.dialog-foot button')];
        const local = btns.find((b) => /use local/i.test(b.textContent ?? ''));
        if (!local || local.disabled) return 'no usable answer: ' + btns.map((b) => b.textContent + ':' + b.disabled).join(',');
        local.click();
        return 'answered';
      })()`);
      if (promptUp === 'answered') {
        answeredSync = true;
        console.log('   answered the config-sync prompt with "Use local"');
      }
    }

    sessionState = await evaluate(`(() => {
      const s = window.__aigoStore.getState();
      const target = ${JSON.stringify(wantedWorkspaceId)};
      const rw = s.remoteWorkspaces.find((w) => w.id === target) ?? s.remoteWorkspaces[s.remoteWorkspaces.length - 1];
      // **This run's own session**, found by its workspace id rather than by
      // whichever key happens to be active.
      const key = s.order.find((k) => s.sessions[k]?.remoteWorkspaceId === rw?.id && s.sessions[k]?.ready) ??
        s.order.find((k) => s.sessions[k]?.remoteWorkspaceId === rw?.id) ?? s.activeKey;
      const rt = key ? s.sessions[key] : null;
      return JSON.stringify({
        dialogOpen: !!document.querySelector('.rw-dialog'),
        syncPrompt: s.configSyncPrompt !== null,
        pendingOpen: s.pendingRemoteOpen ?? null,
        workspaces: (s.remoteWorkspaces ?? []).map((w) => ({ id: w.id, path: w.remotePath, binary: w.remoteBinary, label: w.label })),
        hosts: (s.sshHosts ?? []).map((h) => ({ label: h.label, host: h.host, user: h.user, hasPassword: !!h.password })),
        install: rw ? s.installStatus?.[rw.id] ?? null : null,
        activeKey: key,
        ready: rt?.ready ?? null,
        phase: rt?.connection?.phase ?? null,
        problem: rt?.connection?.problem ?? null,
        workspace: rt?.workspace ?? null,
        sessionProblem: rt?.problem ?? null,
        samePath: rt?.workspace === rw?.remotePath,
      });
    })()`);
    const S = JSON.parse(sessionState ?? '{}');
    // Break only when **this** workspace's session is ready, or when this one has
    // genuinely failed — never because a different session is healthy.
    if (S.ready === true || (S.problem && !S.syncPrompt) || (S.sessionProblem && !S.syncPrompt)) break;
  }
  const S = JSON.parse(sessionState ?? '{}');
  console.log('   session state:', JSON.stringify(S, null, 2).slice(0, 1400));

  step('the wizard closed after opening', S.dialogOpen === false);
  step('the host was saved to the store', Array.isArray(S.hosts) && S.hosts.length > 0, JSON.stringify(S.hosts));
  step('the workspace was saved to the store', Array.isArray(S.workspaces) && S.workspaces.length > 0, JSON.stringify(S.workspaces));
  // **Exactly one row for the directory this run chose.** Counted among rows
  // matching this run's path rather than among all rows, because the harness may
  // have saved others on earlier runs and this is a statement about what one add
  // does. `addRemoteWorkspace` dedupes on the (hostId, remotePath) pair — the same
  // rule `addWorkspace` applies locally — and `tests/remote-workspace.test.ts`
  // drives that rule directly over two adds.
  const mine = (S.workspaces ?? []).filter((w) => w.path === S.workspace);
  step(
    'one add produces exactly one workspace row for that directory',
    mine.length === 1,
    `${mine.length} row(s) for ${S.workspace} out of ${S.workspaces?.length}: ${JSON.stringify(S.workspaces?.map((w) => w.path))}`,
  );
  step(
    'the Runtime was installed and its path recorded',
    S.workspaces?.[0]?.binary && S.workspaces[0].binary.length > 0,
    String(S.workspaces?.[0]?.binary),
  );
  // The config-sync question is raised **only when a decision is genuinely
  // needed**: the host's policy is `ask` (the default) and both sides have
  // changed since the last synced baseline. A host already synced once has a
  // recorded baseline, so a second run finds nothing to ask about — and that is
  // the feature working, not a missing step. So this asserts the *invariant*
  // rather than insisting a prompt always appears: whatever happened, no prompt
  // is left on screen and nothing is left parked waiting to resume.
  step(
    'no config question is left open, and nothing is left waiting to resume',
    S.syncPrompt === false && S.pendingOpen === null,
    `answered=${answeredSync} promptUp=${S.syncPrompt} pending=${S.pendingOpen}`,
  );
  console.log(`   config-sync prompt: ${answeredSync ? 'raised and answered' : 'not needed (baseline already agreed)'}`);
  step('the remote session reached ready', S.ready === true, `phase=${S.phase} problem=${S.problem ?? S.sessionProblem}`);

  // **The bug this whole exercise exists for.** A remote session that came up in
  // the home directory is a session that came up somewhere nobody chose — and
  // because the runtime refuses home as a workspace, it died rather than moved.
  step(
    'the session is running in the directory that was chosen',
    S.samePath === true,
    `runtime reports workspace=${S.workspace} wanted=${S.workspaces?.[0]?.path}`,
  );
  // ---- 9. and it is a real session: the runtime answered the protocol ----
  if (S.ready === true) {
    const live = await evaluate(`(() => {
      const s = window.__aigoStore.getState();
      const rt = s.sessions[s.activeKey];
      return JSON.stringify({
        sessionId: rt?.sessionId ?? null,
        model: rt?.model ?? null,
        uiState: !!rt?.uiState,
        // The file capability runs on the far end, so this is the remote
        // filesystem being listed through the session.
        workspace: rt?.workspace ?? null,
      });
    })()`);
    const L = JSON.parse(live ?? '{}');
    console.log('   live session:', live);
    step('the runtime completed its handshake (session id present)', typeof L.sessionId === 'string' && L.sessionId.length > 0, String(L.sessionId));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const shotData = shot.result?.data;
  if (shotData) {
    writeFileSync('remote-workspace-e2e.png', Buffer.from(shotData, 'base64'));
    console.log('\nwrote remote-workspace-e2e.png');
  } else {
    console.log('\nscreenshot unavailable (page busy); skipping');
  }

  step('no uncaught exceptions or console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

  ws.close();
  console.log(`\n=== ${problems.length === 0 ? 'ALL CHECKS PASSED' : `${problems.length} FAILURE(S)`} ===`);
  for (const p of problems) console.log('  ✖', p);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
