/**
 * The stylesheet rule that keeps a long conversation's stream flat.
 *
 * This is a regression guard for a performance fix, which is an awkward thing to
 * write tests for: the fix is one CSS declaration, its absence does not break
 * anything, and nothing about the interface *looks* different. The only symptom
 * is that a session which has grown long starts to stutter — and by then the
 * connection to this rule is long gone from anyone's memory. So the rule is
 * pinned here, together with the reason, because a test is the only place the
 * reason survives a refactor.
 *
 * What was wrong, measured on a 160-turn session (322 rows, ~47,000px tall):
 * `StreamView` follows the bottom with `scrollTop = scrollHeight` on every
 * chunk, and that write made the browser lay out the **whole transcript**
 * synchronously. One delta cost **14.0ms**; with the scroll write dropped it cost
 * **1.2ms**. So ~93% of a chunk's cost was laying out 322 rows to append a line to
 * the last of them — growing with the conversation, which is exactly what the
 * session got slower at.
 *
 * `content-visibility: auto` on the rows is the fix: a row that is not on screen
 * is not laid out. `scripts/stream-perf.mjs` is the harness that takes the
 * measurement. See `src/styles/app.css` for the numbers and the reasoning, and
 * `internal/frontends/tui/transcript.go`'s `markdownResults` for the same defect
 * on the other front end.
 *
 * **These read the stylesheet as text**, which is a poor way to test CSS in
 * general and the right way here: there is no build step between this file and
 * the rule, the declaration has no runtime behaviour to observe in Node, and what
 * is being protected is the *presence* of a rule rather than its effect. An
 * assertion about computed style would need a browser and would not fail any
 * less clearly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// Resolved from the project root, not from `import.meta.url`: the tests are
// bundled into `.test-build/` before they run, so a path relative to this module
// would point inside the build directory. The runner sets `cwd` to the root.
const cssPath = resolve(process.cwd(), 'src', 'styles', 'app.css');
const css = readFileSync(cssPath, 'utf8');
const streamCssPath = resolve(process.cwd(), 'src', 'styles', 'stream.css');
const streamCss = readFileSync(streamCssPath, 'utf8');
const globalCssPath = resolve(process.cwd(), 'src', 'styles', 'global.css');
const globalCss = readFileSync(globalCssPath, 'utf8');

/**
 * The declarations of one rule, as written.
 *
 * Deliberately naive: it finds `selector {` and reads to the matching `}`, which
 * is all the structure this stylesheet has. A real CSS parser would be a
 * dependency taken on to read twenty lines that a human wrote by hand.
 */
function ruleBody(selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

/** The same, against `stream.css`. */
function streamRuleBody(selector: string): string | null {
  const at = streamCss.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = streamCss.indexOf('{', at);
  const close = streamCss.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return streamCss.slice(open + 1, close);
}

/** The same, against `global.css` — where the fold vocabulary lives. */
function globalRuleBody(selector: string): string | null {
  const at = globalCss.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = globalCss.indexOf('{', at);
  const close = globalCss.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return globalCss.slice(open + 1, close);
}

test('the transcript does not lay out the rows nobody is looking at', () => {
  const body = ruleBody('.stream-inner > *');
  assert.ok(body !== null, 'the `.stream-inner > *` rule is gone from app.css');

  // The declaration itself. Without it a delta's cost grows with the length of
  // the conversation, because the bottom-follow write re-lays out all of it.
  assert.match(
    body,
    /content-visibility:\s*auto/,
    'the transcript rows no longer skip layout, so a long session streams slower ' +
      'as it grows — see scripts/stream-perf.mjs to re-measure',
  );
});

test('a skipped row still contributes a remembered height', () => {
  const body = ruleBody('.stream-inner > *');
  assert.ok(body !== null, 'the `.stream-inner > *` rule is gone from app.css');

  // `auto <length>`, and **both** halves matter:
  //
  //   - without `contain-intrinsic-size` at all, a skipped row contributes no
  //     height, the document collapses to something much shorter than the text in
  //     it, and the bottom-follow lands on a scrollHeight that is a lie;
  //   - without the `auto` keyword, the fallback length is used *forever* instead
  //     of each row's real height once it has been rendered once, so the
  //     scrollbar keeps describing a document that does not exist and the
  //     estimate never converges.
  const match = body.match(/contain-intrinsic-size:\s*auto\s+(\d+(?:\.\d+)?)(px|rem|em)/);
  assert.ok(
    match !== null,
    '`contain-intrinsic-size` must be `auto <length>` on the transcript rows: the ' +
      '`auto` keyword is what makes a refreshed row keep its real height',
  );

  // A sane fallback. It only ever applies to a row nobody has scrolled past yet,
  // but a value far off the real row height would still show as a jump the first
  // time somebody scrolls a long session.
  const px = Number(match[1]);
  assert.ok(
    px > 16 && px < 400,
    `the rows' estimated height is ${match[1]}${match[2]}, which is not a plausible ` +
      'row height for this transcript (measured: median ~58px, mean ~133px)',
  );
});

test('the skip is on the rows and not on the scroll container', () => {
  // The rule has to be on the children. `content-visibility` on `.stream-inner`
  // itself would skip the *whole* transcript whenever any part of it was off
  // screen, and `.stream-scroll`'s `flex: 1 1 auto` plus the viewport-sized
  // scrollbar would stop describing anything.
  for (const selector of ['.stream-inner', '.stream-scroll']) {
    const body = ruleBody(selector);
    assert.ok(body !== null, `${selector} is gone from app.css`);
    assert.doesNotMatch(
      body,
      /content-visibility/,
      `${selector} must keep its real height — the skip belongs on its children`,
    );
  }
});

/* ============================================================
   The terminal pane's rows
   ============================================================ */

test('a blank line in a terminal occupies a line', () => {
  // `min-height: var(--leading-code)` reads as "one line" and is not: the token
  // is `1.5`, a **unitless** number, which `line-height` accepts and `min-height`
  // drops as invalid. Measured in a browser, an empty `.term-line` came out 0.0px
  // tall against 18.8px for a non-empty one — so a blank line was invisible and
  // every row after it moved up by a full line. A `git status` or a columnar `ls`
  // then showed something the shell never printed.
  //
  // Asserted as text because that is the only place the mistake is visible: the
  // declaration has no behaviour to observe in Node, and nothing about the pane
  // *looks* broken — it just quietly disagrees with the terminal.
  const body = streamRuleBody('.term-line');
  assert.ok(body !== null, 'the `.term-line` rule is gone from stream.css');

  const declared = body.match(/min-height:\s*([^;]+);/);
  assert.ok(declared !== null, '`.term-line` must declare a `min-height` at all');
  const value = declared[1].trim();

  assert.notEqual(
    value,
    'var(--leading-code)',
    '`min-height: var(--leading-code)` is a unitless multiplier and is dropped as ' +
      'invalid, so a blank line collapses to zero height',
  );
  // Either form is fine; what matters is that the value is a length.
  assert.match(
    value,
    /^(calc\(|1em$)/,
    `\`min-height: ${value}\` is not a length this pane can rely on — use ` +
      '`calc(var(--text-code) * var(--leading-code))` or `1em`',
  );
});

/* ============================================================
   The streaming reasoning block
   ============================================================ */

test('the streaming reasoning block is contained from the transcript around it', () => {
  // The second half of "a long session streams slower as it grows", and the one
  // the character counter made visible: the client ticked fast for the first
  // steps of a session and then fell behind the TUI, and the cause was the folded
  // reasoning body still being laid out.
  //
  // A reasoning block grows a chunk at a time, quiet mode folds it, and
  // `.collapse` keeps the body **mounted** so the fold has something to
  // transition — so the text stayed in the layout tree and `pre-wrap` +
  // `break-word` re-broke all of it on every commit. Measured on a 40-step
  // session in quiet mode, one delta cost 17ms with 3k characters of reasoning on
  // screen and **242ms** with 128k, and the block length tracks the context —
  // which is why it only showed up once the session was long.
  //
  // `content-visibility: auto` is the fix. It is deliberately *not* `hidden`: the
  // body is one Ctrl+T away from being read, and a 130,776-character body must
  // still lay out in full when it is open.
  const body = streamRuleBody('.e-reason-body');
  assert.ok(body !== null, 'the `.e-reason-body` rule is gone from stream.css');

  assert.match(
    body,
    /content-visibility:\s*auto/,
    'the reasoning body is laid out by the whole document again, so one delta ' +
      'costs more the longer the model has been thinking — see the reasoning in ' +
      'stream.css for the measurement',
  );
  // `auto <length>` for the same reason as the transcript and the terminal: the
  // fallback only applies to an element that has never been laid out, and `auto`
  // is what makes the estimate converge to the real height afterwards.
  assert.match(
    body,
    /contain-intrinsic-size:\s*auto\s+\d+(?:\.\d+)?(px|rem|em)/,
    '`contain-intrinsic-size` must be `auto <length>` on the reasoning body too',
  );
});

test('the reasoning body is never hidden from layout', () => {
  // The cheap-looking alternative, and the one that was measured and rejected:
  // `content-visibility: hidden` on `.collapse.is-collapsed > *`. It flattens the
  // closed case as well as `auto` does, but `hidden` applies only while
  // `is-collapsed` is present — and that is the class the click *removes*, so the
  // block popped to full height instead of unfolding. The one animation the fold
  // exists for was gone, which is why the declaration belongs on the body as
  // `auto` (self-managing: expand it and the browser lays it out) rather than on
  // the fold wrapper as `hidden`.
  //
  // Pinned because the two are one keystroke apart in a stylesheet and read as
  // equivalent, while only one of them keeps the block readable.
  const body = streamRuleBody('.e-reason-body');
  assert.ok(body !== null, 'the `.e-reason-body` rule is gone from stream.css');
  assert.doesNotMatch(
    body,
    /content-visibility:\s*hidden/,
    '`hidden` unconditionally skips the reasoning body, so an *open* block is ' +
      'never laid out — use `auto`',
  );

  // And the fold wrapper itself must stay out of this: a skip keyed on
  // `is-collapsed` races the class removal that starts the unfold animation.
  const collapse = globalRuleBody('.collapse.is-collapsed');
  assert.ok(collapse !== null, 'the `.collapse.is-collapsed` rule is gone from global.css');
  assert.doesNotMatch(
    collapse,
    /content-visibility/,
    'the collapsed state must not skip its content: `is-collapsed` is removed to ' +
      'start the unfold, so the content pops in at full height with nothing to ' +
      'transition',
  );
});

test('the terminal pane skips the rows nobody is looking at', () => {
  // The same defect, in the same shape, at a larger size: this pane holds up to
  // `TERMINAL_SCROLLBACK` rows and re-renders all of them on every output batch.
  // `app.css` measured 14.0ms → 1.2ms on a 322-row transcript with 93% of the
  // cost in laying out rows that were off screen; a build log is longer than a
  // transcript, and the fix is one declaration.
  const body = streamRuleBody('.term-line');
  assert.ok(body !== null, 'the `.term-line` rule is gone from stream.css');

  assert.match(
    body,
    /content-visibility:\s*auto/,
    'terminal rows no longer skip layout, so a long build log re-renders every ' +
      'line it ever printed on each batch',
  );
  // `auto <length>` for the same reason as the transcript: without `auto` the
  // estimate is used for ever instead of each row's real height.
  assert.match(
    body,
    /contain-intrinsic-size:\s*auto\s+\d+(?:\.\d+)?(px|rem|em)/,
    '`contain-intrinsic-size` must be `auto <length>` on the terminal rows too',
  );
});
