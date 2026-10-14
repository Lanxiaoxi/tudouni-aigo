/**
 * The workspace-learning task prompt: the scope arithmetic and the template.
 *
 * Both are pure, and both sit on a claim the configuration form shows the
 * person **before** anything starts: "this run will study N sessions".
 * `learningSessionRefs` is the one function that answers it, applied the
 * same way to the preview the form draws and to the list the message
 * carries — so a scope that quietly widens or narrows between the two is
 * impossible by construction, and this suite pins the rules it applies:
 *
 *   - archived sessions are out of every scope;
 *   - a time scope is a real time filter, not a list trim;
 *   - "last N" is ordered by modified time, and an unreadable timestamp
 *     sorts last rather than pretending to be newest or oldest;
 *   - the message names the workspace, the scope, the deliverables and the
 *     sessions, and says where the history files are.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLearningMessage, learningSessionRefs } from '../src/learn/template';

interface Row {
  id: string;
  modifiedAt: number | null;
  archived: boolean;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const now = Math.floor(Date.now() / 1000);

const ROWS: Row[] = [
  { id: 'newest', modifiedAt: now - 1 * DAY, archived: false },
  { id: 'mid', modifiedAt: now - 40 * DAY, archived: false },
  { id: 'old', modifiedAt: now - 200 * DAY, archived: false },
  { id: 'no-time', modifiedAt: null, archived: false },
  { id: 'archived-recent', modifiedAt: now - 1 * HOUR, archived: true },
];

test('all scope: every non-archived session, newest first', () => {
  const refs = learningSessionRefs(ROWS, { kind: 'all' });
  // The unreadable timestamp sorts last, not into a guessed place.
  assert.deepEqual(refs.map((r) => r.id), ['newest', 'mid', 'old', 'no-time']);
});

test('days scope: a real time filter, and the archive stays out', () => {
  // 90 days admits `newest` and `mid` and refuses `old`; `archived-recent`
  // is inside the window and still out, because archived is "out of the
  // list" in this app.
  const refs = learningSessionRefs(ROWS, { kind: 'days', days: 90 });
  assert.deepEqual(refs.map((r) => r.id), ['newest', 'mid']);

  // A window nothing fits into is an empty scope, not an error.
  const none = learningSessionRefs(ROWS, { kind: 'days', days: 1 });
  assert.equal(none.length, 0);
});

test('last scope: the N most recently modified, archive excluded', () => {
  const refs = learningSessionRefs(ROWS, { kind: 'last', count: 2 });
  assert.deepEqual(refs.map((r) => r.id), ['newest', 'mid']);

  // Asking for more than exists gives what exists.
  const all = learningSessionRefs(ROWS, { kind: 'last', count: 99 });
  assert.equal(all.length, 4);
});

test('a workspace with no sessions is an empty scope for every kind', () => {
  assert.equal(learningSessionRefs([], { kind: 'all' }).length, 0);
  assert.equal(learningSessionRefs([], { kind: 'days', days: 30 }).length, 0);
  assert.equal(learningSessionRefs([], { kind: 'last', count: 10 }).length, 0);
});

test('the message carries the configured scope, types and sessions', () => {
  const text = buildLearningMessage({
    workspace: '/srv/app',
    scope: { kind: 'last', count: 2 },
    sessions: learningSessionRefs(ROWS, { kind: 'last', count: 2 }),
    deliverables: ['AGENTS.md', 'Script'],
    objectives: 'recurring build errors',
  });

  // Every placeholder is filled: a hole in the template is a task with a
  // parameter the agent cannot answer.
  assert.ok(!text.includes('{{'), 'an unfilled placeholder reached the message');
  assert.ok(text.includes('Workspace: /srv/app'));
  assert.ok(text.includes('the 2 most recently modified sessions'));
  assert.ok(text.includes('Requested deliverable types: AGENTS.md, Script'));
  assert.ok(text.includes('Additional learning objectives: recurring build errors'));
  // The list names the files the agent is told to read.
  assert.ok(text.includes('.tudouni/sessions/newest.jsonl'));
  assert.ok(text.includes('.tudouni/sessions/mid.jsonl'));
  // And it does not name what is out of scope.
  assert.ok(!text.includes('.tudouni/sessions/old.jsonl'));
  assert.ok(!text.includes('.tudouni/sessions/archived-recent.jsonl'));
});

test('the final step asks the person which candidates to apply', () => {
  const text = buildLearningMessage({
    workspace: '/srv/app',
    scope: { kind: 'all' },
    sessions: [],
    deliverables: ['Skill'],
    objectives: '',
  });

  // The report is not the end: the task tells the agent to ask, with one
  // option per candidate and a "none" escape hatch, and to apply only what
  // is selected — in the same session, through the ordinary file tools.
  assert.ok(text.includes('use the ask_user tool'));
  assert.ok(text.includes('"none of them"'));
  assert.ok(text.includes('apply exactly that selection in this session'));
  // And the boundary flips only after the choice is made: nothing is
  // written before it, and an unselected candidate is never applied.
  assert.ok(text.includes('Do not apply a candidate the person did not select'));
});

test('no objectives and no deliverables are stated as such, not left blank', () => {
  const text = buildLearningMessage({
    workspace: '/srv/app',
    scope: { kind: 'all' },
    sessions: [],
    deliverables: [],
    objectives: '   ',
  });
  assert.ok(text.includes('Requested deliverable types: none'));
  assert.ok(text.includes('Additional learning objectives: (none)'));
  assert.ok(text.includes('(the workspace has no saved sessions)'));
});
