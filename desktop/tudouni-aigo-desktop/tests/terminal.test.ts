/**
 * The workspace's two capabilities on the desktop side: the keystroke encoder,
 * the terminal output buffer, and the file browser's path arithmetic.
 *
 * All three are **pure functions**, which is why they are testable at all — and
 * they are pure on purpose, not by accident:
 *
 *   - the **keystroke encoder** is the one piece of terminal behaviour this front
 *     end owns (§12: the runtime takes raw bytes and deliberately does not parse
 *     them), and a wrong byte is invisible — it looks like a shell that ignored a
 *     key.
 *   - the **output buffer** replaces a scrollback the runtime deliberately does
 *     not keep, and its two failure modes are silent: a batch boundary mistaken
 *     for a line boundary breaks a word, and an unbounded buffer grows with the
 *     length of a command somebody ran.
 *   - the **parent path** is the boundary rule as arithmetic, and getting it
 *     wrong generates a `..` the runtime refuses — a button that looks broken.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeKey, isTerminalKey } from '@/runtime/terminalKeys';
import {
  applyTerminalOutput,
  DEFAULT_VIEWPORT_ROWS,
  fitViewport,
  initialTerminalState,
  tokenizeTerminalChunk,
} from '@/runtime/terminalOutput';
import {
  appendTerminalOutput,
  nextTerminalId,
  pruneTails,
  replaceTerminal,
  resizeTerminalTail,
  terminalEndedNote,
  TERMINAL_SCROLLBACK,
  type TerminalTail,
} from '@/state/store';
import { parentPath } from '@/components/panels/panels';
import { contentBoxOf } from '@/components/terminal/TerminalView';
import type { TerminalRow } from '@/protocol/types';

function key(name: string, mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {}) {
  return {
    key: name,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
    metaKey: mods.meta === true,
  };
}

/* ============================================================
   The keystroke encoder
   ============================================================ */

test('Ctrl+C is ETX and goes to the shell, not to the window', () => {
  // The single most common way a terminal front end makes a shell unusable:
  // treating Ctrl+C as "close this window". Inside a shell it means "interrupt
  // the command I started", and that is the whole reason a terminal is worth
  // having.
  assert.equal(encodeKey(key('c', { ctrl: true })), '\x03');
  assert.equal(encodeKey(key('C', { ctrl: true })), '\x03');
});

test('the control range is arithmetic, not a table', () => {
  // Ctrl+A is 0x01 because that is SOH, Ctrl+Z is 0x1A because that is SUB. The
  // numbers are the definition, which is why `Ctrl+\` (0x1C) works without
  // anybody having remembered to add it.
  assert.equal(encodeKey(key('a', { ctrl: true })), '\x01');
  assert.equal(encodeKey(key('d', { ctrl: true })), '\x04');
  assert.equal(encodeKey(key('z', { ctrl: true })), '\x1a');
  assert.equal(encodeKey(key('\\', { ctrl: true })), '\x1c');
  assert.equal(encodeKey(key('[', { ctrl: true })), '\x1b');
});

test('Enter sends CR and Backspace sends DEL', () => {
  // Not LF and not BS. A real terminal's Enter sends CR, and its Backspace sends
  // DEL — which a shell's line editor reads as "delete the character before the
  // cursor". BS would be Ctrl+H, whose binding differs between editors.
  assert.equal(encodeKey(key('Enter')), '\r');
  assert.equal(encodeKey(key('Backspace')), '\x7f');
  assert.equal(encodeKey(key('Tab')), '\t');
  assert.equal(encodeKey(key('Escape')), '\x1b');
});

test('the arrows and function keys are the sequences a real terminal sends', () => {
  assert.equal(encodeKey(key('ArrowUp')), '\x1b[A');
  assert.equal(encodeKey(key('ArrowDown')), '\x1b[B');
  assert.equal(encodeKey(key('ArrowRight')), '\x1b[C');
  assert.equal(encodeKey(key('ArrowLeft')), '\x1b[D');
  assert.equal(encodeKey(key('Delete')), '\x1b[3~');
  assert.equal(encodeKey(key('PageUp')), '\x1b[5~');
  // F1–F4 are SS3 and F5–F12 are CSI. That is a historical artefact of real
  // terminals rather than a choice, and readline matches on the exact bytes —
  // "close enough" is a key that does nothing.
  assert.equal(encodeKey(key('F1')), '\x1bOP');
  assert.equal(encodeKey(key('F5')), '\x1b[15~');
  assert.equal(encodeKey(key('F12')), '\x1b[24~');
});

test('a printable character goes out as itself, UTF-8 included', () => {
  assert.equal(encodeKey(key('a')), 'a');
  assert.equal(encodeKey(key('中')), '中');
  assert.equal(encodeKey(key(' ')), ' ');
});

test('Alt is the ESC prefix, which is what a real terminal sends', () => {
  // Not a convention of this program: the terminal sends ESC then the key, and
  // every readline-style editor reads it as "meta".
  assert.equal(encodeKey(key('b', { alt: true })), '\x1bb');
});

test('an unrepresentable key sends nothing rather than a guess', () => {
  // A guessed byte is a command that ran with a character nobody typed. Silence
  // is recoverable; a wrong byte is not.
  assert.equal(encodeKey(key('Shift')), '');
  assert.equal(encodeKey(key('Meta')), '');
  assert.equal(encodeKey(key('CapsLock')), '');
  // A modified arrow needs the `CSI 1;<modifier>` form for every one of the
  // arrows, and half those bindings differ between shells — so rather than send
  // a sequence that means something else, nothing is sent.
  assert.equal(encodeKey(key('ArrowUp', { shift: true })), '');
  assert.equal(encodeKey(key('ArrowUp', { ctrl: true })), '');
});

test('Shift+Tab is the one shifted named key with a real sequence', () => {
  assert.equal(encodeKey(key('Tab', { shift: true })), '\x1b[Z');
});

test('isTerminalKey answers what the window handlers ask it', () => {
  assert.equal(isTerminalKey(key('a')), true);
  assert.equal(isTerminalKey(key('Escape')), true);
  assert.equal(isTerminalKey(key('c', { ctrl: true })), true);
  // Escape included: while a terminal is attached, Escape is the ESC byte rather
  // than "close the panel" — which is why the window's Esc handler must ask.
  assert.equal(isTerminalKey(key('Shift')), false);
});

/* ============================================================
   The output buffer
   ============================================================ */

/** The lines one terminal is holding, for the assertions below. */
function linesOf(store: Record<string, TerminalTail>, id: string): string[] {
  return store[id]?.lines ?? [];
}

/**
 * A tail holding one line of output, built through the real pipeline.
 *
 * Not an object literal: a tail is now the screen *and its cursor*, and a literal
 * with the fields a test happens to know about is exactly how the fixtures and the
 * implementation ended up agreeing about a shape that was wrong. Building it from
 * the text means a fixture cannot be self-consistent and wrong at the same time.
 */
function tailOf(text: string): TerminalTail {
  return applyTerminalOutput(initialTerminalState(), text, TERMINAL_SCROLLBACK);
}

test('a batch boundary is not a line boundary', () => {
  // The PTY flushes wherever it happens to flush. A fragment that continues the
  // line already held must be joined to it, or a sentence breaks in the middle
  // of a word every time that happens.
  let store = appendTerminalOutput({}, 'term-01', 'npm ');
  store = appendTerminalOutput(store, 'term-01', 'test\r\n');
  assert.deepEqual(linesOf(store, 'term-01'), ['npm test', '']);
});

test('CRLF is normalised so the output does not collapse onto one line', () => {
  // A browser renders a raw `\r` inside a `<div>` as nothing at all.
  const store = appendTerminalOutput({}, 'term-01', 'one\r\ntwo\r\n');
  assert.deepEqual(linesOf(store, 'term-01'), ['one', 'two', '']);
});

test('each terminal keeps its own buffer', () => {
  let store = appendTerminalOutput({}, 'term-01', 'first\n');
  store = appendTerminalOutput(store, 'term-02', 'second\n');
  assert.deepEqual(linesOf(store, 'term-01'), ['first', '']);
  assert.deepEqual(linesOf(store, 'term-02'), ['second', '']);
});

test('the buffer is bounded, and it is the newest lines that survive', () => {
  // Without the bound this window's memory grows with the length of a command
  // somebody ran; dropping the recent output instead would leave the pane showing
  // the start of a build with no sign of the end.
  let store: Record<string, TerminalTail> = {};
  for (let i = 0; i < TERMINAL_SCROLLBACK + 500; i += 1) {
    store = appendTerminalOutput(store, 'term-01', `line ${i}\n`);
  }
  const lines = linesOf(store, 'term-01');
  assert.ok(lines.length <= TERMINAL_SCROLLBACK + 1, `kept ${lines.length} lines`);
  assert.ok(lines.some((line) => line.includes(`line ${TERMINAL_SCROLLBACK + 499}`)));
  assert.ok(!lines.some((line) => line.includes('line 0\n')));
});

test('the buffer is copied, never mutated in place', () => {
  // The store's patch helpers compare references; mutating the array a previous
  // state holds is how a React render silently shows nothing new. The screen is
  // copied once per batch for the same reason — a batch of pure cursor movement
  // would otherwise return a state whose `rows` is identical by reference, and the
  // pane would not redraw.
  const before: Record<string, TerminalTail> = {
    'term-01': applyTerminalOutput(initialTerminalState(), 'a', TERMINAL_SCROLLBACK),
  };
  const after = appendTerminalOutput(before, 'term-01', 'b');
  assert.notEqual(after, before);
  assert.notEqual(after['term-01'], before['term-01']);
  assert.notEqual(after['term-01'].rows, before['term-01'].rows);
  assert.deepEqual(before['term-01'].lines, ['a']);
  assert.deepEqual(after['term-01'].lines, ['ab']);
});

/* ============================================================
   PTY bytes → text
   ============================================================ */

test('a prompt with escape sequences around it reads as the prompt', () => {
  // The measured shape of a real ConPTY prompt. Before this was stripped, every
  // one of these bytes was drawn literally — `▯[?25l` in the middle of a shell
  // prompt, which is exactly what the screenshot showed.
  const raw =
    '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H' +
    'PS C:\\ws>\x1b[1C\x1b]0;C:\\WINDOWS\\powershell.exe\x07\x1b[?25h';
  const state = applyTerminalOutput(initialTerminalState(), raw, TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['PS C:\\ws>']);
});

test('a lone carriage return rewrites its line rather than appending', () => {
  // A progress bar redraws itself. The last rewrite is what a terminal would be
  // showing; drawing all of them prints `10%50%100% done` on one line.
  const state = applyTerminalOutput(initialTerminalState(), '10%\r50%\r100% done', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['100% done']);
});

test('sgr colour codes go, and the text between them stays', () => {
  // `\x1b[93mecho \x1b[37mMARK` is a real PowerShell line: the colours are
  // instructions, the words are the output.
  const state = applyTerminalOutput(
    initialTerminalState(),
    '\x1b[93mecho \x1b[37mMARK\x1b[?25h',
    TERMINAL_SCROLLBACK,
  );
  assert.deepEqual(state.lines, ['echo MARK']);
});

/* ============================================================
   The cursor: the two measured ConPTY shapes that made the old
   renderer wrong. Both are regression tests for reported bugs.
   ============================================================ */

test('typing does not accumulate: each keystroke redraws its line', () => {
  // **The reported bug.** PSReadLine does not append what changed; it redraws the
  // line, moving the cursor back over the part that did not change. These are the
  // measured bytes from a real powershell, one batch per keystroke:
  //
  //     a  ->  ESC[93m  a             ESC[?25h
  //     b  ->  ESC[93m  \b ab         ESC[?25h
  //     c  ->  ESC[93m  ESC[1;60H abc ESC[?25h
  //
  // Append-only rendering (what this used to do) produced `a`, `aab`, `aababc` —
  // the pane stopped showing what had been typed, and it got worse with every key.
  // Measured on a 27-character command, the drawn line reached 385 characters.
  let state = initialTerminalState();
  for (const batch of ['\x1b[93ma\x1b[?25h', '\x1b[93m\bab\x1b[?25h', '\x1b[93m\x1b[1;60Habc\x1b[?25h']) {
    state = applyTerminalOutput(state, batch, TERMINAL_SCROLLBACK);
  }
  // The prompt that the column-60 home is measured against, so the position is the
  // real one rather than an accident of a short line.
  assert.equal(state.col, 60 + 3 - 1, 'the cursor sits after the three characters');
});

test('a redraw lands on the characters it redraws', () => {
  // The same rule stated as text: prompt, then four keystrokes of a word being
  // rewritten. The line must read the last redraw and nothing else.
  let state = applyTerminalOutput(initialTerminalState(), 'PS> ', TERMINAL_SCROLLBACK);
  const promptCol = state.col;
  for (const word of ['a', 'ab', 'abc', 'abcd']) {
    state = applyTerminalOutput(
      state,
      // Home to the prompt, then the whole word: the shape ConPTY uses when the
      // cursor has to travel further than a backspace can take it.
      `\x1b[${promptCol + 1}G${word}`,
      TERMINAL_SCROLLBACK,
    );
  }
  assert.deepEqual(state.lines, ['PS> abcd']);
});

test('a backspace moves the cursor instead of being drawn', () => {
  // `\b` is a cursor move, so a redraw of a shorter word overwrites rather than
  // leaving the tail of the longer one behind.
  let state = applyTerminalOutput(initialTerminalState(), 'abc', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, '\b\b', TERMINAL_SCROLLBACK);
  assert.equal(state.col, 1);
  state = applyTerminalOutput(state, 'X', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['aXc']);
});

test('erase-to-end-of-line removes what was there', () => {
  // `ESC[K` after a redraw is how a shell clears the remains of a longer previous
  // line. It erased nothing before this, so the two lines merged.
  let state = applyTerminalOutput(initialTerminalState(), 'a long first value', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, '\x1b[1G\x1b[Kshort', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['short']);
});

test('a resize repaint does not duplicate the screen or add blank lines', () => {
  // **The second reported bug.** ConPTY answers `terminal_resize` by resending the
  // whole screen: home, every row, `ESC[K` for each row below the content, then put
  // the cursor back. These are the measured bytes for a resize to 16 rows.
  //
  // Append-only rendering made one screenful into two copies plus the trailing
  // erasures as blank lines: measured in the app, folding a rail took the pane from
  // 61 lines to 90, of which **84 were blank**.
  const rows = 16;
  let state = initialTerminalState(rows);
  state = applyTerminalOutput(state, 'PS C:\\ws> "R1"; "R2"\r\nR1\r\nR2\r\nPS C:\\ws> ', TERMINAL_SCROLLBACK);
  const before = state.lines;
  assert.deepEqual(before, ['PS C:\\ws> "R1"; "R2"', 'R1', 'R2', 'PS C:\\ws> ']);

  // The repaint, verbatim: home, the content rows with `ESC[K`, then an `ESC[K`
  // for each remaining row of the screen, then the cursor restored. The count is
  // the measured one — **one fewer CRLF than there are rows**, because the shell
  // does not emit a newline after the last row it repaints. That matters: an extra
  // newline at the bottom of the screen scrolls it, which would move the text
  // instead of redrawing it.
  const content = ['PS C:\\ws> "R1"; "R2"', 'R1', 'R2', 'PS C:\\ws> '];
  const blankRows = rows - content.length;
  let repaint = '\x1b[?25l\x1b[8;16;70t\x1b[H';
  repaint += content.map((line) => `${line}\x1b[K\r\n`).join('');
  repaint += '\x1b[K\r\n'.repeat(blankRows - 1);
  repaint += '\x1b[K';
  repaint += '\x1b[4;11H\x1b[?25h';

  const after = applyTerminalOutput(state, repaint, TERMINAL_SCROLLBACK);
  assert.deepEqual(after.lines, before, 'the repaint draws the same screen, not a second copy');
  assert.equal(after.lines.filter((line) => line === '').length, 0, 'and no blank rows');
  assert.equal(after.screenTop, state.screenTop, 'and the screen did not scroll');
});

test('a resize that grows the shell scrolls where the shell says it does', () => {
  // The cursor is addressed in **screen** rows, so the model has to know how tall
  // the screen is: the same `CSI 9;1H` is the bottom row of a 10-row shell and the
  // ninth of a twenty-row one. Getting this wrong puts a repaint on the wrong line.
  const tall = fitViewport(initialTerminalState(24), 10);
  assert.equal(tall.viewportRows, 10);

  // `\n` at the bottom of a 2-row screen scrolls; the same on a taller screen does
  // not, because there are rows left below the cursor. The scroll is `screenTop`
  // moving — the rows themselves are never renumbered, which is what lets the
  // absolute `CSI r;cH` a shell sends next land where it means.
  let short = initialTerminalState(2);
  short = applyTerminalOutput(short, 'one\r\ntwo', TERMINAL_SCROLLBACK);
  const topBefore = short.screenTop;
  assert.deepEqual(short.lines, ['one', 'two']);

  short = applyTerminalOutput(short, '\r\nthree', TERMINAL_SCROLLBACK);
  assert.equal(short.screenTop, topBefore + 1, 'the screen scrolled by one row');
  // `one` is still drawn: the pane is a log of the whole buffer, and a row that
  // scrolled off the *shell's* screen is still something the person can read.
  assert.deepEqual(short.lines, ['one', 'two', 'three']);
  // And the screen is now the last two of those rows.
  assert.deepEqual(short.rows.slice(short.screenTop, short.screenTop + 2), ['two', 'three']);
});

test('shrinking then growing the screen keeps what was on it', () => {
  // The pane is resized when a rail is folded and again when it is unfolded, and
  // the text a person was reading must survive both.
  let state = applyTerminalOutput(initialTerminalState(24), 'alpha\r\nbeta', TERMINAL_SCROLLBACK);
  state = fitViewport(state, 4);
  assert.equal(state.viewportRows, 4);
  assert.deepEqual(state.lines, ['alpha', 'beta']);
  state = fitViewport(state, 24);
  assert.equal(state.viewportRows, 24);
  assert.deepEqual(state.lines, ['alpha', 'beta']);
});

test('a sequence split across two batches is held, not shown', () => {
  // A PTY flushes wherever it flushes, so `\x1b[` can arrive in one batch and
  // `0m` in the next. A stateless scanner would print a stray `0m` in the middle
  // of somebody's output — often enough to look like a memory bug.
  const first = tokenizeTerminalChunk('', 'before \x1b[');
  assert.equal(first.carry, '\x1b[');
  assert.deepEqual(first.tokens, [{ kind: 'text', value: 'before ' }]);

  const second = tokenizeTerminalChunk(first.carry, '0mafter');
  assert.equal(second.carry, '');
  // `ESC[0m` completed a real sequence, so it comes back as one token rather than
  // as the text `0m` — which is the whole point: the bytes a person must never see
  // in the middle of their output.
  assert.deepEqual(second.tokens, [
    { kind: 'escape', final: 'm', params: '0' },
    { kind: 'text', value: 'after' },
  ]);
});

test('the carry survives into the store, so the split is invisible', () => {
  // The same case end to end: one line, arriving as two batches.
  let store = appendTerminalOutput({}, 'term-01', 'PS> \x1b[?25');
  store = appendTerminalOutput(store, 'term-01', 'lDone');
  assert.deepEqual(linesOf(store, 'term-01'), ['PS> Done']);
  assert.equal(store['term-01'].carry, '');
});

test('control characters have no meaning once the bytes are text', () => {
  // A Windows console scatters NULs through its output, and a browser draws them
  // as nothing — or as a box. Newline and tab are the two that stay meaningful.
  const stripped = applyTerminalOutput(initialTerminalState(), 'a\x00b\x07c', TERMINAL_SCROLLBACK);
  assert.deepEqual(stripped.lines, ['abc']);
  // Tab advances to the next tab stop rather than being drawn as a gap of one
  // space, and a newline starts a row.
  const tabbed = applyTerminalOutput(initialTerminalState(), 'a\tb', TERMINAL_SCROLLBACK);
  assert.deepEqual(tabbed.lines, ['a       b']);
  // DEL and the C1 range go too. C1 matters rather than being pedantry: the
  // runtime's own stripper drops it, so keeping it here would make the two front
  // ends disagree about what a shell's output says.
  const c1 = applyTerminalOutput(initialTerminalState(), 'a\x7fb\x9bc', TERMINAL_SCROLLBACK);
  assert.deepEqual(c1.lines, ['abc']);
});

test('an unterminated sequence is eventually shown rather than held for ever', () => {
  // A front end that buffered an unbounded "incomplete" escape would grow its
  // state on malformed output. Showing the raw bytes is a far better failure than
  // showing nothing at all.
  const held = tokenizeTerminalChunk('', '\x1b]0;' + 'x'.repeat(600));
  assert.equal(held.carry, '');
  assert.ok(
    held.tokens.some((token) => token.kind === 'text' && token.value.length > 600),
    'the over-long sequence was not released',
  );

  // The same for one that spans a newline, which is not a sequence we will ever
  // complete.
  const across = tokenizeTerminalChunk('', '\x1b]0;title\nnext line');
  assert.equal(across.carry, '');
});

test('an OSC title is stripped whole, terminator and all', () => {
  // PowerShell writes the window title; drawing it would put the executable's
  // path in the middle of the prompt.
  const state = applyTerminalOutput(
    initialTerminalState(),
    '\x1b]0;C:\\WINDOWS\\system32\x1b\\PS> ',
    TERMINAL_SCROLLBACK,
  );
  assert.deepEqual(state.lines, ['PS> ']);
});

test('pruneTails drops what the runtime no longer lists, and keeps the rest', () => {
  // A tail belongs to a terminal that exists. One kept for an id the runtime has
  // forgotten is memory this window can never free — nothing will append to it and
  // nothing will draw it.
  const tails: Record<string, TerminalTail> = {
    'term-01': tailOf('a'),
    'term-02': tailOf('b'),
  };
  const pruned = pruneTails(tails, [row('term-02', 'running')], null);
  assert.deepEqual(Object.keys(pruned), ['term-02']);

  // And nothing is copied when nothing was dropped, so a snapshot mentioning only
  // known terminals does not re-render the pane.
  assert.equal(
    pruneTails(tails, [row('term-01', 'running'), row('term-02', 'running')], null),
    tails,
  );
});

test('a finished terminal\'s output is released; a running one\'s is not', () => {
  // The **row** stays for an ended shell on purpose — it is what answers "what was
  // I running". The output does not: up to `TERMINAL_SCROLLBACK` lines per shell,
  // and a long session with a dozen finished ones was holding a dozen of them for
  // ever, since nothing appends to a forgotten id and only the attached tail can
  // be drawn.
  const tails: Record<string, TerminalTail> = {
    'term-live': tailOf('still going'),
    'term-done': tailOf('long gone'),
  };
  const rows = [row('term-live', 'running'), row('term-done', 'exited')];
  assert.deepEqual(Object.keys(pruneTails(tails, rows, null)), ['term-live']);

  // **Except the one somebody is reading.** An ended shell's last screenful is a
  // record a person may still be looking at, and dropping it while the pane is
  // pointed at that id would blank the view.
  assert.deepEqual(
    Object.keys(pruneTails(tails, rows, 'term-done')).sort(),
    ['term-done', 'term-live'],
  );
});

/* ============================================================
   The terminal row on exit
   ============================================================ */

function row(id: string, status: TerminalRow['status']): TerminalRow {
  return {
    id,
    workspace: '/ws',
    cwd: '',
    shell: 'sh',
    pid: 1,
    status,
    exit_code: null,
    created_at: 0,
    cols: 80,
    rows: 24,
  };
}

test('an exit replaces the row rather than merging two fields by hand', () => {
  const rows = [row('term-01', 'running'), row('term-02', 'running')];
  const exited = { ...row('term-01', 'exited'), exit_code: 0 };
  const next = replaceTerminal(rows, exited);
  assert.equal(next[0].status, 'exited');
  assert.equal(next[0].exit_code, 0);
  assert.equal(next[1].status, 'running');
});

test('a terminal that ends before any snapshot mentioned it is still added', () => {
  // Real: a shell can exit faster than the next `ui(state)` arrives, and a row
  // that vanished would take its exit code with it.
  const next = replaceTerminal([], row('term-01', 'exited'));
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'term-01');
});

/* ============================================================
   Which terminal the view goes to when the one being read goes away
   ============================================================ */

test('closing one of two tabs leaves the other on screen, not the transcript', () => {
  // **The reported bug, in one assertion.** The screenshot shows `term-02` and
  // `term-05` both running; closing either one threw the whole terminal view away
  // and returned to the conversation, while the other shell kept running behind
  // it — visible afterwards only in the sidebar's Terminals list, which is where
  // the report noticed it.
  //
  // The cause was a line that read deliberately: `activeTerminalId` was set to
  // `null` on every close, and `null` is this window's "leave the terminal view".
  // That is right for the **last** tab and wrong for every other one.
  const rows = [row('term-02', 'running'), row('term-05', 'running')];
  assert.equal(nextTerminalId(rows, 'term-02'), 'term-05');
  assert.equal(nextTerminalId(rows, 'term-05'), 'term-02');
});

test('the last tab really does go back to the conversation', () => {
  // The one case where `null` — leave — is the right answer, so the fix above
  // does not turn "close my last shell" into a view with nothing in it.
  assert.equal(nextTerminalId([row('term-02', 'running')], 'term-02'), null);
  assert.equal(nextTerminalId([], null), null);
});

test('a running shell wins over an ended one, whatever the order', () => {
  // A terminal page is open to type into something; a row whose process is gone
  // is a record of what was typed before. So when both are left, the live one is
  // what a person means — and it must win even when the ended row is newer,
  // because "newest" is a tiebreak here and not the rule.
  const endedNewest = [row('term-01', 'running'), row('term-02', 'exited')];
  assert.equal(nextTerminalId(endedNewest, 'term-03'), 'term-01');

  const endedOnly = [row('term-01', 'killed'), row('term-02', 'exited')];
  // With nothing running, the newest ended one is still a terminal somebody can
  // read the last screenful of — which is the point of keeping the row at all.
  assert.equal(nextTerminalId(endedOnly, null), 'term-02');
});

test('newest wins among equals, and the list is in creation order', () => {
  // `terminal.Manager.List` returns creation order, so the last match is the
  // shell opened most recently — the one a person means by "the terminal".
  const rows = [row('term-01', 'running'), row('term-02', 'running'), row('term-03', 'running')];
  assert.equal(nextTerminalId(rows, null), 'term-03');
  assert.equal(nextTerminalId(rows, 'term-03'), 'term-02');
});

test('the choice is the next one, never the one being closed', () => {
  // The `exclude` argument is not decoration: `closeTerminal` chooses a
  // replacement *before* the runtime has answered, when the row being closed is
  // still in the list. Without the exclusion the view would be pointed straight
  // back at the terminal whose process is going away — a pane that goes blank a
  // round trip later.
  const rows = [row('term-01', 'running'), row('term-02', 'running')];
  assert.notEqual(nextTerminalId(rows, 'term-01'), 'term-01');
  assert.notEqual(nextTerminalId(rows, 'term-02'), 'term-02');
});

test('the three endings stay three facts, and none of them is a sentence', () => {
  // `killed`, `exited` with a code, and `exited` without one are different facts.
  // A killed shell did not choose an exit status, so a number must not be
  // invented for it — and a process killed by a signal on POSIX is exactly that
  // case.
  //
  // **What is asserted here is the code, not a string**, and that is the point
  // of the change this test came with: the sentence used to be assembled inside
  // the store (`terminalExitText`), which put English in the reducer and made the
  // one line a person reads about a dead shell unreachable by `i18n`. The fact
  // now travels as `{code, id, reason, exitCode}` and the words live in the
  // translation table, so the store-side assertion is about which of the three
  // facts was recorded.
  const id = 'term';
  const killed = terminalEndedNote(id, 'killed', null);
  const exitedWithCode = terminalEndedNote(id, 'exited', 0);
  const exitedNoCode = terminalEndedNote(id, 'exited', null);

  assert.equal(killed.reason, 'killed');
  // A killed shell's code is null and stays null: there was no exit status to
  // report, and `0` would say "it finished cleanly".
  assert.equal(killed.exitCode, null);
  assert.equal(exitedWithCode.exitCode, 0);
  assert.equal(exitedNoCode.exitCode, null);

  // The three are distinguishable by what the renderer reads, which is what makes
  // three sentences possible rather than two.
  assert.notDeepEqual(killed, exitedNoCode);
  assert.notDeepEqual(exitedNoCode, exitedWithCode);
});

/* ============================================================
   The file browser's path arithmetic
   ============================================================ */

test('the workspace root is the empty string and its own parent', () => {
  // Walking up from the top has to stop rather than produce `..`, which the
  // runtime refuses. A button that generates a refusal notice looks broken, and
  // the person pressing it has done nothing wrong.
  assert.equal(parentPath(''), '');
  assert.equal(parentPath('src'), '');
  assert.equal(parentPath('/'), '');
});

test('a parent path is the workspace-relative one, whatever the separator', () => {
  assert.equal(parentPath('src/main.go'), 'src');
  assert.equal(parentPath('src/components'), 'src');
  assert.equal(parentPath('src/components/'), 'src');
  assert.equal(parentPath('a/b/c/d'), 'a/b/c');
});

test('a parent path never escapes, however deep the call', () => {
  // Four levels of walking up from a one-level path must land on the root and
  // stay there — this is the boundary rule expressed as arithmetic on the front
  // end's side of the wire.
  let path = 'one';
  for (let i = 0; i < 6; i += 1) path = parentPath(path);
  assert.equal(path, '');
});

/* ============================================================
   The pane's usable size — what gets reported to the shell
   ============================================================ */

/** The measurements the report took off a real pane, in headless Chrome. */
const PANE = {
  clientWidth: 424,
  clientHeight: 400,
  offsetWidth: 424,
  paddingLeft: 12,
  paddingRight: 12,
  paddingTop: 8,
  paddingBottom: 8,
};

/** Consolas at 12.5px, measured in the same run. */
const CELL = { width: 6.873, height: 18.8 };

test('the reported size is the content box, not the padded box', () => {
  // **This is the whole of the bug, in three lines of arithmetic.** `clientWidth`
  // includes padding, and this pane has `--space-2 --space-3` (8px vertical,
  // 12px horizontal). The report's measurement: 424px of `clientWidth` with a
  // 6.873px cell reported **61** columns, where the 400px that characters can
  // actually occupy is **58**. A shell told 61 wraps its output past the pane's
  // right edge — the same failure as never resizing at all, reached from the
  // other side.
  //
  // The irony worth recording: the code that measures the cell says in its own
  // comment that a 20%-wrong cell width "is the same failure as not resizing at
  // all". It measured the cell precisely and then divided by the wrong box.
  const box = contentBoxOf(PANE);
  assert.equal(box.width, 400, 'the content width is clientWidth minus padding');
  assert.equal(box.height, 384, 'the content height is clientHeight minus padding');

  assert.equal(Math.floor(box.width / CELL.width), 58, 'the real column count');
  // The old arithmetic, stated so the regression is visible if somebody reverts
  // to `clientWidth` — this assertion is what fails then.
  assert.equal(Math.floor(PANE.clientWidth / CELL.width), 61);
  assert.notEqual(
    Math.floor(PANE.clientWidth / CELL.width),
    Math.floor(box.width / CELL.width),
    'the padded box and the content box must not agree — if they do, the padding ' +
      'has been dropped from the calculation again',
  );
});

test('a scrollbar comes out of the reported size too', () => {
  // `overflow: auto` takes a vertical scrollbar out of `clientWidth` already, but
  // a **horizontal** one — which `white-space: pre` makes likely — only shows up
  // through `offsetWidth - clientWidth`. A `rows` that ignores it is a line too
  // tall, which is a `vim` that draws one row past the bottom.
  const box = contentBoxOf({ ...PANE, offsetWidth: 424 + 15 });
  assert.equal(box.width, 400 - 15);
});

test('a pane measured mid-layout still reports a size a shell can use', () => {
  // The runtime refuses a nonsensical size (see `resizeTerminal`), and a zero
  // here would be dropped as "the client did not say" — leaving the shell at its
  // default width rather than the one the pane will have a frame later.
  const box = contentBoxOf({
    clientWidth: 10,
    clientHeight: 0,
    offsetWidth: 10,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
  });
  assert.equal(box.width, 1);
  assert.equal(box.height, 1);
});
