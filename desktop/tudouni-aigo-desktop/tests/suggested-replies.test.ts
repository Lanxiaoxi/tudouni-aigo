/**
 * Quick replies (protocol 17): when the store keeps them, when it drops them,
 * and that a click is the person sending the sentence through the ordinary path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionBucket, useApp } from '@/state/store';
import { registerRuntime } from '@/runtime/bus';
import { visibleSuggestions } from '@/components/stream/SuggestedReplies';

const KEY = 'k-suggest';

const INIT = {
  v: 1,
  t: 'init',
  protocol: 17,
  session_id: 's-suggest',
  resumed: false,
  model: 'm',
  provider: 'p',
  thinking: true,
  effort: 'high',
  effort_levels: ['high'],
  model_catalog: { models: [], aliases: [] },
  workspace: 'C:/work',
  max_steps: 150,
  stream: true,
  context_tokens: 65536,
  tools: [],
  permissions: {},
  audit_path: 'C:/work/.tudouni/audit/s.jsonl',
  notices: [],
};

let sent: Record<string, unknown>[] = [];

function install(): void {
  sent = [];
  registerRuntime({
    key: KEY,
    send(msg: unknown) {
      sent.push(msg as Record<string, unknown>);
    },
    subscribe() {
      return () => undefined;
    },
    dispose() {
      return undefined;
    },
  });
  useApp.setState({
    sessions: { [KEY]: createSessionBucket(KEY, 'C:/work', { ericai: false, maxSteps: 150 }) },
    order: [KEY],
    activeKey: KEY,
    suggestionsEnabled: true,
  });
  apply(INIT);
}

function apply(msg: Record<string, unknown>): void {
  useApp.getState().applyRuntimeMessage(KEY, msg as never);
}

function event(kind: string, runId: string, extra: Record<string, unknown> = {}): void {
  apply({ v: 1, t: 'event', kind, session_id: 's-suggest', run_id: runId, step: 0, ts: '2026-01-01T00:00:00Z', ...extra });
}

function finishTurn(runId: string): void {
  event('run_started', runId);
  event('run_finished', runId, { stop_reason: 'answered', duration_ms: 10, step: 1 });
  apply({ v: 1, t: 'ui', kind: 'run_finished', answer: 'Committed. Push?', run_id: runId });
}

function bucket() {
  const b = useApp.getState().sessions[KEY];
  assert.ok(b !== undefined);
  return b;
}

test('replies for the last finished run are kept, capped at three', () => {
  install();
  finishTurn('r1');
  apply({ v: 1, t: 'ui', kind: 'suggestions', run_id: 'r1', replies: ['push', '', 'run tests', 'a', 'b'] });
  assert.deepEqual(bucket().suggestions, { runId: 'r1', replies: ['push', 'run tests', 'a'] });
});

test('a late answer for an earlier run is dropped', () => {
  install();
  finishTurn('r1');
  finishTurn('r2');
  apply({ v: 1, t: 'ui', kind: 'suggestions', run_id: 'r1', replies: ['push'] });
  assert.equal(bucket().suggestions, null);
});

test('an answer that lands while a turn runs is dropped', () => {
  install();
  finishTurn('r1');
  event('run_started', 'r2');
  apply({ v: 1, t: 'ui', kind: 'suggestions', run_id: 'r1', replies: ['push'] });
  assert.equal(bucket().suggestions, null);
});

test('a click sends the reply as an ordinary user message and clears the buttons', () => {
  install();
  finishTurn('r1');
  apply({ v: 1, t: 'ui', kind: 'suggestions', run_id: 'r1', replies: ['push 吧'] });
  sent = [];
  useApp.getState().applySuggestion('push 吧', false);
  const messages = sent.filter((m) => m.t === 'user_message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.text, 'push 吧');
  assert.equal(bucket().suggestions, null);
  assert.equal(bucket().draft, '');
  assert.equal(bucket().entries.at(-1)?.kind, 'user', 'the echo is drawn like a typed message');
});

test('a modifier-click only fills the draft', () => {
  install();
  finishTurn('r1');
  apply({ v: 1, t: 'ui', kind: 'suggestions', run_id: 'r1', replies: ['push'] });
  sent = [];
  useApp.getState().applySuggestion('push', true);
  assert.equal(sent.filter((m) => m.t === 'user_message').length, 0);
  assert.equal(bucket().draft, 'push');
});

test('turning the switch off tells the child and clears the buttons', () => {
  install();
  finishTurn('r1');
  apply({ v: 1, t: 'ui', kind: 'suggestions', run_id: 'r1', replies: ['push'] });
  sent = [];
  useApp.getState().setSuggestionsEnabled(false);
  assert.deepEqual(sent.find((m) => m.t === 'set_suggestions'), { v: 1, t: 'set_suggestions', on: false });
  assert.equal(bucket().suggestions, null);
  useApp.getState().setSuggestionsEnabled(true);
});

test('a new process is told the switch is off', () => {
  install();
  useApp.setState({ suggestionsEnabled: false });
  sent = [];
  apply(INIT);
  assert.ok(sent.some((m) => m.t === 'set_suggestions' && m.on === false));
  useApp.setState({ suggestionsEnabled: true });
});

test('the drawing rule: hidden while typing, back when the draft is cleared', () => {
  const base = {
    enabled: true,
    suggestions: { runId: 'r1', replies: ['push'] },
    lastRunId: 'r1',
    running: false,
    draftEmpty: true,
  };
  assert.equal(visibleSuggestions(base), true);
  assert.equal(visibleSuggestions({ ...base, draftEmpty: false }), false);
  assert.equal(visibleSuggestions({ ...base, running: true }), false);
  assert.equal(visibleSuggestions({ ...base, lastRunId: 'r2' }), false);
  assert.equal(visibleSuggestions({ ...base, enabled: false }), false);
});
