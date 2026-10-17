/**
 * Folding a turn away: which rows a turn owns, and what its head says once they
 * are gone.
 *
 * The drawing half is `StreamView`'s `TurnFold` plus `EntryView`'s `TurnHead`;
 * this suite drives the pure half (`streamSections` and `turnPhase` in
 * `streamBlocks.ts`, and the `duration_ms` the reducer keeps on the head),
 * because every rule here is invisible in a rendered string:
 *
 *   - **a turn runs from its head to the next head.** Nothing else closes it.
 *     Get that wrong one way and the answer is folded into the *next* turn; get
 *     it wrong the other way and the last turn's rows are dropped on the floor.
 *   - **the phase is the last thing seen happening**, not the first. A turn that
 *     thought, ran a tool and is now writing must say "reply" — a head that
 *     still says "thinking" while text streams is a live-status line that is
 *     simply wrong.
 *   - **the phase is observed, never guessed.** A settled tool is not "tool
 *     call": nothing is running any more, and the next call has not been written
 *     yet.
 *   - **a finished turn's duration belongs to that turn.** The session keeps only
 *     the newest one (`lastTurnMs`), so the figure has to be captured on the head
 *     or every folded turn but the last would read as unmeasured.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDelta, applyFinalAnswer, reduceEvent, type Entry, type LooseEvent } from '@/state/entries';
import { streamBlocks, streamSections, type StreamRow, type StreamSection } from '@/streamBlocks';

/* ============================================================
   helpers — real wire events, reduced by the real reducer
   ============================================================ */

function freshOptions(overrides: Partial<Parameters<typeof reduceEvent>[2]> = {}) {
  return {
    activeRunId: 'r1' as string | null,
    lastRunId: null as string | null,
    lookup: () => ({ risk: 'low' as const, parallelSafe: false, interactive: false, external: false }),
    maxSteps: 120,
    ...overrides,
  };
}

function ev(kind: string, extra: Record<string, unknown> = {}): LooseEvent {
  return {
    v: 1,
    t: 'event',
    kind,
    session_id: 's-1',
    run_id: 'r1',
    step: 0,
    ts: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

/** Build rows the way `StreamView` does (quiet off), then partition them. */
function sectionsOf(entries: Entry[]): StreamSection[] {
  const rows: StreamRow[] = entries.map((e) => ({ kind: 'entry' as const, key: e.id, entry: e }));
  return streamSections(streamBlocks(rows));
}

/** The kind of every row inside one section, in the order it is drawn. */
function rowKinds(section: StreamSection): string[] {
  const blocks = section.kind === 'turn' ? section.body : section.blocks;
  return blocks.map((block) => (block.kind === 'step' ? 'step' : block.row.entry.kind));
}

/** How one turn is cut for the fold: the work, then the words. */
function runKinds(section: StreamSection): string[] {
  assert.ok(section.kind === 'turn', 'runKinds is about a turn');
  return section.runs.map((run) => run.kind);
}

/** The row kinds inside one run, by index. */
function runRows(section: StreamSection, at: number): string[] {
  assert.ok(section.kind === 'turn', 'runRows is about a turn');
  const run = section.runs[at];
  assert.ok(run !== undefined, `no run at ${at}`);
  return run.blocks.map((block) => (block.kind === 'step' ? 'step' : block.row.entry.kind));
}

/** Open a turn: one `run_started` is all it takes. */
function started(): Entry[] {
  return reduceEvent([], ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
}

/* ============================================================
   which rows a turn owns
   ============================================================ */

test('a turn owns everything under its head and nothing above it', () => {
  // A prompt is echoed **before** its head lands (`submitDraft` appends the
  // `user` row and only then sends), so the head must not swallow it: a folded
  // turn that hid the question would leave a transcript that cannot be read.
  let entries: Entry[] = [{ kind: 'user', id: 'u1', text: 'hello', atMs: 0 }];
  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 900 }),
    freshOptions(),
  ).entries;

  const sections = sectionsOf(entries);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ['loose', 'turn'],
    'the prompt is loose, the head opens the turn',
  );
  const loose = sections[0];
  assert.ok(loose.kind === 'loose');
  assert.deepEqual(rowKinds(loose), ['user']);

  const turn = sections[1];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(rowKinds(turn), ['model'], 'the call under the head is the turn');
});

test('two turns are two sections, and the head closes the one above it', () => {
  let entries = started();
  entries = applyDelta(entries, 'r1', 1, 'text', 'first answer', 'r1', null).entries;

  // A second turn: the runtime permits one per message, so this is two prompts.
  const second = reduceEvent(
    entries,
    ev('run_started', { run_id: 'r2' }),
    freshOptions({ activeRunId: 'r2' }),
  ).entries;

  const sections = sectionsOf(second);
  assert.equal(sections.length, 2);
  const [first, next] = sections;
  assert.ok(first.kind === 'turn' && next.kind === 'turn');
  assert.deepEqual(rowKinds(first), ['stream'], 'the first turn keeps its own body');
  assert.deepEqual(rowKinds(next), [], 'the new head has drawn nothing yet');
});

test('a turn that ends and then draws nothing else still closes at the next head', () => {
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', duration_ms: 1200, step: 1 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('run_started', { run_id: 'r2' }),
    freshOptions({ activeRunId: 'r2' }),
  ).entries;

  const sections = sectionsOf(entries);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ['turn', 'turn'],
  );
});

test('a note written between turns rides the turn above it', () => {
  // Pinned because it is a decision rather than an accident: `context_compacted`
  // is session-level (it carries `run_id: ""`, so it is not turn-scoped), arrives
  // after the turn it followed, and therefore lands inside that turn's span. The
  // alternative — closing the span at the answer — would leave rows that belong to
  // no section at all, and they would have to be drawn out of arrival order.
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('context_compacted', { run_id: '', folded: 4, before: 900, after: 400 }),
    freshOptions(),
  ).entries;

  const sections = sectionsOf(entries);
  assert.equal(sections.length, 1);
  const turn = sections[0];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(rowKinds(turn), ['note'], 'the note is in the turn it arrived under');
});

test('the next turn’s prompt is not folded into this one', () => {
  // The echo is appended when the person presses Enter; the head it belongs to
  // only lands when the runtime answers `run_started`. So for a moment the next
  // question is the last row under the previous turn — and folding that turn
  // must not hide the question the reader just asked. Caught in a browser: the
  // second bubble's `innerText` came back empty once the first turn was folded.
  let entries: Entry[] = [{ kind: 'user', id: 'u1', text: 'first', atMs: 0 }];
  entries = reduceEvent(entries, ev('run_started', {}), freshOptions({ activeRunId: null })).entries;
  entries = applyDelta(entries, 'r1', 1, 'text', 'the answer', 'r1', 'r1').entries;
  // The next prompt, and no head yet: this is exactly the window that broke.
  entries = [...entries, { kind: 'user', id: 'u2', text: 'second', atMs: 0 }];

  const pending = sectionsOf(entries);
  assert.deepEqual(
    pending.map((section) => section.kind),
    ['loose', 'turn', 'loose'],
    'the second prompt is drawn on its own, below the turn it follows',
  );
  const trailing = pending[2];
  assert.ok(trailing.kind === 'loose');
  assert.deepEqual(rowKinds(trailing), ['user']);
  const first = pending[1];
  assert.ok(first.kind === 'turn');
  assert.deepEqual(rowKinds(first), ['stream'], 'the turn keeps its own body and nothing else');

  // And once its head lands, the prompt stays outside the turn — above it, where
  // it has always been drawn.
  const withHead = reduceEvent(
    entries,
    ev('run_started', { run_id: 'r2' }),
    freshOptions({ activeRunId: 'r2' }),
  ).entries;
  const sections = sectionsOf(withHead);
  assert.deepEqual(
    sections.map((section) => section.kind),
    ['loose', 'turn', 'loose', 'turn'],
  );
  const second = sections[3];
  assert.ok(second.kind === 'turn');
  assert.deepEqual(rowKinds(second), [], 'the new head has drawn nothing yet');
});

/* ============================================================
   what a folded turn keeps: the work goes, the words stay
   ============================================================ */

/** One finished turn with all three shapes of work: thinking, a tool, an answer. */
function turnWithWork(): Entry[] {
  let entries = applyDelta(started(), 'r1', 1, 'reasoning', 'let me look', 'r1', null).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, reasoning: 'let me look', duration_ms: 400 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5 }),
    freshOptions(),
  ).entries;
  entries = applyDelta(entries, 'r1', 2, 'text', 'the answer body', 'r1', null).entries;
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', duration_ms: 5000, step: 2 }),
    freshOptions(),
  ).entries;
  return applyFinalAnswer(entries, 'r1', 'the answer body');
}

test('a folded turn keeps its answer and gives up everything else', () => {
  // The whole point of the shape: "like a chat, with the middle left out". The
  // work — the thinking card and the model call that ran the tool — is what the
  // fold takes; the `answer` row is what it must never take.
  const turn = sectionsOf(turnWithWork())[0];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(runKinds(turn), ['process', 'reply'], 'one stretch of work, then the reply');
  assert.deepEqual(runRows(turn, 0), ['reason', 'step'], 'the work: the thinking and the call');
  assert.deepEqual(runRows(turn, 1), ['answer'], 'the reply: exactly the answer row');
});

test('a turn still writing shows the text, not the tools', () => {
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 400 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = applyDelta(entries, 'r1', 2, 'text', 'writing it now', 'r1', null).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(runKinds(turn), ['process', 'reply']);
  assert.deepEqual(runRows(turn, 1), ['stream'], 'the body being written is the reply so far');
});

test('narration before a call is work, not the reply', () => {
  // The model says something before each tool call. That is not the answer: a
  // folded turn that kept it would be a chat where the assistant answers six
  // times before its answer. Only the **last** text row is the reply.
  let entries = applyDelta(started(), 'r1', 1, 'text', 'let me look at the files', 'r1', null).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5 }),
    freshOptions(),
  ).entries;
  entries = applyDelta(entries, 'r1', 2, 'text', 'here is what I found', 'r1', null).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(runKinds(turn), ['process', 'reply']);
  assert.deepEqual(runRows(turn, 0), ['stream', 'tool'], 'the narration rides with the work');
  assert.deepEqual(runRows(turn, 1), ['stream'], 'the reply is the last thing said');
});

test('a row that arrives after the answer stays after it', () => {
  // A `/status` block or a "history compacted" note can land under a turn that has
  // already answered. The fold must not hoist it above the answer: the runs keep
  // the arrival order, so it becomes a second (shut) stretch of work below it.
  let entries = turnWithWork();
  entries = reduceEvent(
    entries,
    ev('context_compacted', { run_id: '', folded: 4, before: 900, after: 400 }),
    freshOptions({ activeRunId: null, lastRunId: 'r1' }),
  ).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(runKinds(turn), ['process', 'reply', 'process']);
  assert.deepEqual(runRows(turn, 2), ['note'], 'the late note is drawn below the answer');
});

test('the files a turn declared are collected for the folded view', () => {
  // They live inside a tool row, which is work — so folding would bury the only
  // thing `present` made. The section carries them out so the fold can draw them
  // beside the answer.
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'present', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', {
      step: 0,
      tool_index: 0,
      status: 'ok',
      chars: 10,
      duration_ms: 5,
      deliverables: [
        { path: 'notes/summary.md', description: 'the summary' },
        { path: 'out/chart.png' },
      ],
    }),
    freshOptions(),
  ).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.deepEqual(
    turn.deliverables.map((file) => file.path),
    ['notes/summary.md', 'out/chart.png'],
  );
  assert.equal(turn.deliverables[1]?.description, '', 'a missing note stays an empty string');

  // A turn that declared nothing allocates nothing.
  const plain = sectionsOf(started())[0];
  assert.ok(plain.kind === 'turn');
  assert.deepEqual(plain.deliverables, []);
});

/* ============================================================
   what the head says while folded
   ============================================================ */

test('a turn with nothing drawn yet is on its first call', () => {
  const sections = sectionsOf(started());
  const turn = sections[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'model', 'nothing observed is not "idle": the loop opens with a call');
});

test('live reasoning reads as thinking', () => {
  const entries = applyDelta(started(), 'r1', 1, 'reasoning', 'let me look', 'r1', null).entries;
  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'thinking');
});

test('a settled call reads as model, not as the thinking it finished', () => {
  let entries = applyDelta(started(), 'r1', 1, 'reasoning', 'let me look', 'r1', null).entries;
  // The record replaces the streamed block with the complete text and marks it
  // settled: the thinking is over, the call's own row is what follows.
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, reasoning: 'let me look', duration_ms: 400 }),
    freshOptions(),
  ).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'model');
});

test('a call in flight reads as model', () => {
  const entries = reduceEvent(
    started(),
    ev('model_call', { status: 'error', step: 0, backoff_ms: 500 }),
    freshOptions(),
  ).entries;
  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'model', 'a retry is the same call, still model');
});

test('a tool with no result reads as tool call', () => {
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 400 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'tool');
});

test('a settled tool is not still calling one', () => {
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 400 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5 }),
    freshOptions(),
  ).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'model', 'the head falls back to the call, it does not claim running work');
});

test('the last live signal wins over the first', () => {
  // Thought, called a tool, tool came back, then the answer arrives: the head
  // must move on with it. This is the assertion a first-hit-wins scan fails.
  let entries = applyDelta(started(), 'r1', 1, 'reasoning', 'hmm', 'r1', null).entries;
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 300 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_result', { step: 0, tool_index: 0, status: 'ok', chars: 10, duration_ms: 5 }),
    freshOptions(),
  ).entries;
  entries = applyDelta(entries, 'r1', 2, 'text', 'the answer', 'r1', null).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'reply');
});

test('a body with live text inside a card still reads as reply', () => {
  // The answer and the streamed body are **not** inside a step card
  // (`streamBlocks` keeps prose out), so this covers the row that is loose among
  // cards: the head has to find it wherever it sits.
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('model_call', { status: 'ok', step: 0, duration_ms: 300 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('tool_call', { step: 0, tool_index: 0, tool: 'grep', call_id: 'c1', arguments: '{}' }),
    freshOptions(),
  ).entries;
  entries = applyDelta(entries, 'r1', 2, 'text', 'writing', 'r1', null).entries;

  const turn = sectionsOf(entries)[0];
  assert.ok(turn.kind === 'turn');
  assert.equal(turn.phase, 'reply');
});

/* ============================================================
   the duration the head keeps
   ============================================================ */

test('a finished turn keeps its own duration on its head', () => {
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', duration_ms: 12400, step: 3 }),
    freshOptions(),
  ).entries;

  const head = entries.find((entry) => entry.kind === 'turn');
  assert.ok(head?.kind === 'turn');
  assert.equal(head.durationMs, 12400);
  assert.equal(head.status, 'answered');
  assert.equal(head.step, 3);
});

test('a run_finished with no duration leaves the head unmeasured', () => {
  // `duration_ms` is optional on the record, and a turn closed by the runtime
  // going away has no measurement at all. Null is "nobody measured it"; 0 would
  // be a claim that it took no time.
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', step: 1 }),
    freshOptions(),
  ).entries;

  const head = entries.find((entry) => entry.kind === 'turn');
  assert.ok(head?.kind === 'turn');
  assert.equal(head.durationMs, null);
});

test('the earlier turn keeps its own figure when a later one ends', () => {
  // The session holds only the newest duration (`lastTurnMs`), which is why the
  // reducer writes it onto each head: without that, folding an older turn would
  // show an em dash for a number the transcript was told.
  let entries = started();
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', duration_ms: 1000, step: 1 }),
    freshOptions(),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('run_started', { run_id: 'r2' }),
    freshOptions({ activeRunId: 'r2' }),
  ).entries;
  entries = reduceEvent(
    entries,
    ev('run_finished', { stop_reason: 'answered', run_id: 'r2', duration_ms: 7000, step: 1 }),
    freshOptions({ activeRunId: 'r2' }),
  ).entries;

  const durations = entries
    .filter((entry) => entry.kind === 'turn')
    .map((entry) => (entry.kind === 'turn' ? entry.durationMs : null));
  assert.deepEqual(durations, [1000, 7000]);
});
