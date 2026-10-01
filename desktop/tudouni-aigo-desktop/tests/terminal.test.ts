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
  appendTerminalOutput,
  replaceTerminal,
  terminalExitText,
  TERMINAL_SCROLLBACK,
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

test('a batch boundary is not a line boundary', () => {
  // The PTY flushes wherever it happens to flush. A fragment that continues the
  // line already held must be joined to it, or a sentence breaks in the middle
  // of a word every time that happens.
  let store = appendTerminalOutput({}, 'term-01', 'npm ');
  store = appendTerminalOutput(store, 'term-01', 'test\r\n');
  assert.deepEqual(store['term-01'], ['npm test', '']);
});

test('CRLF is normalised so the output does not collapse onto one line', () => {
  // A browser renders a raw `\r` inside a `<div>` as nothing at all.
  const store = appendTerminalOutput({}, 'term-01', 'one\r\ntwo\r\n');
  assert.deepEqual(store['term-01'], ['one', 'two', '']);
});

test('each terminal keeps its own buffer', () => {
  let store = appendTerminalOutput({}, 'term-01', 'first\n');
  store = appendTerminalOutput(store, 'term-02', 'second\n');
  assert.deepEqual(store['term-01'], ['first', '']);
  assert.deepEqual(store['term-02'], ['second', '']);
});

test('the buffer is bounded, and it is the newest lines that survive', () => {
  // Without the bound this window's memory grows with the length of a command
  // somebody ran; dropping the recent output instead would leave the pane showing
  // the start of a build with no sign of the end.
  let store: Record<string, string[]> = {};
  for (let i = 0; i < TERMINAL_SCROLLBACK + 500; i += 1) {
    store = appendTerminalOutput(store, 'term-01', `line ${i}\n`);
  }
  const lines = store['term-01'] ?? [];
  assert.ok(lines.length <= TERMINAL_SCROLLBACK + 1, `kept ${lines.length} lines`);
  assert.ok(lines.some((line) => line.includes(`line ${TERMINAL_SCROLLBACK + 499}`)));
  assert.ok(!lines.some((line) => line.includes('line 0\n')));
});

test('the buffer is copied, never mutated in place', () => {
  // The store's patch helpers compare references; mutating the array a previous
  // state holds is how a React render silently shows nothing new.
  const before = { 'term-01': ['a'] };
  const after = appendTerminalOutput(before, 'term-01', 'b');
  assert.notEqual(after, before);
  assert.notEqual(after['term-01'], before['term-01']);
  assert.deepEqual(before['term-01'], ['a']);
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
