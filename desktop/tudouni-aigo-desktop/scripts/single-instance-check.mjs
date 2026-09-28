/**
 * Single-instance check.
 *
 * Decision 12: a second launch must focus the existing window and exit, rather
 * than starting a second runtime. The reason is the workspace: `<workspace>/
 * .tudouni/` holds permissions.json, mcp.json, session files, the audit log and
 * artifacts, and two runtimes on one workspace would write the same files.
 *
 * This asserts the observable consequence: launching the app twice leaves
 * exactly one process alive, and the second one exits on its own.
 *
 * Usage: node scripts/single-instance-check.mjs <path-to-app-exe> [waitSeconds]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const exe = process.argv[2];
const waitSeconds = Number(process.argv[3] ?? 8);

if (!exe) {
  console.error('usage: node scripts/single-instance-check.mjs <path-to-app-exe> [waitSeconds]');
  process.exit(2);
}

const procs = [];

function launch() {
  // stderr is captured rather than discarded: a Rust panic exits 101 and writes
  // its reason there, and "the process died" without the reason is not a
  // finding anyone can act on.
  const child = spawn(exe, [], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stderrText = () => stderr;
  procs.push(child);
  return child;
}

/** Is the process still alive? `exitCode === null` means yes. */
const alive = (child) => child.exitCode === null && child.signalCode === null;

let failed = false;

try {
  console.log(`app: ${exe}`);
  console.log('');

  const first = launch();
  await sleep(waitSeconds * 1000);

  if (!alive(first)) {
    console.error(`FAIL — the first instance exited on its own (code ${first.exitCode})`);
    const text = first.stderrText();
    if (text.trim()) {
      console.error('       it said:');
      for (const line of text.trim().split('\n').slice(0, 12)) console.error(`       ${line}`);
    }
    process.exit(1);
  }
  console.log(`first instance: running (pid ${first.pid})`);

  const second = launch();

  // The second instance should notice the first, hand over focus and exit.
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline && alive(second)) await sleep(200);

  if (alive(second)) {
    console.error(`FAIL — the second instance is still running (pid ${second.pid})`);
    console.error('       two runtimes on one workspace would write the same files');
    failed = true;
  } else {
    console.log(`second instance: exited on its own (code ${second.exitCode})`);
  }

  // The first must still be up: the second focuses it, it does not replace it.
  if (!alive(first)) {
    console.error('FAIL — the first instance died when the second launched');
    failed = true;
  } else {
    console.log('first instance: still running');
  }
} finally {
  for (const child of procs) {
    if (alive(child)) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

console.log('');
if (failed) {
  console.log('FAIL — single instance is not held.');
  process.exit(1);
}
console.log('PASS — a second launch exits and leaves the first running.');
