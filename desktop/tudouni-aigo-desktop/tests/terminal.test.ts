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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { encodeKey, encodePaste, isTerminalKey } from '@/runtime/terminalKeys';
import {
  ansiColour,
  applyTerminalOutput,
  attrStyle,
  caretPosition,
  DEFAULT_ATTR,
  DEFAULT_VIEWPORT_ROWS,
  fitViewport,
  initialTerminalState,
  lineSegments,
  rgbColour,
  tokenizeTerminalChunk,
} from '@/runtime/terminalOutput';
import type { TerminalAttr } from '@/runtime/terminalOutput';
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
   Pasting
   ============================================================ */

test('a paste is sent byte for byte, unchanged when it has no line breaks', () => {
  assert.equal(encodePaste('echo hello'), 'echo hello');
  assert.equal(encodePaste('中 文'), '中 文');
});

test('a newline inside a paste is Ctrl+J (LF), not CR — Enter would submit the line', () => {
  // The pane is not a terminal emulator: a pasted newline delivered as CR would
  // run whatever the shell had as a command, then the next line as another.
  assert.equal(encodePaste('line1\nline2'), 'line1\x0aline2');
});

test('CRLF and lone CR are normalised before they can become an Enter', () => {
  assert.equal(encodePaste('a\r\nb'), 'a\x0ab');
  assert.equal(encodePaste('a\rb'), 'a\x0ab');
});

test('a trailing newline is dropped: the selection ended at a line break, not an Enter', () => {
  assert.equal(encodePaste('echo hello\n'), 'echo hello');
  assert.equal(encodePaste('echo hello\r\n'), 'echo hello');
});

test('an empty or newline-only clipboard sends nothing', () => {
  // Internal whitespace is kept — a pasted space is input — but a clipboard that
  // is only line breaks would send nothing but an Enter, which submits whatever
  // the shell had.
  assert.equal(encodePaste(''), '');
  assert.equal(encodePaste('\n\n'), '');
  assert.equal(encodePaste(' \n '), ' \n ');
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

test('sgr colour codes are instructions: the text stays, the colour is kept', () => {
  // `\x1b[93mecho \x1b[37mMARK` is a real PowerShell line: the colours are
  // instructions, the words are the output. Both halves matter — the codes must
  // not be drawn as text (which is what the old version tested), and the colour
  // they set must not be thrown away either (which is what it did).
  const state = applyTerminalOutput(
    initialTerminalState(),
    '\x1b[93mecho \x1b[37mMARK\x1b[?25h',
    TERMINAL_SCROLLBACK,
  );
  assert.deepEqual(state.lines, ['echo MARK']);
  // Two runs, because the colour changes in the middle of the line.
  assert.deepEqual(
    state.runs[0].map((run) => [run.start, run.end, run.attr.color]),
    [
      [0, 5, ansiColour(11)],
      [5, 9, ansiColour(7)],
    ],
  );
});

/* ============================================================
   Colour: the pen, the runs, and where they have to follow the text.

   The failures these cover are all **silent and positional**: a run that is not
   moved with its text draws the right colours on the wrong words, and nothing
   about the pane looks broken enough to notice until a long command has scrolled.
   ============================================================ */

/** The colour a run reports, as the CSS the pane will paint. */
function colourOf(attr: TerminalAttr | null): string | null {
  return attr === null ? null : attr.color;
}

test('the pen survives a batch boundary', () => {
  // A shell emits `ESC[93m`, flushes, and the text arrives in the next read. A pen
  // reset per batch would colour the first fragment of every flush and nothing
  // else — which reads as "the colours flicker", not as a bug in a buffer.
  let store = appendTerminalOutput({}, 'term-01', '\x1b[31mred ');
  store = appendTerminalOutput(store, 'term-01', 'still red\n');
  const tail = store['term-01'];
  assert.deepEqual(tail.lines, ['red still red', '']);
  assert.deepEqual(
    tail.runs[0].map((run) => [run.start, run.end, run.attr.color]),
    [[0, 13, ansiColour(1)]],
  );
});

test('the off codes end a colour, rather than colouring the rest of the session', () => {
  // `ESC[1m…ESC[22m` is how a shell does one bold word. Reading only the "on" half
  // would leave everything after that word bold for ever — a renderer that "forgot
  // where the word ended", which is exactly what it would be.
  const state = applyTerminalOutput(
    initialTerminalState(),
    '\x1b[1mbold\x1b[22m plain\x1b[31m then red\x1b[39m back',
    TERMINAL_SCROLLBACK,
  );
  assert.deepEqual(state.lines, ['bold plain then red back']);
  const runs = state.runs[0];
  const bold = runs.find((run) => run.attr.bold);
  assert.equal(bold?.start, 0);
  assert.equal(bold?.end, 4);
  // 22 clears bold, and the default pen is the absence of a run — so the word after
  // it must not be inside any run at all.
  assert.equal(
    runs.some((run) => run.start < 5 && run.end > 5 && run.attr.bold),
    false,
  );
  // 39 restores the default foreground, so the tail is uncoloured.
  assert.equal(runs.some((run) => run.start >= 20), false);
});

test('a 256-colour select reads its index, not its selector', () => {
  // The bug this pins: reading the colour out of the parameters *after* the `38`
  // takes the `5` as the index, so `38;5;196` draws colour 5 and swallows the 196.
  const state = applyTerminalOutput(initialTerminalState(), '\x1b[38;5;196mX', TERMINAL_SCROLLBACK);
  assert.equal(colourOf(state.runs[0][0].attr), ansiColour(196));
  assert.notEqual(colourOf(state.runs[0][0].attr), ansiColour(5));
});

test('truecolour is read in both the semicolon and the colon form', () => {
  // The colon form carries a colour-space id between the `2` and the components
  // (`38:2:0:255:0:0`), and programs do write it with the id empty. Stepping over
  // it in the semicolon form too would lose the red channel — which is a wrong
  // colour that still looks plausible.
  const semi = applyTerminalOutput(initialTerminalState(), '\x1b[38;2;255;0;0mS', TERMINAL_SCROLLBACK);
  assert.equal(colourOf(semi.runs[0][0].attr), rgbColour(255, 0, 0));
  const colon = applyTerminalOutput(initialTerminalState(), '\x1b[38:2::255:0:0mC', TERMINAL_SCROLLBACK);
  assert.equal(colourOf(colon.runs[0][0].attr), rgbColour(255, 0, 0));
});

test('a private sequence that happens to end in `m` is not SGR', () => {
  // `CSI >4;2m` shares the final byte with SGR and means something else entirely.
  // Reading it as colour would paint a shell's output from an instruction that was
  // never about colour — and `?25m` is not even a mode anyone sets.
  const state = applyTerminalOutput(initialTerminalState(), '\x1b[>4;2mplain', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.runs[0], []);
  assert.deepEqual(state.lines, ['plain']);
});

test('a redraw lands its colour on the characters it redraws', () => {
  // The prompt-redraw shape, with colour: PSReadLine moves the cursor back over the
  // part of the line that did not change — with a backspace for one column and with
  // an absolute movement when it is longer — and re-sends the colour before writing.
  // The run has to follow the *text*, so a rewrite that replaces columns 0..3 leaves
  // exactly those columns coloured.
  const moved = '\x1b[3D';
  let state = applyTerminalOutput(initialTerminalState(), '\x1b[93mabc', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, `${moved}\x1b[93mXYc`, TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['XYc']);
  assert.deepEqual(
    state.runs[0].map((run) => [run.start, run.end, run.attr.color]),
    [[0, 3, ansiColour(11)]],
  );
});

test('a shorter rewrite does not leave the old colour behind it', () => {
  // The failure this exists for: `red-and-long` rewritten as `short` used to leave
  // the run covering columns past the new end, so the *next* thing written on that
  // row inherited a colour nobody set.
  let state = applyTerminalOutput(initialTerminalState(), '\x1b[31mred-and-long', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, '\rshort\x1b[K', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['short']);
  assert.deepEqual(
    state.runs[0].map((run) => [run.start, run.end]),
    [[0, 5]],
  );
});

test('erasing a row takes its colours with it', () => {
  // `ESC[2J` clears the screen; a model that cleared the text and kept the runs
  // would colour the rows the shell writes next with the colours of the rows it
  // wiped. Asserted **on the wipe itself**, before anything is written: the pen is
  // sticky by design (see the batch-boundary case above), so a `fresh` written
  // after this is still red — and that is the shell's business, not the erase's.
  let state = applyTerminalOutput(initialTerminalState(), '\x1b[41mone\r\ntwo', TERMINAL_SCROLLBACK);
  assert.equal(state.runs[0].length, 1);
  state = applyTerminalOutput(state, '\x1b[2J\x1b[H', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['']);
  assert.deepEqual(state.runs[0], []);
});

test('an erase-to-end keeps the colour that is still on screen', () => {
  // `ESC[K` from the middle of a coloured line wipes the tail and keeps the head —
  // including the head's colour, which is still visible and still the shell's.
  // `green tail` is ten columns, so `3D` leaves the cursor on column 7.
  let state = applyTerminalOutput(initialTerminalState(), '\x1b[32mgreen tail', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, '\x1b[3D\x1b[K', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.lines, ['green t']);
  assert.deepEqual(
    state.runs[0].map((run) => [run.start, run.end, run.attr.color]),
    [[0, 7, ansiColour(2)]],
  );
});

test('the two row lists stay the same length through a scroll', () => {
  // `runs.length === rows.length` is the model's structural invariant, and a scroll
  // is where it breaks if the two are not moved together: from that moment on every
  // row wears the colours of the row above it.
  const state = applyTerminalOutput(
    initialTerminalState(2),
    'one\r\ntwo\r\n\x1b[31mthree\r\nfour',
    TERMINAL_SCROLLBACK,
  );
  assert.equal(state.runs.length, state.rows.length);
});

test('a tall pane grows both lists, not just the text one', () => {
  // A resize to a taller screen appends blank rows. Appending them without their
  // (empty) runs is the same off-by-one as an unscrolled run list.
  const grown = fitViewport(initialTerminalState(4), 40);
  assert.equal(grown.rows.length, grown.runs.length);
  assert.equal(grown.rows.length, grown.screenTop + grown.viewportRows);
});

test('the trim carries the colours of the newest rows, and only those', () => {
  // The buffer bound drops the oldest rows. A trim that sliced only the text would
  // shift every colour up by the number of rows dropped, and the pane would show
  // the last line of a build in the colour of the third-to-last.
  const state = applyTerminalOutput(initialTerminalState(2), 'a\r\nb\r\n\x1b[31mRED', 2);
  assert.deepEqual(state.lines, ['b', 'RED']);
  const last = state.runs[state.runs.length - 1];
  assert.equal(colourOf(last[0]?.attr ?? null), ansiColour(1));
  assert.deepEqual(state.runs[0], []);
});

test('the same pen twice is one run, not two', () => {
  // A shell writes a line across several flushes, and PSReadLine re-sends the
  // colour before every redraw. One run per flush would be thousands of spans in a
  // build log, each with its own style object for React to diff.
  let state = applyTerminalOutput(initialTerminalState(), '\x1b[36mabc', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, 'def', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, '\x1b[36mghi', TERMINAL_SCROLLBACK);
  assert.deepEqual(
    state.runs[0].map((run) => [run.start, run.end]),
    [[0, 9]],
  );
});

test('the same pen twice is the same object, which is what the pane caches on', () => {
  // The pane keys its style cache by attr identity. Re-sending the colour a shell
  // already had must therefore keep the object rather than build an equal one —
  // otherwise every keystroke invalidates a style and the identity is worthless.
  let state = applyTerminalOutput(initialTerminalState(), '\x1b[36mabc', TERMINAL_SCROLLBACK);
  const first = state.runs[0][0].attr;
  state = applyTerminalOutput(state, '\x1b[36mdef', TERMINAL_SCROLLBACK);
  assert.equal(state.runs[0][0].attr, first);
});

test('plain output records no runs at all', () => {
  // The common case, and the representation's rule: "no colours" is the absence of
  // a run rather than a run that says "no colours". A build log would otherwise be
  // one style object per line for the whole scrollback.
  const state = applyTerminalOutput(initialTerminalState(), 'ordinary output\r\nmore', TERMINAL_SCROLLBACK);
  assert.deepEqual(state.runs[0], []);
  assert.deepEqual(state.runs[1], []);
});

/* ---- attr → the CSS the pane paints ---- */

test('the default pen paints nothing, so the pane passes no style at all', () => {
  // `undefined` rather than `{}`: it is what makes React skip the style attribute
  // on the many rows that have no colour, and it is why the default pen is tested
  // as its own case rather than as "an attr with nulls in it".
  assert.equal(attrStyle(DEFAULT_ATTR), undefined);
});

test('bold, faint, italic, underline and strike all reach the style', () => {
  const attr: TerminalAttr = {
    ...DEFAULT_ATTR,
    bold: true,
    dim: true,
    italic: true,
    underline: true,
    strike: true,
  };
  const css = attrStyle(attr);
  assert.equal(css?.fontWeight, 600);
  assert.equal(css?.opacity, 0.65);
  assert.equal(css?.fontStyle, 'italic');
  assert.equal(css?.textDecoration, 'underline line-through');
});

test('inverse swaps the pair, including the default half', () => {
  // The half that matters: `ESC[7m` on text with **no** colours set is the one case
  // where the swapped value has to come from the pane rather than from the attr.
  // The pane's background is `--terminal-bg` in both themes, so that is what "the
  // default background" means on this surface.
  const inverted = attrStyle({ ...DEFAULT_ATTR, inverse: true });
  assert.equal(inverted?.color, 'var(--terminal-bg)');
  assert.equal(inverted?.backgroundColor, 'var(--terminal-fg)');
  const both = attrStyle({
    ...DEFAULT_ATTR,
    inverse: true,
    color: ansiColour(1),
    background: ansiColour(4),
  });
  assert.equal(both?.color, ansiColour(4));
  assert.equal(both?.backgroundColor, ansiColour(1));
});

test('an index past the palette is clamped rather than crashing the pane', () => {
  // `ESC[38;5;999m` is malformed, and a program that emits it must not take the
  // terminal down with it.
  assert.equal(ansiColour(999), ansiColour(255));
  assert.equal(ansiColour(-5), ansiColour(0));
});

/* ---- a row, cut into the pieces the pane draws ---- */

test('a row with no colour and no caret is one piece of text', () => {
  // This is what keeps the pane's ordinary rows as plain text children: one text
  // node per row, which is the shape `white-space: pre` and the row's
  // `content-visibility` were written for.
  const pieces = lineSegments('plain output', [], null);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].text, 'plain output');
  assert.equal(pieces[0].attr, null);
  assert.equal(pieces[0].caret, false);
});

test('a colour change splits the row at the column it changes', () => {
  const state = applyTerminalOutput(initialTerminalState(), '\x1b[31mab\x1b[32mcd', TERMINAL_SCROLLBACK);
  const pieces = lineSegments(state.lines[0], state.runs[0], null);
  assert.deepEqual(
    pieces.map((piece) => [piece.text, colourOf(piece.attr)]),
    [
      ['ab', ansiColour(1)],
      ['cd', ansiColour(2)],
    ],
  );
});

test('the caret is placed between two characters, whatever their colours', () => {
  // The case two independent passes would get wrong: the caret sits exactly where
  // the colour changes, so an implementation that split on colour and then inserted
  // the caret would have to choose which half it belongs to — and dropping a
  // character between them is the failure.
  const pieces = lineSegments('abcd', [{ start: 2, end: 4, attr: { ...DEFAULT_ATTR, bold: true } }], 2);
  assert.deepEqual(
    pieces.map((piece) => (piece.caret ? '|' : piece.text)),
    ['ab', '|', 'cd'],
  );
  // Nothing is lost: the pieces reassemble into the row.
  assert.equal(pieces.map((piece) => piece.text).join(''), 'abcd');
});

test('the caret past the end of the text is simply last', () => {
  // The ordinary "about to type" position, which the shell reports as a column past
  // the end of what it has drawn.
  const pieces = lineSegments('ab', [], 5);
  assert.deepEqual(
    pieces.map((piece) => (piece.caret ? '|' : piece.text)),
    ['ab', '|'],
  );
});

test('the caret on an empty row is the only thing on it', () => {
  const pieces = lineSegments('', [], 0);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].caret, true);
});

test('a run that outlives its text draws less, never text from another row', () => {
  // Defensive clipping: a stale run is possible (an erase path could leave one),
  // and the consequence has to be a piece that is too short rather than a slice of
  // a row the run does not belong to.
  const pieces = lineSegments('ab', [{ start: 1, end: 99, attr: { ...DEFAULT_ATTR, bold: true } }], null);
  assert.equal(pieces.map((piece) => piece.text).join(''), 'ab');
  assert.deepEqual(
    pieces.map((piece) => piece.text),
    ['a', 'b'],
  );
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

/* ============================================================
   The pane's size, and the half of it that used to be thrown away
   ============================================================ */

test('a size reported before any output is kept, not discarded', () => {
  // **The reported bug: "why does it start from the middle".** A pane is resized
  // on mount and on every layout change, and the *first* of those arrives before
  // the shell has printed anything. `resizeTerminalTail` used to `return store` in
  // that case, so the size was dropped — and the tail was then created by the
  // first output batch at the `DEFAULT_VIEWPORT_ROWS` fallback.
  //
  // That is invisible in a unit test and obvious in the app, because the shell was
  // told a different number: the runtime resizes the PTY, and the model here keeps
  // scrolling its 24-row screen while the shell is drawing a taller one.
  const store = resizeTerminalTail({}, 'term-01', 30);
  assert.deepEqual(Object.keys(store), ['term-01'], 'the size was not remembered at all');
  assert.equal(store['term-01'].viewportRows, 30);

  // And the tail that the first batch then extends is built on that size rather
  // than on the fallback.
  const withOutput = appendTerminalOutput(store, 'term-01', 'PS> ');
  assert.equal(withOutput['term-01'].viewportRows, 30);
  assert.notEqual(withOutput['term-01'].viewportRows, DEFAULT_VIEWPORT_ROWS);
});

test('a resize repaint against a correctly-sized screen does not scroll the prompt away', () => {
  // The whole failure, replayed from the **real** ConPTY bytes. This is what a
  // resize to 30 rows produced on Windows, with the prompt already on screen:
  //
  //     ESC[?25l ESC[8;30;107t ESC[H <prompt> ESC[K CRLF  (29 more ESC[K CRLF) ESC[1;68H ESC[?25h
  //
  // Home, the one content row, then an `ESC[K CRLF` for every remaining row of the
  // screen. A model that knows it has 30 rows lands back on row 0 and scrolls
  // nothing. A model still believing in the 24-row default scrolls six times on
  // the way down, which is six blank lines above the prompt — the screenshot.
  const prompt = 'PS C:\\ws>';
  const repaint = (rows: number) =>
    '\x1b[?25l\x1b[8;' + rows + ';107t\x1b[H' + prompt + '\x1b[K\r\n' +
    '\x1b[K\r\n'.repeat(rows - 2) +
    '\x1b[K\x1b[1;68H\x1b[?25h';

  // Right: the pane told the store its height before the batch arrived.
  let fixed = resizeTerminalTail({}, 't', 30);
  fixed = appendTerminalOutput(fixed, 't', repaint(30));
  assert.equal(fixed['t'].screenTop, 0, 'a 30-row screen does not scroll for a 30-row repaint');
  assert.deepEqual(fixed['t'].lines, [prompt], 'the prompt is the first thing drawn');

  // Wrong: the same bytes against the 24-row fallback. Asserted so the regression
  // is stated in the test rather than being inferred from the fix above.
  let wrong: Record<string, TerminalTail> = {};
  wrong = appendTerminalOutput(wrong, 't', repaint(30));
  assert.equal(wrong['t'].viewportRows, DEFAULT_VIEWPORT_ROWS);
  assert.ok(wrong['t'].screenTop > 0, 'the 24-row model scrolled on a 30-row repaint');
  assert.equal(wrong['t'].lines.filter((line) => line === '').length, 6, 'six blank lines above the prompt');
});

/* ============================================================
   The cursor
   ============================================================ */

test('the shell\'s show/hide cursor pair is obeyed', () => {
  // **The reported bug: "why is there no cursor".** `CSI ?25l` / `CSI ?25h` were
  // on the ignored list, and a real ConPTY wraps *every* redraw in them — one
  // keystroke is `ESC[m ESC[?25l` then `ESC[93m… ESC[?25h`, and the boot batch
  // brackets its repaint the same way. So there was nothing to draw a cursor from
  // at any moment, which is not "the cursor is in the wrong place".
  const shown = applyTerminalOutput(initialTerminalState(), 'a\x1b[?25h', TERMINAL_SCROLLBACK);
  assert.equal(shown.cursorVisible, true);
  const hidden = applyTerminalOutput(initialTerminalState(), 'a\x1b[?25l', TERMINAL_SCROLLBACK);
  assert.equal(hidden.cursorVisible, false);
  // And it toggles back, which is the case that actually appears on the wire.
  const again = applyTerminalOutput(hidden, '\x1b[?25h', TERMINAL_SCROLLBACK);
  assert.equal(again.cursorVisible, true);
});

test('a bare CSI 25h is not read as the cursor pair', () => {
  // The `?` is not decoration. `CSI 25h` is a **different mode number space**, and
  // `param` strips the marker before parsing — so the check has to look at the raw
  // params. Reading it as DECTCEM would be obeying somebody else's instruction.
  const bare = applyTerminalOutput(initialTerminalState(), 'a\x1b[25l', TERMINAL_SCROLLBACK);
  assert.equal(bare.cursorVisible, true);
});

test('the caret is drawn where the shell put the cursor, not at the end', () => {
  // The arithmetic `visibleLines` makes non-obvious: it slices from index 0 of
  // `rows`, so the caret's line index is `screenTop + row` and **not** `row`. After
  // a screen has scrolled, those two differ — and using `row` would put the caret
  // on the wrong line, which reads as a cursor that tracks nothing.
  let state = applyTerminalOutput(initialTerminalState(4), 'one\r\ntwo', TERMINAL_SCROLLBACK);
  // A newline at the bottom of a 4-row screen... is not yet a scroll, so make one
  // happen: two more rows than the screen holds.
  state = applyTerminalOutput(state, '\r\nthree\r\nfour', TERMINAL_SCROLLBACK);
  state = applyTerminalOutput(state, '\r\nfive', TERMINAL_SCROLLBACK);
  assert.ok(state.screenTop > 0, 'the screen has scrolled for this assertion to mean anything');

  const caret = caretPosition(state, state.lines);
  assert.notEqual(caret, null);
  assert.equal(caret!.line, state.screenTop + state.row, 'the caret is indexed in `lines`, not in screen rows');
  assert.equal(state.lines[caret!.line], 'five', 'and it is on the row the shell last wrote');
});

test('a hidden cursor draws no caret at all', () => {
  // `null` rather than a position, so the pane draws nothing instead of drawing a
  // caret the shell has asked not to be shown — which is what a full-screen
  // program's alternate screen would otherwise get.
  const state = applyTerminalOutput(initialTerminalState(), 'x\x1b[?25l', TERMINAL_SCROLLBACK);
  assert.equal(caretPosition(state, state.lines), null);
});

test('the caret sits after the prompt on a fresh terminal', () => {
  // The ordinary case a person sees, and the one the screenshot was missing: type
  // nothing, and the caret is at the end of the prompt rather than nowhere.
  const state = applyTerminalOutput(initialTerminalState(), 'PS C:\\ws> ', TERMINAL_SCROLLBACK);
  const caret = caretPosition(state, state.lines);
  assert.deepEqual(caret, { line: 0, col: 'PS C:\\ws> '.length });
  // A `col` past the end of the text is kept, not clamped: that is the ordinary
  // "about to type here" position, and clamping would move the caret backwards
  // onto a character the shell has already left.
  const far = applyTerminalOutput(initialTerminalState(), 'ab\x1b[10G', TERMINAL_SCROLLBACK);
  assert.equal(caretPosition(far, far.lines)!.col, 9);
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

/* ============================================================
   The palette token names, against the stylesheet that defines them.
   ============================================================ */

test('every palette token `ansiColour` emits is actually defined', () => {
  // The one failure in this whole change that is **invisible in every test above**
  // and plainly wrong on screen: `var(--term-ansi-3)` with no such custom property
  // resolves to nothing, so those runs fall back to the inherited foreground and
  // the text is drawn in the ordinary colour — "some of the colours don't work",
  // with the model, the pane and the CSS all looking correct in isolation.
  //
  // Read as text for the same reason `stream-layout.test.ts` reads `app.css`: there
  // is no runtime behaviour to observe in Node, and the thing being protected is
  // the *presence* of a declaration. The test does not check the values — those are
  // a design decision — only that the name a run paints with exists.
  const tokens = readFileSync(resolve(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8');
  const missing = [];
  for (let index = 0; index < 16; index += 1) {
    const value = ansiColour(index);
    const expected = `var(--term-ansi-${index})`;
    assert.equal(value, expected, `index ${index} must be painted through a token`);
    const name = expected.slice('var(--'.length, -1);
    if (!new RegExp(`^\\s*--${name}\\s*:`, 'm').test(tokens)) missing.push(name);
  }
  assert.deepEqual(missing, [], `tokens.css is missing: ${missing.join(', ')}`);
});
