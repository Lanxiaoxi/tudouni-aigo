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
const { decodeLine } = await import(`file://${resolve(outDir, 'decode.mjs').replace(/\\/g, '/')}`);

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
  assert.equal(init.protocol, 3, 'the conversation protocol is 3');
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
