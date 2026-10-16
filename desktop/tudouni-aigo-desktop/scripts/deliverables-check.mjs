/**
 * The declared-deliverable check: the `present` path, end to end and on screen.
 *
 * Two halves, and they answer different questions.
 *
 * **1. The runtime half**, against the **real** binary: a mock gateway scripts
 * the model into calling `present`, and the run is driven the way the bridge
 * drives it. What it proves is the chain no unit test can — the tool resolves a
 * path through the workspace boundary, the declaration reaches the tool result's
 * audit record, and the audit record reaches the wire with `deliverables` intact
 * and the file's **contents** nowhere in it.
 *
 * It checks the refusal too, because that is the half a passing test hides: a
 * declaration pointing outside the workspace must come back as a failed call with
 * no `deliverables` field at all, not as a card the runtime never meant to make.
 *
 * **2. The screen half**, in a real browser against a production bundle: the
 * scripted `tool_result` is fed to the running store and the card is asserted by
 * measuring the DOM — the file name, the model's note, the fallback to the kind,
 * the error line after a refused open, and a screenshot per theme. Type checking
 * cannot see a card that renders zero-height, and "it compiled" is not evidence
 * that a person can read it.
 *
 * Usage (the browser must already be up with a debug port; see `shot.mjs`):
 *
 *   node scripts/deliverables-check.mjs <binary> [url] [cdpPort]
 *
 * With no `url` it runs only the runtime half — which is the useful default when
 * no dev server or preview server is running.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '..', '..');

/**
 * The scratch workspace, **inside the repository**.
 *
 * Not `os.tmpdir()`, and the reason is worth writing down because it looks like
 * a preference and is not one: the runtime makes `<cwd>/.tudouni` before it says
 * anything at all (`runtime.Boot`), so a workspace the child cannot write to is
 * a child that exits 2 with no `init` and one line on stderr. In a sandboxed
 * shell that is exactly what a temp directory is — `mkdir` there fails for the
 * Go process while succeeding for PowerShell, which is the kind of asymmetry
 * that costs an afternoon if it is not written down in the place that depends on
 * it. `/.e2e/` is already the end-to-end harness's directory and is gitignored.
 */
const scratchBase = join(repo, '.e2e');

const binary = process.argv[2];
const url = process.argv[3] ?? '';
const cdpPort = Number(process.argv[4] ?? 9333);
if (!binary) {
  console.error('usage: node scripts/deliverables-check.mjs <binary> [url] [cdpPort]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   1. the runtime half
   ============================================================ */

/**
 * A mock gateway that scripts one `present` call, then answers.
 *
 * Deliberately not `scripts/mock_gateway.py`: that one is shared with the Go
 * side's own end-to-end story and answers `read_file`, and the point here is the
 * argument shape. Two requests, in order: the tool call, then the closing text.
 */
function mockGateway() {
  let n = 0;
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const stream = /"stream"\s*:\s*true/.test(body);
      n += 1;
      const message =
        n === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_present',
                  type: 'function',
                  function: {
                    name: 'present',
                    arguments: JSON.stringify({
                      files: [
                        { path: 'report.md', description: 'Performance report' },
                        { path: 'out/summary.csv' },
                      ],
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'Declared both files.' };
      const payload = {
        choices: [{ message }],
        usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } },
      };

      if (!stream) {
        const raw = JSON.stringify(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (message.content) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: message.content } }] })}\n\n`);
      }
      for (const call of message.tool_calls ?? []) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.function.name } }] } },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] } }],
          })}\n\n`,
        );
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: payload.usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

async function runtimeHalf() {
  const scratch = join(scratchBase, 'deliverables');
  rmSync(scratch, { recursive: true, force: true });
  const workspace = join(scratch, 'workspace');
  mkdirSync(join(workspace, 'out'), { recursive: true });
  writeFileSync(join(workspace, 'report.md'), '# Report\n\nsome content\n');
  writeFileSync(join(workspace, 'out', 'summary.csv'), 'a,b\n1,2\n');
  // A file that exists **outside** the workspace, for the refusal half.
  const outside = join(scratch, 'outside.md');
  writeFileSync(outside, 'not yours\n');

  const gateway = mockGateway();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const gatewayPort = gateway.address().port;

  const config = join(scratch, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      providers: {
        mock: {
          base_url: `http://127.0.0.1:${gatewayPort}/v1`,
          api_key: 'sk-mock',
          models: [{ id: 'mock-model' }],
        },
      },
    }),
  );

  const child = spawn(binary, ['--runtime-stdio'], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_CONFIG_FILE: config },
  });
  child.stderr.on('data', () => {});

  const decoded = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      decoded.push(JSON.parse(line));
    } catch {
      // Prose on stdout is the flag package's usage text; not this check's subject.
    }
  });

  const deadline = Date.now() + 60000;
  const waitFor = async (predicate, what) => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  try {
    await waitFor(() => decoded.some((m) => m.t === 'init'), 'the handshake');
    const init = decoded.find((m) => m.t === 'init');
    assert.ok(
      init.tools.some((t) => t.name === 'present'),
      'present is not in the tool set the runtime advertises',
    );
    console.log(`  handshake: protocol ${init.protocol}, ${init.tools.length} tools, present registered`);

    // ---- the happy path ----
    child.stdin.write(`${JSON.stringify({ v: 1, t: 'user_message', text: 'finish the report' })}\n`);
    await waitFor(
      () => decoded.some((m) => m.t === 'event' && m.kind === 'tool_result'),
      'the present tool result',
    );

    const result = decoded.find((m) => m.t === 'event' && m.kind === 'tool_result');
    assert.equal(result.tool, 'present', `the first tool result is ${result.tool}, not present`);
    assert.equal(result.status, 'ok', `present came back ${result.status}: ${result.preview}`);
    assert.ok(Array.isArray(result.deliverables), 'the tool result carries no deliverables array');
    assert.equal(result.deliverables.length, 2, `declared ${result.deliverables.length} files, expected 2`);
    assert.deepEqual(
      result.deliverables.map((f) => f.path),
      ['report.md', 'out/summary.csv'],
      'the declared paths and their order',
    );
    assert.equal(result.deliverables[0].description, 'Performance report');
    assert.ok(
      result.deliverables[1].description === undefined || result.deliverables[1].description === '',
      'a file declared without a description must not gain one',
    );

    // **The invariant the whole capability rests on.** The report's own text must
    // not be anywhere in the result: what travels is a path, and a `preview` or a
    // size carrying the body would be the copy this tool exists to avoid.
    const asText = JSON.stringify(result);
    assert.ok(
      !asText.includes('some content'),
      'the declared file\'s contents reached the protocol — the declaration must carry paths only',
    );
    console.log(
      `  present ok: ${result.deliverables.map((f) => f.path).join(', ')} — ` +
        `${asText.length} bytes of tool result, no file body`,
    );

    await waitFor(
      () => decoded.some((m) => m.t === 'ui' && m.kind === 'run_finished'),
      'the turn to finish',
    );
    console.log('  turn finished');

    // ---- the refusal ----
    //
    // A second turn, this time declaring a path outside the workspace. The mock
    // answers every first request with the same arguments, so this drives a fresh
    // child rather than reusing the one above: the scripted gateway is stateless
    // between runs and that keeps the two halves independent.
    const refused = await refusalRun({ binary, workspace, config, outside });
    assert.equal(refused.status, 'error', `an out-of-workspace path came back ${refused.status}`);
    assert.ok(
      refused.deliverables === undefined,
      'a refused declaration still carried a deliverables field',
    );
    // The refusal must **say which rule it broke**, not just that something went
    // wrong: "cannot present" with no reason is retried unchanged, and the model
    // has no way to learn that the path was the problem.
    assert.ok(
      /escap\w* workspace|outside the workspace/i.test(refused.preview ?? ''),
      `the refusal does not name the rule: ${refused.preview}`,
    );
    console.log(`  refusal: ${refused.preview}`);
  } finally {
    child.stdin.write('{"v":1,"t":"shutdown"}\n');
    await sleep(600);
    child.kill();
    gateway.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** One child, one turn, declaring a path outside the workspace. */
async function refusalRun({ binary, workspace, config, outside }) {
  // A server of its own rather than a patched copy of the factory above: the two
  // runs differ in their arguments and in nothing else, and re-registering a
  // handler on a live server is the kind of cleverness that leaves one listener
  // behind and makes the next run answer twice.
  const gateway = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const stream = /"stream"\s*:\s*true/.test(body);
      const payload = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_present',
                  type: 'function',
                  function: {
                    name: 'present',
                    arguments: JSON.stringify({ files: [{ path: outside }] }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      };
      if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const call = payload.choices[0].message.tool_calls[0];
      res.write(
        `data: ${JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.function.name } }] } },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] } }],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [], usage: payload.usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const port = gateway.address().port;
  writeFileSync(
    config,
    JSON.stringify({
      providers: {
        mock: {
          base_url: `http://127.0.0.1:${port}/v1`,
          api_key: 'sk-mock',
          models: [{ id: 'mock-model' }],
        },
      },
    }),
  );

  const child = spawn(binary, ['--runtime-stdio'], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_CONFIG_FILE: config },
  });
  let refusalStderr = '';
  child.stderr.on('data', (chunk) => {
    refusalStderr += chunk;
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) refusalStderr += `\n[child exited ${code}]`;
  });
  const decoded = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      decoded.push(JSON.parse(line));
    } catch {
      /* usage text */
    }
  });

  const deadline = Date.now() + 60000;
  try {
    child.stdin.write(`${JSON.stringify({ v: 1, t: 'user_message', text: 'declare it' })}\n`);
    while (Date.now() < deadline && !decoded.some((m) => m.kind === 'tool_result')) await sleep(100);
    const result = decoded.find((m) => m.t === 'event' && m.kind === 'tool_result');
    assert.ok(
      result,
      `the refusal produced no tool result at all.\n  decoded: ${decoded.map((m) => m.t + (m.kind ? `(${m.kind})` : '')).join(', ')}\n  stderr: ${refusalStderr.slice(-600)}`,
    );
    return result;
  } finally {
    child.stdin.write('{"v":1,"t":"shutdown"}\n');
    await sleep(400);
    child.kill();
    gateway.close();
  }
}

/* ============================================================
   2. the screen half
   ============================================================ */

async function screenHalf() {
  const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, {
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
      problems.push(`console.error: ${(msg.params.args ?? []).map((a) => a.value).join(' ')}`);
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
      throw new Error(
        `eval threw: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`,
      );
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

  try {
    for (const scheme of ['dark', 'light']) {
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await send('Page.navigate', { url });
      await sleep(2500);

      const ready = await evaluate(`(async () => {
        for (let i = 0; i < 100 && !window.__aigoStore; i += 1) await new Promise((r) => setTimeout(r, 100));
        return typeof window.__aigoStore?.getState === 'function';
      })()`);
      assert.ok(ready, 'the app did not expose its store — dev server without DEV, or no VITE_PERF_HARNESS build?');

      // ---- feed the card the real event shape the runtime emitted ----
      const seeded = await evaluate(`(() => {
        const store = window.__aigoStore;
        const createBucket = window.__aigoCreateBucket;
        const key = 'k-deliverables';
        const workspace = 'C:/work/project';
        const bucket = createBucket(key, workspace, { ericai: false, maxSteps: null });
        store.setState((s) => ({ sessions: { ...s.sessions, [key]: bucket }, activeKey: key, order: [key] }));
        const apply = (m) => store.getState().applyRuntimeMessage(key, m);
        apply({ v: 1, t: 'init', protocol: 5, session_id: 's-deliv', resumed: false,
                model: 'mock-model', provider: 'mock', thinking: true, effort: 'high',
                effort_levels: ['low', 'high'], model_catalog: { models: [], aliases: [] },
                workspace, max_steps: 120, stream: true, context_tokens: 65536,
                tools: [{ name: 'present', risk: 'low', parallel_safe: false, interactive: false,
                          external: false, disposition: 'auto', granted: false, command: null }],
                permissions: {}, audit_path: '', notices: [] });
        apply({ v: 1, t: 'event', kind: 'run_started', session_id: 's-deliv', run_id: 'r1', step: 0, ts: '' });
        apply({ v: 1, t: 'event', kind: 'model_call', session_id: 's-deliv', run_id: 'r1', step: 0,
                status: 'ok', duration_ms: 900, prompt_tokens: 1200, cached_tokens: 0, completion_tokens: 40 });
        apply({ v: 1, t: 'event', kind: 'tool_call', session_id: 's-deliv', run_id: 'r1', step: 0,
                tool: 'present', call_id: 'c1', tool_index: 0,
                arguments: '{"files":[{"path":"docs/report.md","description":"Performance report"},{"path":"out/summary.csv"},{"path":"paper.docx"}]}' });
        // **The shape the runtime actually sent**, copied from the run above: the
        // card is only as good as this payload, and a payload softened here would
        // make the check pass on a wire nobody produces.
        apply({ v: 1, t: 'event', kind: 'tool_result', session_id: 's-deliv', run_id: 'r1', step: 0,
                tool: 'present', call_id: 'c1', tool_index: 0, status: 'ok', chars: 120, duration_ms: 2,
                preview: 'Presented docs/report.md',
                deliverables: [
                  { path: 'docs/report.md', description: 'Performance report' },
                  { path: 'out/summary.csv' },
                  { path: 'paper.docx', description: 'The paper (final) (v3)' } ] });
        apply({ v: 1, t: 'ui', kind: 'run_finished', session_id: 's-deliv', run_id: 'r1',
                answer: 'Both files are ready.', duration_ms: 1200 });
        return true;
      })()`);
      assert.ok(seeded, 'the payloads were not accepted');

      await sleep(400);
      const measured = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.dl-card')];
        const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
        const byName = {};
        for (const card of cards) {
          const name = card.querySelector('.dl-name')?.textContent ?? '';
          const noteEl = card.querySelector('.dl-note');
          const open = card.querySelector('.dl-open');
          const style = getComputedStyle(card);
          byName[name] = {
            note: noteEl?.textContent ?? null,
            hasOpen: !!open,
            openLabel: open?.getAttribute('aria-label') ?? null,
            box: rect(card),
            radius: style.borderRadius,
            background: style.backgroundColor,
          };
        }
        const list = document.querySelector('.dl-list');
        const row = document.querySelector('.e-tool.has-deliverables');
        return JSON.stringify({
          count: cards.length,
          cards: byName,
          listBox: list ? rect(list) : null,
          rowBox: row ? rect(row) : null,
          rowAccent: row ? getComputedStyle(row).borderColor : null,
          groupLabel: list?.getAttribute('aria-label') ?? null,
          // The tool row's own head must still be there: the cards are the
          // result, not a replacement for the call.
          toolName: document.querySelector('.e-tool .et-name')?.textContent ?? null,
        });
      })()`);
      const m = JSON.parse(measured);

      assert.equal(m.count, 3, `rendered ${m.count} cards, expected 3`);
      // The name is the basename; the title carries the whole path.
      assert.ok(m.cards['report.md'], 'the report card is missing');
      assert.equal(m.cards['report.md'].note, 'Performance report', "the model's note is not shown");
      // A declaration with no description falls back to the **kind**, not to an
      // empty line: a blank note reads as a rendering bug.
      assert.equal(m.cards['summary.csv'].note, 'Spreadsheet', 'the kind fallback is missing');
      // **The model's sentence, byte for byte.** Not reworded, not trimmed of a
      // trailing parenthetical — DSH strips one and this front end does not, and
      // that is a decision rather than an omission: the rule here is that text
      // the runtime or the model wrote is displayed as written, and trimming it
      // would be this window editing the model on its way to the screen. The
      // assertion pins that, so "helpfully" tidying it later fails a check
      // instead of passing unnoticed.
      assert.equal(
        m.cards['paper.docx'].note,
        'The paper (final) (v3)',
        "the model's note must be shown verbatim",
      );
      assert.ok(m.cards['report.md'].hasOpen, 'the card has no open control');
      assert.match(m.cards['report.md'].openLabel, /report\.md/, 'the open control does not name the file');
      assert.equal(m.groupLabel, 'Delivered files');
      assert.equal(m.toolName, 'present', 'the tool row lost its own name');

      // A card that renders but is invisible is the failure a screenshot alone
      // cannot distinguish from a missing one, so the geometry is asserted.
      for (const [name, card] of Object.entries(m.cards)) {
        assert.ok(card.box.w > 200, `${name} is ${card.box.w}px wide — it did not lay out`);
        assert.ok(card.box.h >= 40, `${name} is ${card.box.h}px tall — it did not lay out`);
      }
      assert.ok(m.listBox.w > 400, 'the card group is narrower than a card');
      // The delivered row is lifted to the accent, which is the whole reason the
      // class exists.
      assert.ok(m.rowBox, 'the tool row lost the has-deliverables class');

      console.log(
        `  ${scheme}: ${m.count} cards, ${m.cards['report.md'].box.w}x${m.cards['report.md'].box.h}px, ` +
          `notes ${Object.values(m.cards).map((c) => JSON.stringify(c.note)).join(' ')}`,
      );

      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const out = join(root, `render-check-deliverables-${scheme}.png`);
      writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      console.log(`  ${scheme}: wrote ${out}`);
    }

    // ---- the failure state: a refused open keeps its sentence on the card ----
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    const failed = await evaluate(`(() => {
      // Tauri is absent in a plain browser, so the open control's own path throws
      // here — which is exactly the state a person sees when the OS refuses.
      const open = document.querySelector('.dl-open');
      if (!open) return 'no open control';
      open.click();
      return 'clicked';
    })()`);
    assert.equal(failed, 'clicked');
    await sleep(600);
    const afterFail = await evaluate(`(() => {
      const note = document.querySelector('.dl-note');
      return JSON.stringify({
        text: note?.textContent ?? null,
        isError: note?.hasAttribute('data-error') ?? false,
        hasDismiss: !!document.querySelector('.dl-dismiss'),
      });
    })()`);
    const f = JSON.parse(afterFail);
    assert.ok(f.isError, 'a failed open did not mark the note as an error');
    assert.ok(f.text && f.text.length > 0, 'a failed open left no sentence on the card');
    assert.ok(f.hasDismiss, 'a failed open offered no way to dismiss it');
    // **A sentence for a person, not for whoever wrote this file.** This check
    // exists because the first run showed `TypeError: Cannot read properties of
    // undefined (reading 'invoke')` on the card — true, useless, and the reason
    // the "is there a host at all" question is now asked before the IPC call
    // rather than read off its wreckage.
    assert.ok(
      !/TypeError|undefined|invoke|__TAURI/i.test(f.text),
      `the card is showing a diagnostic instead of a sentence: ${f.text}`,
    );
    console.log(`  failed open: ${f.text.slice(0, 90)}`);

    const failShot = await send('Page.captureScreenshot', { format: 'png' });
    const failOut = join(root, 'render-check-deliverables-error.png');
    writeFileSync(failOut, Buffer.from(failShot.result.data, 'base64'));
    console.log(`  error state: wrote ${failOut}`);

    if (problems.length > 0) {
      throw new Error(`the page reported problems:\n  ${problems.join('\n  ')}`);
    }
  } finally {
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${created.id}`).catch(() => {});
    ws.close();
  }
}

/* ============================================================ */

console.log(`binary: ${binary}`);
console.log('');
console.log('runtime: the present chain, against the real binary');
await runtimeHalf();

if (url === '') {
  console.log('');
  console.log('screen: skipped (no url given)');
} else {
  console.log('');
  console.log(`screen: the card in a browser at ${url}`);
  await screenHalf();
}

console.log('');
console.log('PASS');
