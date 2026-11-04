/**
 * The hooks panel's form, asserted where it is decided.
 *
 * Every claim here is invisible in a window: a refused save that throws the typing
 * away, a result shown beside a command it did not come from, a "dirty" flag that
 * never clears, a move that crosses events. The functions are pure, so the cases
 * are constructed rather than staged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookEventInfo, HookRow, HooksSnapshot } from '@/protocol/types';
import {
  blankRow,
  canMove,
  firstWord,
  freshName,
  isDirty,
  moveRow,
  parseWhole,
  problemsOf,
  rowEdited,
  savedFacts,
  sameCommand,
  seedDraft,
  shouldReseed,
  toDocument,
  withPatch,
} from '@/state/hooksDraft';

function row(over: Partial<HookRow> = {}): HookRow {
  return {
    event: 'pre_tool_use',
    name: 'guard',
    matcher: 'shell',
    command: 'node check.js',
    shell: false,
    timeout_ms: null,
    max_output_bytes: null,
    fail_closed: null,
    enabled: true,
    status_message: '',
    state: 'active',
    activity: null,
    timeout_effective: 3000,
    fail_closed_effective: true,
    executable_found: true,
    ...over,
  };
}

const EVENTS: HookEventInfo[] = [
  { name: 'pre_tool_use', gate: true, tool_event: true, can_decide: true, default_timeout_ms: 3000, workspace_allowed: true },
  { name: 'stop', gate: false, tool_event: false, can_decide: true, default_timeout_ms: 5000, workspace_allowed: false },
  { name: 'session_start', gate: false, tool_event: false, can_decide: false, default_timeout_ms: 5000, workspace_allowed: false },
];

function snapshot(entries: HookRow[], revision = 'r1'): HooksSnapshot {
  return {
    path: '/home/u/.tudouni/hooks.json',
    scripts_dir: '/home/u/.tudouni/hooks',
    disabled: false,
    file: { exists: true, revision, problem: '' },
    defaults: { timeout_ms: 4000, max_output_bytes: null },
    entries,
    events: EVENTS,
    scripts: [],
    workspace: { path: '', exists: false, trusted: false, problem: '', entries: [], trust_command: '' },
    limits: {
      max_timeout_ms: 60000,
      max_per_event: 16,
      max_output_bytes: 1048576,
      default_output: 262144,
      gate_timeout_ms: 3000,
      default_timeout: 5000,
      stderr_reason_cap: 512,
    },
  };
}

test('a freshly seeded form is clean, and the document drops the browser-only fields', () => {
  const snap = snapshot([row(), row({ event: 'stop', name: 'again', command: 'node again.js' })]);
  const draft = seedDraft(snap);
  assert.equal(isDirty(draft, snap), false);
  const doc = toDocument(draft);
  assert.equal(doc.entries.length, 2);
  assert.deepEqual(doc.defaults, { timeout_ms: 4000, max_output_bytes: null });
  for (const entry of doc.entries) {
    assert.equal('uid' in entry, false);
    assert.equal('seed' in entry, false);
    assert.equal('state' in entry, false);
  }
});

test('editing, reordering and disabling all make the form dirty, and undoing the edit clears it', () => {
  const snap = snapshot([row({ name: 'a' }), row({ name: 'b' })]);
  const draft = seedDraft(snap);

  const edited = { ...draft, rows: draft.rows.map((r, i) => (i === 0 ? withPatch(r, { command: 'x' }, EVENTS) : r)) };
  assert.equal(isDirty(edited, snap), true);
  const undone = { ...edited, rows: edited.rows.map((r, i) => (i === 0 ? withPatch(r, { command: 'node check.js' }, EVENTS) : r)) };
  assert.equal(isDirty(undone, snap), false);

  // The order is part of what a save writes: hooks of one event run in file order.
  assert.equal(isDirty(moveRow(draft, 0, 1), snap), true);
  assert.equal(isDirty({ ...draft, rows: [draft.rows[0]!] }, snap), true);
});

test('a name typed with surrounding spaces is saved trimmed and is not an edit by itself', () => {
  const snap = snapshot([row()]);
  const draft = seedDraft(snap);
  const spaced = withPatch(draft.rows[0]!, { name: ' guard ' }, EVENTS);
  assert.equal(toDocument({ ...draft, rows: [spaced] }).entries[0]?.name, 'guard');
  assert.equal(rowEdited(spaced), false);
});

test('changing the event drops what the new event cannot use', () => {
  const draft = seedDraft(snapshot([row({ matcher: 'shell', fail_closed: true })]));
  const toStop = withPatch(draft.rows[0]!, { event: 'stop' }, EVENTS);
  assert.equal(toStop.matcher, '');
  assert.equal(toStop.fail_closed, true, 'stop can decide, so fail_closed still means something');

  const toStart = withPatch(draft.rows[0]!, { event: 'session_start' }, EVENTS);
  assert.equal(toStart.matcher, '');
  assert.equal(toStart.fail_closed, null);

  const same = withPatch(draft.rows[0]!, { event: 'pre_tool_use' }, EVENTS);
  assert.equal(same.matcher, 'shell');
});

test('rows move only among rows of the same event', () => {
  const snap = snapshot([
    row({ name: 'a' }),
    row({ event: 'stop', name: 's', command: 'c' }),
    row({ name: 'b' }),
  ]);
  const draft = seedDraft(snap);
  // a and b are separated by a `stop` row; they swap over it, and `s` stays put.
  assert.equal(canMove(draft, 0, -1), false);
  assert.equal(canMove(draft, 0, 1), true);
  const moved = moveRow(draft, 0, 1);
  assert.deepEqual(moved.rows.map((r) => r.name), ['b', 's', 'a']);
  // A lone row has nowhere to go.
  assert.equal(canMove(draft, 1, -1), false);
  assert.equal(canMove(draft, 1, 1), false);
  assert.equal(moveRow(draft, 1, 1), draft);
});

test('a refused save keeps the typing; a stale one and a successful one redraw', () => {
  const snap = snapshot([row()], 'r1');
  // First snapshot ever: always seeds.
  assert.equal(shouldReseed(null, snap, null), true);
  // Success: re-draw, the runtime may have normalised what was typed.
  assert.equal(shouldReseed('r1', snap, null), true);
  // Refusal with the file unchanged: the typing is the only copy.
  assert.equal(shouldReseed('r1', snap, 'name must be unique'), false);
  // Refusal because the file moved under the form: keeping it would offer to overwrite.
  assert.equal(shouldReseed('r0', snap, 'file changed'), true);
});

test('problems are what makes a row meaningless on its face', () => {
  const snap = snapshot([]);
  const draft = seedDraft(snap);
  const base = blankRow(draft);
  const rows = [
    { ...base, uid: 'a', name: '', command: 'x' },
    { ...base, uid: 'b', name: 'dup', command: '  ' },
    { ...base, uid: 'c', name: 'dup', command: 'y' },
    { ...base, uid: 'd', name: 'dup', event: 'stop', command: 'z' },
  ];
  const codes = problemsOf({ ...draft, rows }, 16).map((p) => `${p.code}@${p.row}`);
  assert.deepEqual(codes, ['noName@1', 'noCommand@2', 'duplicate@3']);

  // Reported once per event, not once per surplus row.
  const many = Array.from({ length: 5 }, (_, i) => ({ ...base, uid: `m${i}`, name: `n${i}`, command: 'c' }));
  const tooMany = problemsOf({ ...draft, rows: many }, 3).filter((p) => p.code === 'tooMany');
  assert.equal(tooMany.length, 1);
  assert.equal(tooMany[0]?.row, 4);
});

test('a blank row is valid except for its command, and its name does not collide', () => {
  const draft = seedDraft(snapshot([row({ name: 'hook-2' })]));
  const blank = blankRow(draft);
  assert.equal(blank.event, 'pre_tool_use');
  assert.equal(blank.seed, null);
  assert.equal(rowEdited(blank), true);
  assert.equal(freshName(draft, 'pre_tool_use'), blank.name);
  assert.notEqual(blank.name, 'hook-2');
  const codes = problemsOf({ ...draft, rows: [...draft.rows, blank] }, 16).map((p) => p.code);
  assert.deepEqual(codes, ['noCommand']);
});

test('a result belongs to the saved hook it was recorded for', () => {
  const draft = seedDraft(snapshot([row()]));
  const saved = draft.rows[0]!;
  assert.notEqual(savedFacts(saved), null);
  assert.equal(sameCommand(saved), true);

  // Renaming or moving to another event makes it a different hook to the session.
  assert.equal(savedFacts(withPatch(saved, { name: 'other' }, EVENTS)), null);
  assert.equal(savedFacts(withPatch(saved, { event: 'stop' }, EVENTS)), null);
  // Surrounding spaces in the name are not a rename.
  assert.notEqual(savedFacts(withPatch(saved, { name: 'guard ' }, EVENTS)), null);

  // Editing the command or the shell flag leaves the facts but not their lookup.
  assert.equal(sameCommand(withPatch(saved, { command: 'node other.js' }, EVENTS)), false);
  assert.equal(sameCommand(withPatch(saved, { shell: true }, EVENTS)), false);

  // A row never saved has no facts at all.
  assert.equal(savedFacts(blankRow(draft)), null);
  assert.equal(sameCommand(blankRow(draft)), false);
});

test('firstWord names the program for a sentence, honouring a leading quote', () => {
  assert.equal(firstWord('node check.js'), 'node');
  assert.equal(firstWord('  python   x.py'), 'python');
  assert.equal(firstWord('"C:/Program Files/node/node.exe" x.js'), 'C:/Program Files/node/node.exe');
  assert.equal(firstWord('"unterminated path'), 'unterminated path');
  assert.equal(firstWord(''), '');
});

test('number fields: empty means unset, and anything but a positive integer is unset too', () => {
  assert.equal(parseWhole(''), null);
  assert.equal(parseWhole('  '), null);
  assert.equal(parseWhole('2500'), 2500);
  assert.equal(parseWhole(' 7 '), 7);
  assert.equal(parseWhole('0'), null);
  assert.equal(parseWhole('-3'), null);
  assert.equal(parseWhole('1.5'), null);
  assert.equal(parseWhole('abc'), null);
});
