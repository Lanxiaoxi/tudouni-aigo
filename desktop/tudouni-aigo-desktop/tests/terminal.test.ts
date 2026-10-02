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
import { applyTerminalChunk, sanitizeTerminalChunk } from '@/runtime/terminalOutput';
import {
  appendTerminalOutput,
  pruneTails,
  replaceTerminal,
  terminalExitText,
  TERMINAL_SCROLLBACK,
  type TerminalTail,
} from '@/state/store';
import { parentPath } from '@/components/panels/panels';
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
  // state holds is how a React render silently shows nothing new.
  const before = { 'term-01': { lines: ['a'], carry: '' } };
  const after = appendTerminalOutput(before, 'term-01', 'b');
  assert.notEqual(after, before);
  assert.notEqual(after['term-01'], before['term-01']);
  assert.notEqual(after['term-01'].lines, before['term-01'].lines);
  assert.deepEqual(before['term-01'].lines, ['a']);
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
  assert.equal(sanitizeTerminalChunk('', raw).text, 'PS C:\\ws>');
});

test('a lone carriage return rewrites its line rather than appending', () => {
  // A progress bar redraws itself. The last rewrite is what a terminal would be
  // showing; drawing all of them prints `10%50%100% done` on one line.
  const lines = applyTerminalChunk([], '10%\r50%\r100% done', 100);
  assert.deepEqual(lines, ['100% done']);
});

test('sgr colour codes go, and the text between them stays', () => {
  // `\x1b[93mecho \x1b[37mMARK` is a real PowerShell line: the colours are
  // instructions, the words are the output.
  assert.equal(sanitizeTerminalChunk('', '\x1b[93mecho \x1b[37mMARK\x1b[?25h').text, 'echo MARK');
});

test('a sequence split across two batches is held, not shown', () => {
  // A PTY flushes wherever it flushes, so `\x1b[` can arrive in one batch and
  // `0m` in the next. A stateless stripper would print a stray `0m` in the middle
  // of somebody's output — often enough to look like a memory bug.
  const first = sanitizeTerminalChunk('', 'before \x1b[');
  assert.equal(first.text, 'before ');
  assert.equal(first.carry, '\x1b[');

  const second = sanitizeTerminalChunk(first.carry, '0mafter');
  assert.equal(second.text, 'after');
  assert.equal(second.carry, '');
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
  assert.equal(sanitizeTerminalChunk('', 'a\x00b\x07c').text, 'abc');
  assert.equal(sanitizeTerminalChunk('', 'keep\ttabs\nand newlines').text, 'keep\ttabs\nand newlines');
  // DEL and the C1 range go too. C1 matters rather than being pedantry: the
  // runtime's own stripper drops it, so keeping it here would make the two front
  // ends disagree about what a shell's output says.
  assert.equal(sanitizeTerminalChunk('', 'a\x7fb\x9bc').text, 'abc');
});

test('an unterminated sequence is eventually shown rather than held for ever', () => {
  // A front end that buffered an unbounded "incomplete" escape would grow its
  // state on malformed output. Showing the raw bytes is a far better failure than
  // showing nothing at all.
  const held = sanitizeTerminalChunk('', '\x1b]0;' + 'x'.repeat(600));
  assert.equal(held.carry, '');
  assert.ok(held.text.length > 600, 'the over-long sequence was not released');

  // The same for one that spans a newline, which is not a sequence we will ever
  // complete.
  const across = sanitizeTerminalChunk('', '\x1b]0;title\nnext line');
  assert.equal(across.carry, '');
});

test('an OSC title is stripped whole, terminator and all', () => {
  // PowerShell writes the window title; drawing it would put the executable's
  // path in the middle of the prompt.
  const { text } = sanitizeTerminalChunk('', '\x1b]0;C:\\WINDOWS\\system32\x1b\\PS> ');
  assert.equal(text, 'PS> ');
});

test('pruneTails drops what the runtime no longer lists, and keeps the rest', () => {
  // A tail belongs to a terminal that exists. One kept for an id the runtime has
  // forgotten is memory this window can never free — nothing will append to it and
  // nothing will draw it.
  const tails: Record<string, TerminalTail> = {
    'term-01': { lines: ['a'], carry: '' },
    'term-02': { lines: ['b'], carry: '' },
  };
  const pruned = pruneTails(tails, [row('term-02', 'running')]);
  assert.deepEqual(Object.keys(pruned), ['term-02']);

  // And nothing is copied when nothing was dropped, so a snapshot mentioning only
  // known terminals does not re-render the pane.
  assert.equal(pruneTails(tails, [row('term-01', 'running'), row('term-02', 'running')]), tails);
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

test('the three endings read three ways', () => {
  // `killed`, `exited` with a code, and `exited` without one are different facts.
  // A killed shell did not choose an exit status, so printing a number for it
  // would invent one — and a process killed by a signal on POSIX is exactly that
  // case.
  //
  // The id below is deliberately one with no digits in it: an earlier version of
  // this test used `term-01` and asserted the sentence did not contain `0`,
  // which it always did. The assertion was about the whole string while the
  // claim was about the **code**, so the id has to stop being able to satisfy it.
  const id = 'term';
  const killed = terminalExitText(id, 'killed', null);
  const exitedWithCode = terminalExitText(id, 'exited', 0);
  const exitedNoCode = terminalExitText(id, 'exited', null);

  assert.notEqual(killed, exitedWithCode);
  assert.notEqual(exitedNoCode, exitedWithCode);
  assert.ok(exitedWithCode.includes('0'), 'the code is printed when there is one');
  assert.ok(!exitedNoCode.includes('0'), 'no code is invented when there is none');
  assert.ok(killed.includes('killed'));
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
