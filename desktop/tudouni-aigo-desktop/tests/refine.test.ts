/**
 * Task refine: the pure rules, and the prompt it sends.
 *
 * Three halves, three claims the UI makes before a refine run exists:
 *
 *   - **The scope** (`refineRunScope`): which of a task's runs the agent may
 *     study — only settled ones, newest first, "last N" a trim of that order,
 *     and the failed-only variant keeping the newest ok run as the reference.
 *   - **The gate** (`refineAvailability`): no finished run, remote in either
 *     direction, a task bound to a different workspace — the same function the
 *     panel's tooltip and the store's refusal both read, so the two cannot
 *     disagree about why.
 *   - **The message and its reader** (`buildRefineMessage` /
 *     `extractRefinePrompts` / `refineSelectedNumbers`): the prompt carries
 *     every run's frozen snapshot (or `(not recorded)`), the candidate blocks
 *     are marked with a number per block, and the person's answer — the option
 *     labels, joined — is read back to those same numbers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REFINE_LAST_N,
  refineAvailability,
  refineRunScope,
  type RunScope,
  type Task,
  type TaskRunLink,
} from '../src/task/tasks';
import {
  buildRefineMessage,
  extractRefinePrompts,
  REFINE_NONE_LABEL,
  refineOptionLabel,
  refineSelectedNumbers,
} from '../src/learn/refineTemplate';

/* ============================================================
   The scope
   ============================================================ */

function link(patch: Partial<TaskRunLink> & { startedAtMs: number }): TaskRunLink {
  return {
    taskId: 't',
    sessionId: 'sid',
    sessionKey: 'k',
    taskName: 'nightly',
    model: '',
    workspaceLabel: 'C:/work',
    ...patch,
  };
}

const LINKS: TaskRunLink[] = [
  link({ startedAtMs: 1, outcome: 'failed', prompt: 'v1' }),
  link({ startedAtMs: 2, outcome: 'ok', prompt: 'v1' }),
  link({ startedAtMs: 3, outcome: 'failed', prompt: 'v2' }),
];

test('the scope is newest first, over settled runs only', () => {
  // A run without a verdict is a state, not an outcome: it is not evidence.
  const inFlight = link({ startedAtMs: 9 });
  const all = refineRunScope([...LINKS, inFlight], { kind: 'all' }, false);
  assert.deepEqual(all.map((row) => row.startedAtMs), [3, 2, 1]);
  // The snapshot, the verdict, and the session file path ride along.
  assert.equal(all[0].prompt, 'v2');
  assert.equal(all[0].outcome, 'failed');
  assert.equal(all[0].sessionFile, '.tudouni/sessions/sid.jsonl');
});

test('a run without a recorded prompt is (not recorded), and a link without an id has no file', () => {
  const noPrompt = link({ startedAtMs: 1, outcome: 'ok' });
  const noId = link({ startedAtMs: 2, outcome: 'failed', sessionId: '' });
  // Newest first, so `noId` (2) is rows[0] and `noPrompt` (1) is rows[1].
  const rows = refineRunScope([noPrompt, noId], { kind: 'all' }, false);
  assert.equal(rows[0].sessionFile, null, 'no id is no file');
  assert.equal(rows[1].prompt, null, 'no snapshot is null, never a guess');
  assert.equal(rows[1].sessionFile, '.tudouni/sessions/sid.jsonl', 'its file is still there');
});

test('last N is a trim of the newest-first order', () => {
  const four = [...LINKS, link({ startedAtMs: 4, outcome: 'ok', prompt: 'v3' })];
  const scoped = refineRunScope(four, { kind: 'last', n: 2 }, false);
  assert.deepEqual(scoped.map((row) => row.startedAtMs), [4, 3]);
  assert.equal(REFINE_LAST_N, 10, 'the first version pins N = 10');
});

test('the failed-only scope keeps the newest successful run as the reference', () => {
  const scoped = refineRunScope(LINKS, { kind: 'all' }, true);
  // The reference first — "how it went right" — then the failures, newest first.
  assert.deepEqual(scoped.map((row) => row.startedAtMs), [2, 3, 1]);
  assert.equal(scoped[0].outcome, 'ok');
  // A task that has never succeeded has nothing to compare against: the
  // failures alone are all there is, and the report says so.
  const onlyFailed = refineRunScope([LINKS[0]], { kind: 'all' }, true);
  assert.deepEqual(onlyFailed.map((row) => row.startedAtMs), [1]);
});

/* ============================================================
   The gate
   ============================================================ */

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'nightly',
    description: '',
    prompt: 'build everything',
    workspace: { kind: 'active' },
    model: '',
    enabled: true,
    autopilot: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  };
}

const SETTLED = [link({ startedAtMs: 1, outcome: 'ok' })];

test('no finished run is the first refusal, with its own reason', () => {
  assert.equal(refineAvailability(task(), [], 'C:/work', false).reason, 'no-runs');
  assert.equal(refineAvailability(task(), [link({ startedAtMs: 1 })], 'C:/work', false).reason, 'no-runs');
});

test('remote is refused in either direction', () => {
  assert.equal(
    refineAvailability(task({ workspace: { kind: 'remote', id: 'rw-1' } }), SETTLED, 'C:/work', false).reason,
    'remote',
    'a task bound to a remote workspace',
  );
  assert.equal(refineAvailability(task(), SETTLED, 'C:/work', true).reason, 'remote', 'a task on a remote screen');
});

test('a task bound to a different workspace is not the wrong directory compared', () => {
  const localElsewhere = task({ workspace: { kind: 'local', path: 'D:/other' } });
  assert.equal(refineAvailability(localElsewhere, SETTLED, 'C:/work', false).reason, 'other-workspace');
  // The same path, other spelling: the comparison is the workspace's own.
  assert.equal(refineAvailability(task({ workspace: { kind: 'local', path: 'C:/work' } }), SETTLED, 'C:/work', false).ok, true);
  // `active` is the screen's own workspace, whenever that is.
  assert.equal(refineAvailability(task(), SETTLED, 'C:/work', false).ok, true);
  // No workspace on screen is not a place: nothing is available.
  assert.equal(refineAvailability(task(), SETTLED, '', false).reason, 'other-workspace');
});

/* ============================================================
   The message
   ============================================================ */

const RUNS = refineRunScope(LINKS, { kind: 'all' }, false);

test('the message carries the task, the current prompt, and every run with its snapshot', () => {
  const text = buildRefineMessage({
    taskName: 'nightly',
    currentPrompt: 'build everything',
    workspace: 'C:/work',
    scope: { kind: 'all' },
    failedOnly: false,
    runs: RUNS,
    objectives: 'focus on the login step',
  });
  assert.ok(text.includes('You are starting a task refinement.'));
  assert.ok(text.includes('- Task: nightly'));
  assert.ok(text.includes('build everything'), 'the current prompt, so the difference is visible');
  assert.ok(text.includes('focus on the login step'));
  assert.ok(text.includes('prompt: v2'), 'the snapshot of the newest run');
  assert.ok(text.includes('outcome: failed'));
  assert.ok(text.includes('.tudouni/sessions/sid.jsonl'), 'the session file path');
  assert.ok(text.includes('Apply none of them'), 'the final option, worded once');
  assert.ok(text.includes(REFINE_NONE_LABEL));
});

test('a run without a snapshot is labelled (not recorded), not guessed at', () => {
  const rows = refineRunScope([link({ startedAtMs: 1, outcome: 'ok' })], { kind: 'all' }, false);
  const text = buildRefineMessage({
    taskName: 't',
    currentPrompt: 'p',
    workspace: 'w',
    scope: { kind: 'all' },
    failedOnly: false,
    runs: rows,
    objectives: '',
  });
  assert.ok(text.includes('prompt: (not recorded)'));
  assert.ok(text.includes('(none)'), 'no objectives is (none), not a hole');
});

test('the last-N scope says what it is, in the agent\u2019s words', () => {
  const text = buildRefineMessage({
    taskName: 't',
    currentPrompt: 'p',
    workspace: 'w',
    scope: { kind: 'last', n: 10 },
    failedOnly: true,
    runs: refineRunScope(LINKS, { kind: 'last', n: 10 }, true),
    objectives: '',
  });
  assert.ok(text.includes('the 10 most recent finished runs'));
  assert.ok(text.includes('only the failed ones, plus the newest successful run as the reference'));
});

/* ============================================================
   The reader: candidate blocks and the answer
   ============================================================ */

test('the marked blocks are read back, in number order, last occurrence wins', () => {
  const report = [
    'Some analysis. Candidate 1 would fix the login step.',
    'BEGIN TASK PROMPT CANDIDATE (candidate 1)',
    'the new prompt one',
    'END TASK PROMPT CANDIDATE',
    'Candidate 2 is a rewording. It would look like this:',
    'BEGIN TASK PROMPT CANDIDATE (candidate 1)',
    'the new prompt one, quoted again in the prose',
    'END TASK PROMPT CANDIDATE',
    'BEGIN TASK PROMPT CANDIDATE (candidate 2)',
    'the new prompt two',
    'END TASK PROMPT CANDIDATE',
  ].join('\n');
  const prompts = extractRefinePrompts(report);
  assert.deepEqual(prompts, [
    'the new prompt one, quoted again in the prose',
    'the new prompt two',
  ]);
});

test('a candidate without a block is a hole, never someone else\u2019s text', () => {
  const report = [
    'BEGIN TASK PROMPT CANDIDATE (candidate 1)',
    'prompt one',
    'END TASK PROMPT CANDIDATE',
    'BEGIN TASK PROMPT CANDIDATE (candidate 3)',
    'prompt three',
    'END TASK PROMPT CANDIDATE',
  ].join('\n');
  const prompts = extractRefinePrompts(report);
  assert.equal(prompts[0], 'prompt one');
  assert.equal(prompts[1], undefined, 'candidate 2 had no block');
  assert.equal(prompts[2], 'prompt three');
});

test('a report with no candidate blocks has no candidates', () => {
  assert.deepEqual(extractRefinePrompts('Nothing to fix here.'), []);
});

test('the answer is read back to candidate numbers', () => {
  assert.deepEqual(refineSelectedNumbers(refineOptionLabel(1), 2), [1]);
  assert.deepEqual(refineSelectedNumbers(`${refineOptionLabel(1)}, ${refineOptionLabel(2)}`, 2), [1, 2]);
  // The none option anywhere in the answer means none, full stop.
  assert.deepEqual(refineSelectedNumbers(`${refineOptionLabel(1)}, ${REFINE_NONE_LABEL}`, 2), []);
  assert.deepEqual(refineSelectedNumbers(REFINE_NONE_LABEL, 2), []);
  // Free text is an answer too, and a bare number in it is not a selection:
  // the option's own wording — "candidate N" — is what counts.
  assert.deepEqual(refineSelectedNumbers('3 replicas please', 3), []);
  assert.deepEqual(refineSelectedNumbers('I want candidate 2 only', 2), [2]);
  // Out of range is out of range: the answer cannot name a candidate that
  // does not exist.
  assert.deepEqual(refineSelectedNumbers(refineOptionLabel(3), 2), []);
});
