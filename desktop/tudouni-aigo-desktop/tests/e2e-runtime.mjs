/**
 * End-to-end check against the **real** Go runtime.
 *
 * This is the one verification that cannot be faked: it starts
 * `tudouni-aigo --runtime-stdio` exactly the way the Rust bridge does, feeds it
 * lines, and decodes the answers with the same decoder the UI uses.
 *
 * What it proves, in order:
 *   - the child starts with `--runtime-stdio` and the workspace as its cwd;
 *   - the opening triple is `init` -> `session_load` -> `ui(state)`;
 *   - every line decodes through `decodeLine`, i.e. the protocol shapes the UI
 *     expects are the ones the runtime actually sends;
 *   - `shutdown` is honoured and the exit code is 0.
 *
 * Usage:
 *   node tests/e2e-runtime.mjs <path-to-binary> <workspace>
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const binary = process.argv[2];
const workspace = process.argv[3];
if (!binary || !workspace) {
  console.error('usage: node tests/e2e-runtime.mjs <binary> <workspace>');
  process.exit(2);
}

// Bundle the decoder so this script exercises the same code the UI does.
const outDir = resolve(root, '.test-build');
mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [resolve(here, 'e2e-decode-entry.ts')],
  outfile: resolve(outDir, 'decode.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@': resolve(root, 'src') },
  define: { __DESKTOP_VERSION__: JSON.stringify('0.1.0') },
  logLevel: 'warning',
});
const { decodeLine, PROTOCOL_VERSION } = await import(
  `file://${resolve(outDir, 'decode.mjs').replace(/\\/g, '/')}`
);

console.log(`binary:    ${binary}`);
console.log(`workspace: ${workspace}`);
console.log('');

const child = spawn(binary, ['--runtime-stdio'], {
  cwd: workspace,
  stdio: ['pipe', 'pipe', 'pipe'],
});

// stderr is drained and discarded, exactly as the bridge does: `null` would give
// the child a closed descriptor, and inheriting it would put diagnostics where a
// GUI cannot show them.
let stderrLines = 0;
child.stderr.on('data', () => {
  stderrLines += 1;
});

const seen = [];
const decoded = [];
const failures = [];
let exited = null;

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  seen.push(line);
  const result = decodeLine(line);
  if (result.msg === null) {
    // Prose on stdout is expected in one case: a bad flag makes the flag package
    // print usage there. Anything else is a shape we do not know.
    if (result.reason !== 'unparseable') failures.push(result.reason);
    return;
  }
  decoded.push(result.msg);
});

child.on('exit', (code) => {
  exited = code;
});

const deadline = Date.now() + 30000;
const waitFor = async (predicate, what) => {
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

try {
  // ---- the opening triple ----
  await waitFor(() => decoded.length >= 3 || exited !== null, 'the handshake');

  const types = decoded.slice(0, 3).map((m) => (m.t === 'ui' ? `ui(${m.kind})` : m.t));
  console.log(`opening triple: ${types.join(' -> ')}`);
  assert.deepEqual(
    types,
    ['init', 'session_load', 'ui(state)'],
    'the handshake is init -> session_load -> ui(state)',
  );

  // ---- init ----
  const init = decoded[0];
  assert.equal(init.v, 1, 'the envelope version is 1');
  // **Compared against the front end's own constant, never a literal here.**
  // This line used to read `assert.equal(init.protocol, 3)` while
  // `src/protocol/types.ts` declared 4 — two declarations of one fact, each with
  // a test backing it, and the one that was wrong was the one nobody ran. Any
  // second literal reintroduces exactly that.
  assert.equal(
    init.protocol,
    PROTOCOL_VERSION,
    `the runtime's conversation protocol is the one this front end declares (${PROTOCOL_VERSION})`,
  );
  for (const key of [
    'session_id',
    'resumed',
    'model',
    'workspace',
    'max_steps',
    'stream',
    'tools',
    'permissions',
    'audit_path',
    'notices',
  ]) {
    assert.ok(key in init, `init.${key} must be present`);
  }
  assert.ok(Array.isArray(init.tools), 'init.tools is an array');
  assert.ok(Array.isArray(init.effort_levels), 'init.effort_levels is a string[]');
  assert.equal(typeof init.permissions, 'object', 'init.permissions is an object');
  // Only non-default entries: an ordinary run sends none.
  console.log(
    `init: model=${init.model} provider=${init.provider} effort=${init.effort} ` +
      `levels=[${init.effort_levels.join(',')}] tools=${init.tools.length} ` +
      `context_tokens=${init.context_tokens} notices=${init.notices.length}`,
  );
  console.log(`      permissions=${JSON.stringify(init.permissions)}`);

  // The UI's contract: no product version, no locale, no user name, no themes.
  for (const absent of ['version', 'locale', 'user_name', 'themes']) {
    assert.equal(absent in init, false, `init must not carry ${absent}`);
  }

  // ---- ui(state) ----
  const state = decoded[2];
  for (const key of [
    'todos',
    'skills',
    'jobs',
    'subagents',
    'mcp',
    'goal',
    'risk_scope',
    'granted_tools',
    'granted_prefixes',
    'denied_tools',
    'model',
    'model_provider',
    'model_window',
    'thinking',
    'effort',
    'effort_levels',
    'autopilot',
  ]) {
    assert.ok(key in state, `ui(state).${key} must be present`);
  }
  // Empty lists are `[]`, never `null`.
  for (const listKey of ['todos', 'skills', 'jobs', 'subagents', 'mcp', 'risk_scope']) {
    assert.ok(Array.isArray(state[listKey]), `ui(state).${listKey} must be an array, not null`);
  }
  // Both goal shapes exist; the empty one is not a missing key.
  assert.ok('goal' in state, 'goal is always present');
  console.log(
    `state: todos=${state.todos.length} jobs=${state.jobs.length} mcp=${state.mcp.length} ` +
      `risk_scope=${state.risk_scope.length} goal.present=${state.goal.objective !== ''}`,
  );

  // ---- a query round trip ----
  child.stdin.write('{"v":1,"t":"status"}\n');
  await waitFor(
    () => decoded.some((m) => m.t === 'ui' && m.kind === 'status'),
    'ui(status)',
  );
  const status = decoded.find((m) => m.t === 'ui' && m.kind === 'status');
  assert.ok(status.status, 'status is grouped');
  for (const group of ['session', 'model', 'counters', 'usage', 'meta']) {
    assert.ok(group in status.status, `status.${group} must be present`);
  }
  // Usage lives here, not in ui(state) — the status bar depends on that.
  assert.equal(typeof status.status.usage.prompt, 'number', 'status.usage.prompt is a number');
  assert.ok('reasoning' in status.status.model, 'status.model.reasoning is an object');
  assert.equal(
    typeof status.status.model.reasoning.thinking,
    'boolean',
    'status.model.reasoning.thinking is a boolean, not a string',
  );
  console.log(
    `status: counters.tool_calls=${status.status.counters.tool_calls} ` +
      `usage.prompt=${status.status.usage.prompt} ` +
      `model.reasoning=${JSON.stringify(status.status.model.reasoning)} ` +
      `window=${status.context_tokens}`,
  );

  // ---- sessions ----
  child.stdin.write('{"v":1,"t":"session_list"}\n');
  await waitFor(() => decoded.some((m) => m.t === 'sessions'), 'sessions');
  const sessions = decoded.find((m) => m.t === 'sessions');
  assert.ok(Array.isArray(sessions.items), 'sessions.items is an array');
  console.log(`sessions: ${sessions.items.length} item(s)`);

  // ---- tools ----
  child.stdin.write('{"v":1,"t":"tools"}\n');
  await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'tools'), 'ui(tools)');
  const tools = decoded.find((m) => m.t === 'ui' && m.kind === 'tools');
  assert.ok(Array.isArray(tools.tools), 'ui(tools).tools is an array');
  if (tools.tools.length > 0) {
    const row = tools.tools[0];
    for (const key of [
      'name',
      'risk',
      'disposition',
      'parallel_safe',
      'interactive',
      'external',
      'granted',
      'command',
    ]) {
      assert.ok(key in row, `ui(tools) row.${key} must be present`);
    }
    assert.ok(
      ['auto', 'ask', 'deny'].includes(row.disposition),
      `disposition is one of auto/ask/deny, got ${row.disposition}`,
    );
  }
  console.log(`tools: ${tools.tools.length} row(s), first=${tools.tools[0]?.name ?? '—'}`);

  // ---- context ----
  child.stdin.write('{"v":1,"t":"context"}\n');
  await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'context'), 'ui(context)');
  console.log('context: ok');

  // ---- skills ----
  child.stdin.write('{"v":1,"t":"skills"}\n');
  await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'skills'), 'ui(skills)');
  console.log('skills: ok');

  // ---- goal (empty action = report only) ----
  child.stdin.write('{"v":1,"t":"goal"}\n');
  await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'state'), 'ui(state) after goal');
  console.log('goal: ok');

  // ---- mcp: list only, and only because a person asked ----
  child.stdin.write('{"v":1,"t":"mcp","action":"list","servers":[]}\n');
  await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'mcp'), 'ui(mcp)');
  const mcp = decoded.find((m) => m.t === 'ui' && m.kind === 'mcp');
  assert.ok(Array.isArray(mcp.mcp_servers), 'mcp_servers is an array');
  assert.ok(Array.isArray(mcp.mcp_notes), 'mcp_notes is an array');
  console.log(`mcp: ${mcp.mcp_servers.length} server(s), notes=${mcp.mcp_notes.length}`);

  // ---- the workspace: files ----
  //
  // The three facts a front end builds a browser out of, checked against the
  // real runtime rather than against a payload written here: the root listing,
  // one file's read, and a **refusal** — which is the one that matters most,
  // because a refusal arrives as a `notice` rather than as a `ui(files)` and a
  // front end that only handled the success left its spinner turning for ever.
  child.stdin.write('{"v":1,"t":"file_list","path":""}\n');
  await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'files'), 'ui(files)');
  const files = decoded.find((m) => m.t === 'ui' && m.kind === 'files');
  assert.ok(Array.isArray(files.entries), 'ui(files).entries is an array, not null');
  for (const entry of files.entries) {
    for (const key of ['name', 'path', 'type', 'size']) {
      assert.ok(key in entry, `a file entry must carry ${key}`);
    }
    assert.ok(
      entry.type === 'file' || entry.type === 'directory',
      `type is file or directory, got ${entry.type}`,
    );
  }
  console.log(`files: ${files.entries.length} entry(ies) at the root`);

  const firstFile = files.entries.find((entry) => entry.type === 'file');
  if (firstFile) {
    child.stdin.write(`{"v":1,"t":"file_read","path":${JSON.stringify(firstFile.path)}}\n`);
    await waitFor(() => decoded.some((m) => m.t === 'ui' && m.kind === 'file_read'), 'ui(file_read)');
    const read = decoded.find((m) => m.t === 'ui' && m.kind === 'file_read');
    for (const key of ['path', 'content', 'chars', 'bytes', 'total_lines', 'truncated', 'artifact_id']) {
      assert.ok(key in read, `ui(file_read).${key} must be present`);
    }
    assert.equal(typeof read.truncated, 'boolean', 'truncated is a boolean, not a string');
    console.log(`file_read: ${read.path} (${read.bytes}B, ${read.total_lines} lines)`);
  }

  // A refusal, and it must be a notice rather than a silent nothing.
  const beforeRefusal = decoded.filter((m) => m.t === 'notice').length;
  child.stdin.write('{"v":1,"t":"file_list","path":"../../.."}\n');
  await waitFor(
    () => decoded.filter((m) => m.t === 'notice').length > beforeRefusal,
    'a notice refusing a path outside the workspace',
  );
  const refusal = decoded.filter((m) => m.t === 'notice')[beforeRefusal];
  assert.equal(refusal.code, 'files', 'a file refusal carries code `files`');
  assert.ok(refusal.text.length > 0, 'the refusal says why');
  console.log(`refusal: ${refusal.text.slice(0, 80)}`);

  // ---- the workspace: terminals ----
  child.stdin.write('{"v":1,"t":"terminal_create"}\n');
  await waitFor(
    () => decoded.some((m) => m.t === 'ui' && m.kind === 'terminal_created'),
    'ui(terminal_created)',
  );
  const created = decoded.find((m) => m.t === 'ui' && m.kind === 'terminal_created');
  const term = created.terminal;
  for (const key of ['id', 'workspace', 'cwd', 'shell', 'status', 'exit_code', 'cols', 'rows']) {
    assert.ok(key in term, `a terminal row must carry ${key}`);
  }
  assert.equal(term.status, 'running', 'a terminal is running by the time its row arrives');
  console.log(`terminal_create: ${term.id} (${term.shell}, ${term.cols}x${term.rows})`);

  // A resize, and the **list** is where the new size has to show up: the runtime
  // owns the row, so a front end that kept its own copy would drift.
  child.stdin.write(
    `{"v":1,"t":"terminal_resize","terminal_id":${JSON.stringify(term.id)},"cols":100,"rows":30}\n`,
  );
  child.stdin.write('{"v":1,"t":"terminal_list"}\n');
  await waitFor(
    () =>
      decoded.some(
        (m) =>
          m.t === 'ui' &&
          m.kind === 'terminals' &&
          m.terminals.some((row) => row.id === term.id && row.cols === 100),
      ),
    'the resize to appear in the list',
  );
  console.log('terminal_resize: 100x30 reflected in the list');

  // The end, which arrives as an **event** rather than as a reply: `terminal_kill`
  // deliberately answers nothing, because a second truth about whether a process
  // is alive is exactly what the design forbids.
  child.stdin.write(
    `{"v":1,"t":"terminal_kill","terminal_id":${JSON.stringify(term.id)}}\n`,
  );
  await waitFor(
    () => decoded.some((m) => m.t === 'ui' && m.kind === 'terminal_exit'),
    'ui(terminal_exit)',
  );
  const exit = decoded.find((m) => m.t === 'ui' && m.kind === 'terminal_exit');
  assert.equal(exit.terminal_id, term.id);
  assert.equal(exit.terminal.status, 'killed', 'a killed terminal is `killed`, not `exited`');
  assert.equal(exit.terminal.exit_code, null, 'a killed shell has no exit code to report');
  console.log(`terminal_kill: ${exit.terminal_id} -> ${exit.terminal.status}`);

  // And the record can be forgotten, which a running one could not be.
  child.stdin.write(
    `{"v":1,"t":"terminal_close","terminal_id":${JSON.stringify(term.id)}}\n`,
  );
  await waitFor(
    () =>
      decoded.some(
        (m) => m.t === 'ui' && m.kind === 'terminals' && !m.terminals.some((row) => row.id === term.id),
      ),
    'the closed terminal to leave the list',
  );
  console.log('terminal_close: the row left the list');

  // ---- a malformed line must not break the stream ----
  child.stdin.write('this is not json\n');
  child.stdin.write('\n');
  child.stdin.write('{"v":1,"t":"status"}\n');
  const beforeBad = decoded.filter((m) => m.t === 'ui' && m.kind === 'status').length;
  await waitFor(
    () => decoded.filter((m) => m.t === 'ui' && m.kind === 'status').length > beforeBad,
    'a status reply after a malformed line',
  );
  console.log('tolerance: a malformed line was skipped and the stream continued');

  // ---- an unknown type is ignored ----
  child.stdin.write('{"v":1,"t":"from_the_future","x":1}\n');
  child.stdin.write('{"v":1,"t":"status"}\n');
  const beforeUnknown = decoded.filter((m) => m.t === 'ui' && m.kind === 'status').length;
  await waitFor(
    () => decoded.filter((m) => m.t === 'ui' && m.kind === 'status').length > beforeUnknown,
    'a status reply after an unknown type',
  );
  console.log('tolerance: an unknown type was ignored and the stream continued');

  // ---- shutdown ----
  child.stdin.write('{"v":1,"t":"shutdown"}\n');
  child.stdin.end();
  await waitFor(() => exited !== null, 'the child to exit');

  assert.equal(exited, 0, `a requested shutdown exits with code 0, got ${exited}`);
  console.log(`exit: code ${exited} (requested shutdown)`);

  assert.equal(failures.length, 0, `undecodable lines: ${failures.join(', ')}`);

  console.log('');
  console.log(`lines received: ${seen.length}, decoded: ${decoded.length}, stderr chunks: ${stderrLines}`);
  console.log('');
  console.log('PASS — the real runtime speaks the protocol this front end expects.');
} catch (error) {
  console.error('');
  console.error('FAIL:', error.message);
  console.error(`lines seen so far: ${seen.length}`);
  for (const line of seen.slice(0, 5)) console.error(`  ${line.slice(0, 200)}`);
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  process.exit(1);
}
