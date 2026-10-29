/**
 * `hook_result` on the desktop screen.
 *
 * This is the half of the hooks feature that has to be **visible**. Without it a
 * user-configured hook refusing a tool call reaches the model as a denial and the
 * screen shows only an ordinary tool that came back with some text — the call row
 * looks exactly like a policy refusal, and the person who wrote the script has no
 * way to tell that it was theirs.
 *
 * Three rules are asserted here, and each is a decision rather than an accident:
 *
 *   1. only `denied` and the *failures* draw a row — `ok` and `skipped` do not,
 *      because a line on every tool call would bury the transcript under "checked,
 *      fine";
 *   2. the status is shown **untranslated**, because the person will search the
 *      log for exactly that string;
 *   3. a hook record is session-level, not turn-scoped, so it is not dropped as
 *      "late" from the second turn onwards.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeT } from '@/i18n';
import { frontMessageText } from '@/components/stream/frontMessageText';
import { reduceEvent, type Entry, type LooseEvent } from '@/state/entries';

const t = makeT();

function options(overrides: Partial<Parameters<typeof reduceEvent>[2]> = {}) {
  return {
    activeRunId: 'r1' as string | null,
    lastRunId: null as string | null,
    lookup: () => null,
    maxSteps: 120,
    ...overrides,
  };
}

function hookEvent(extra: Record<string, unknown> = {}): LooseEvent {
  return {
    v: 1,
    t: 'event',
    kind: 'hook_result',
    session_id: 's-1',
    run_id: 'r1',
    step: 0,
    ts: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

/** The note a hook record produced, or null when it drew nothing. */
function noteOf(entries: Entry[]): Extract<Entry, { kind: 'note' }> | null {
  const notes = entries.filter((entry) => entry.kind === 'note');
  if (notes.length === 0) return null;
  if (notes.length > 1) {
    throw new Error(`expected at most one note, got ${notes.length}`);
  }
  return notes[0] as Extract<Entry, { kind: 'note' }>;
}

test('a refusal draws a row, in the information tone, with the hook and the tool', () => {
  const result = reduceEvent(
    [],
    hookEvent({
      hook: 'no-secrets',
      event: 'pre_tool_use',
      status: 'denied',
      decision: 'deny',
      tool: 'shell',
      reason: 'refusing a filesystem-wide delete',
    }),
    options({ activeRunId: null }),
  );
  const note = noteOf(result.entries);
  assert.notEqual(note, null);
  assert.equal(note?.code, 'hook_denied');
  // Info, not warn: a guardrail doing its job is not a problem with the setup.
  assert.equal(note?.tone, 'info');
  assert.deepEqual(note?.message, {
    code: 'hookDenied',
    hook: 'no-secrets',
    event: 'pre_tool_use',
    tool: 'shell',
    reason: 'refusing a filesystem-wide delete',
  });
});

test('a broken hook draws a row in the warning tone, and keeps the status verbatim', () => {
  for (const status of ['timeout', 'spawn_error', 'exit_error', 'bad_output', 'truncated']) {
    const result = reduceEvent(
      [],
      hookEvent({ hook: 'fmt', event: 'post_tool_use', status, tool: 'write_file' }),
      options({ activeRunId: null }),
    );
    const note = noteOf(result.entries);
    assert.notEqual(note, null, `${status} drew no row`);
    assert.equal(note?.code, 'hook_failed', status);
    assert.equal(note?.tone, 'warn', status);
    const message = note?.message as { code: string; status: string };
    assert.equal(message.status, status);
  }
});

test('an ordinary invocation draws nothing', () => {
  // `ok` is the common case: a guardrail ran and agreed. A row for it would put a
  // line on the transcript for every tool call in the session.
  for (const status of ['ok', 'skipped']) {
    const result = reduceEvent(
      [],
      hookEvent({ hook: 'no-secrets', event: 'pre_tool_use', status, tool: 'shell' }),
      options({ activeRunId: null }),
    );
    assert.equal(noteOf(result.entries), null, `${status} drew a row`);
  }
});

test('a hook record is not turn-scoped, so it survives into later turns', () => {
  // The guard at the top of `reduceEvent` drops a record whose `run_id` is not the
  // current one for the kinds it knows are turn-scoped. A hook record from an
  // earlier turn would then vanish — and the only hook rows a person notices are
  // the ones about a call they just watched.
  const result = reduceEvent(
    [],
    hookEvent({ hook: 'no-secrets', status: 'denied', tool: 'shell', run_id: 'r-old' }),
    options({ activeRunId: 'r2' }),
  );
  assert.notEqual(noteOf(result.entries), null);
});

test('the sentence keeps the hook and its own words, and shows the status untranslated', () => {
  assert.equal(
    frontMessageText(t, {
      code: 'hookDenied',
      hook: 'no-secrets',
      event: 'pre_tool_use',
      tool: 'shell',
      reason: 'refusing a filesystem-wide delete',
    }),
    'Hook no-secrets refused shell: refusing a filesystem-wide delete',
  );

  // No reason: the sentence still names both, because "something refused
  // something" is the pair a reader needs.
  assert.equal(
    frontMessageText(t, {
      code: 'hookDenied',
      hook: 'no-secrets',
      event: 'pre_tool_use',
      tool: 'shell',
      reason: '',
    }),
    'Hook no-secrets refused shell',
  );

  // The status is the runtime's own word. Rewording it here would give the person
  // a sentence they cannot grep the audit log for.
  assert.equal(
    frontMessageText(t, {
      code: 'hookFailed',
      hook: 'fmt',
      event: 'post_tool_use',
      tool: 'write_file',
      status: 'timeout',
      reason: 'timed out after 5000ms',
    }),
    'Hook fmt could not check write_file (timeout): timed out after 5000ms',
  );

  assert.equal(
    frontMessageText(t, {
      code: 'hookFailed',
      hook: 'fmt',
      event: 'post_tool_use',
      tool: 'write_file',
      status: 'truncated',
      reason: '',
    }),
    'Hook fmt could not check write_file (truncated)',
  );
});
