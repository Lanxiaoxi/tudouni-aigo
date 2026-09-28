/**
 * Capture the runtime's opening handshake, verbatim.
 *
 * The contract tests must be backed by **the runtime's own bytes**, not by a
 * fixture the front end wrote from memory. That is not a stylistic point: the
 * context bug this repository just fixed survived a green test suite precisely
 * because the fixture and the implementation shared the same wrong shape, and
 * they agreed with each other while disagreeing with the runtime.
 *
 * So this script spawns the real binary in a throwaway workspace, reads the
 * fixed opening triple (`init` -> `session_load` -> `ui/state`), and writes what
 * it got to `tests/fixtures/opening.jsonl`.
 *
 * Re-run it after a runtime upgrade and **review the diff by hand**:
 *
 *     node scripts/capture-protocol.mjs
 *
 * The fixture is deliberately frozen once committed — it carries absolute paths
 * and token counts from one particular run, and a test that chased those would
 * be measuring the machine rather than the protocol.
 *
 * A protocol that drifted would then fail a test instead of blanking the UI.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..');

/** Where the runtime is, in the order the app itself resolves it. */
function findBinary() {
  const fromEnv = process.env.TUDOUNI_RUNTIME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const staged = join(appDir, 'src-tauri', 'runtime', 'tudouni-aigo.exe');
  if (existsSync(staged)) return staged;

  const distDir = join(repoRoot, 'dist');
  if (existsSync(distDir)) {
    for (const name of readdirSync(distDir)) {
      const candidate = join(distDir, name, 'tudouni-aigo.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const binary = findBinary();
if (!binary) {
  console.error('no runtime binary found.');
  console.error('build one with `make release`, or set TUDOUNI_RUNTIME to its absolute path.');
  process.exit(2);
}

// A throwaway workspace. The runtime refuses the home directory and its
// ancestors (`paths.UnsafeWorkspace`), and it takes its working directory as the
// workspace — so this must be a real, isolated directory.
const workspace = mkdtempSync(join(tmpdir(), 'aigo-capture-'));

// An isolated config file as well, or the capture would pick up whatever the
// developer has configured (`~/.tudouni`) and the fixture would stop being
// reproducible.
//
// It has to name a usable route, because the runtime refuses to open a session
// without one — it emits a single `notice` explaining the missing model and
// stops. The endpoint is never contacted during the handshake: the opening
// triple is assembled from the config and the session file, and no request is
// made until a turn is actually run.
const configFile = join(workspace, 'config.json');
writeFileSync(
  configFile,
  `${JSON.stringify(
    {
      providers: {
        capture: {
          base_url: 'https://capture.invalid',
          api_key: 'capture-only-never-sent',
          models: [{ id: 'capture-model', context_window: 1000000 }],
        },
      },
    },
    null,
    2,
  )}\n`,
);

console.log(`runtime:   ${binary}`);
console.log(`workspace: ${workspace}`);

const child = spawn(binary, ['--runtime-stdio', '--stream'], {
  cwd: workspace,
  env: { ...process.env, AGENT_CONFIG_FILE: configFile },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const lines = [];
let buffer = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') {
      lines.push(line);
      const kind = describe(line);
      console.log(`  ${String(lines.length).padStart(2)}  ${kind}`);
    }
    index = buffer.indexOf('\n');
  }
});

const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(chunk));

// The opening sequence is fixed and finite, so "enough lines" is a real
// stopping condition rather than a timeout race.
//
// The triple is `init` -> `session_load` -> `ui(state)` — the same three the
// Rust bridge names in `forward_line` as the thing it must not lose. A
// `ui(context)` line may follow it, and is written out when it does, but it is
// not required: a runtime whose context layer is off does not send one, and that
// is a legitimate opening (it is precisely the case the front end has to render
// as "no context management" rather than as a row of zeroes).
const GRACE_MS = 2500;

function check() {
  const haveInit = lines.some((line) => line.includes('"t":"init"'));
  const haveLoad = lines.some((line) => line.includes('"t":"session_load"'));
  const haveState = lines.some((line) => line.includes('"kind":"state"'));
  if (!(haveInit && haveLoad && haveState)) return;

  // Drive the requests the front end sends when somebody opens `/context` and
  // `/tools`. Without these the ledger is never captured, and the front end's
  // context path stays untested against real bytes.
  if (!drove) {
    drove = true;
    child.stdin.write('{"v":1,"t":"context"}\n');
    setTimeout(() => child.stdin.write('{"v":1,"t":"tools"}\n'), 600);
  }

  // Give the replies a moment to land before freezing the file.
  if (grace === null) {
    grace = setTimeout(finish, GRACE_MS);
  }
}

let grace = null;
let drove = false;
const deadline = setTimeout(() => {
  console.error('timed out waiting for the opening handshake');
  console.error('the runtime said:');
  for (const line of lines.slice(0, 5)) console.error(`  ${line.slice(0, 300)}`);
  console.error(stderr.join('').split('\n').slice(0, 10).join('\n'));
  child.kill();
  process.exit(1);
}, 20_000);

child.stdout.on('data', check);

function describe(line) {
  try {
    const msg = JSON.parse(line);
    return msg.kind ? `${msg.t}/${msg.kind}` : String(msg.t);
  } catch {
    return '(unparsable)';
  }
}

/**
 * Replace the things that differ between runs, so the fixture is committable and
 * the diff after a runtime upgrade shows protocol changes rather than this
 * machine's temp directory.
 *
 * Only genuinely volatile strings are touched: the throwaway workspace path, the
 * audit log's own path (it embeds a timestamp), and the session id. Field names
 * and every fact the front end reads are left exactly as the runtime wrote them
 * — a fixture that normalised those would stop being evidence.
 */
function redact(line) {
  const workspaceJson = JSON.stringify(workspace).slice(1, -1);
  const out = line
    .split(workspaceJson).join('/WORKSPACE')
    .replace(/"session_id":"[^"]*"/g, '"session_id":"s-capture"')
    .replace(/"audit_path":"[^"]*"/g, '"audit_path":"/WORKSPACE/.tudouni/logs/s-capture.jsonl"')
    // The two paths above are the ones this script *chose*, and they were the
    // only ones redacted — which was not enough. A runtime notice carries the
    // path it is *advising* about, and one of them names the packaged
    // `config.example.json`, so a captured fixture went out with the
    // developer's own `C:\Users\<name>\...\tudouni-aigo` inside a warning about
    // `web_search`. That is somebody's home directory in a public repository,
    // and it is also the one thing the fixture must not contain: a machine's
    // layout, frozen as if it were protocol.
    //
    // So the *machine's* absolute paths are replaced too — but only those. The
    // match is deliberately narrow: a Windows drive path (`C:\...`, doubled
    // inside a JSON string), and any path that begins with the app or repository
    // directory. A blanket "anything starting with `/`" would be worse than the
    // leak it fixes, because the runtime's notices contain prose like
    // "/mcp lists them and mounts them one by one" and the sentence has to
    // survive — the contract tests read these strings.
    .split(JSON.stringify(appDir).slice(1, -1)).join('/APP')
    .split(JSON.stringify(repoRoot).slice(1, -1)).join('/REPO')
    .split(appDir).join('/APP')
    .split(repoRoot).join('/REPO')
    // The home directory is the leak that actually happened: a notice about
    // `web_search` names the packaged `config.example.json` by absolute path,
    // and an MCP notice names `~/.tudouni/mcp.json`. Redacting the app directory
    // alone left `C:\Users\<name>` behind, so the home directory is replaced by
    // name before the generic sweep below.
    .split(JSON.stringify(homedir()).slice(1, -1)).join('/HOME')
    .split(homedir()).join('/HOME')
    // Any remaining Windows drive path. The character class **must** allow
    // backslashes: `[^"\\]*` stops at the first separator and replaces only
    // `C:\\Users`, leaving the rest of somebody's home directory in the fixture
    // (`/REDACTED\XPS\.tudouni\mcp.json`, which is how this was caught). It
    // stops at a quote, whitespace or colon instead, so the whole path goes.
    .replace(/[A-Za-z]:\\\\[^"\s:]*/g, '/REDACTED');

  // The stored transcript's `content` is replaced with a marker. Everything the
  // front end reads from `session_load` is *structural* — `role`, and the list
  // itself — and the one message a brand-new session has is a 4.5 KB copy of the
  // system prompt. Freezing that here would mean every prompt edit produced a
  // 4.5 KB fixture diff, and the purpose of capturing at all is that a protocol
  // change shows up as a reviewable diff rather than as a blank screen. The
  // field's presence, type and position are all still the runtime's.
  if (!out.includes('"t":"session_load"')) return out;
  try {
    const msg = JSON.parse(out);
    for (const row of msg.messages ?? []) {
      if (typeof row.content === 'string') row.content = '<redacted: prompt text>';
      else if (Array.isArray(row.content)) row.content = ['<redacted: prompt parts>'];
    }
    return JSON.stringify(msg);
  } catch {
    return out;
  }
}

function finish() {
  // Both the grace timer and the deadline can reach here; only the first one
  // counts, and leaving the deadline armed would exit non-zero after a
  // perfectly good capture.
  if (done) return;
  done = true;
  clearTimeout(deadline);
  if (grace !== null) clearTimeout(grace);
  child.kill();

  const fixtures = join(appDir, 'tests', 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  const target = join(fixtures, 'opening.jsonl');
  writeFileSync(target, `${lines.map(redact).join('\n')}\n`);

  console.log('');
  console.log(`wrote ${lines.length} lines to ${target}`);
  if (stderr.length > 0) {
    console.log('stderr (not part of the fixture):');
    console.log(stderr.join('').split('\n').slice(0, 6).join('\n'));
  }
  console.log('');
  console.log('Review the diff by hand before committing: this file is frozen once');
  console.log('it lands, and the numbers in it come from one particular run.');
  process.exit(0);
}

let done = false;

// Keep the file honest about what it is.
if (existsSync(join(appDir, 'tests', 'fixtures', 'opening.jsonl'))) {
  const existing = readFileSync(join(appDir, 'tests', 'fixtures', 'opening.jsonl'), 'utf8');
  console.log(`(overwriting an existing fixture of ${existing.split('\n').length - 1} lines)`);
}
