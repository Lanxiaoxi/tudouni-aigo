/**
 * Keystroke → the bytes a terminal sends for it.
 *
 * This is the **one** piece of terminal behaviour this front end owns, and it
 * owns it because nobody else can: the runtime takes raw bytes and deliberately
 * does not parse them (see the design's §12 — `Ctrl+C`, `Ctrl+D`, `Tab`, arrows
 * and Escape "都应该能够作为终端输入正确传递"). So the translation from a
 * keyboard event to those bytes has to happen here, in the window that received
 * the key.
 *
 * It is a **pure function** taking a plain descriptor rather than a
 * `KeyboardEvent`, and that is not tidiness: it is what makes the table below
 * assertable without a DOM, and the table is exactly where a wrong byte hides —
 * a wrong escape sequence looks like a shell that ignored a key.
 *
 * The encoder covers the whole keyboard on purpose. A key it does not know sends
 * **nothing**, which is recoverable; a guessed byte is a command that ran with a
 * character nobody typed.
 */

/** The parts of a key event this needs. A `KeyboardEvent` satisfies it. */
export interface KeyDescriptor {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Named keys and the bytes a terminal sends for them.
 *
 * The arrows and the function keys are ANSI CSI/SS3 sequences, and which of the
 * two forms is used matters: F1–F4 are SS3 (`ESC O P`) and F5–F12 are CSI
 * (`ESC [ 15 ~`), which is a historical artefact of real terminals and not a
 * choice this program gets to make. A shell's readline matches on the exact
 * bytes, so "close enough" is a key that does nothing.
 */
const NAMED: Record<string, string> = {
  Enter: '\r',
  // DEL, not BS. A terminal's Backspace sends DEL and a shell's line editor
  // reads it as "delete the character before the cursor"; BS (0x08) is
  // `Ctrl+H`, whose meaning differs between editors.
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ' ': ' ',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
  Insert: '\x1b[2~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

/**
 * Control keys, by their C0 byte.
 *
 * `Ctrl+A` is 0x01 because that is SOH, `Ctrl+C` is 0x03 because that is ETX —
 * the numbers are the definition rather than a mapping somebody chose, which is
 * why this is arithmetic over the letter rather than a thirty-entry table. A
 * table would also be a list that drifts: `Ctrl+\` is 0x1C and is exactly the
 * kind of entry a hand-written table loses.
 */
function controlByte(k: KeyDescriptor): string | null {
  if (k.key.length !== 1) return null;

  // `Ctrl+letter` and `Ctrl+[ \ ] ^ _` are the ASCII control range.
  if (k.ctrlKey && !k.altKey) {
    const code = k.key.toUpperCase().charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
    const punctuation: Record<string, number> = { '@': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31 };
    if (k.key in punctuation) return String.fromCharCode(punctuation[k.key]);
    // `Ctrl+?` (and `Ctrl+/` on most layouts) is DEL.
    if (k.key === '?' || k.key === '/') return '\x7f';
    return null;
  }
  return null;
}

/**
 * Encode one keystroke, or `''` when it has no terminal meaning.
 *
 * Two things are deliberately **not** handled here and both matter:
 *
 *   - **`Ctrl+C` is not special.** It encodes to 0x03 like any other control key
 *     and goes to the shell, where it means "interrupt the running command".
 *     Treating it as "close this window" is the single most common way a
 *     terminal front end makes a shell unusable.
 *   - **`Shift` is not encoded.** A shifted letter already arrives as its
 *     uppercase character, and a shifted arrow's sequence is a *different*
 *     sequence that most shells have no binding for — sending `\x1b[1;2A` for
 *     `Shift+Up` would be guessing at a meaning instead of sending none.
 */
export function encodeKey(k: KeyDescriptor): string {
  // Alt is the ESC prefix. On a real terminal that is not a convention of this
  // program: the terminal sends ESC then the key, and every readline-style
  // editor reads it as "meta".
  const prefix = k.altKey ? '\x1b' : '';

  if (k.key.length === 1) {
    const control = controlByte(k);
    if (control !== null) return control;
    // A printable character goes out as itself, UTF-8, which is what the
    // protocol carries.
    if (!k.ctrlKey && !k.metaKey) return prefix + k.key;
    return '';
  }

  const named = NAMED[k.key];
  if (named === undefined) return '';
  // Tab's shift form is a real sequence (`ESC [ Z`), and it is the one named key
  // whose shifted meaning a shell does bind.
  if (k.key === 'Tab' && k.shiftKey) return '\x1b[Z';
  // Any other modifier on a named key sends **nothing**, and this is the branch
  // the comment above promises. `Shift+ArrowUp` in a real terminal is
  // `ESC [ 1 ; 2 A`, not `ESC [ A`: sending the plain sequence would move the
  // caret instead of selecting text, which is a key that did something other
  // than what was pressed. Building the `CSI 1;<modifier>` form for all of them
  // would be guessing at bindings that differ between shells, so the honest
  // answer is silence.
  if (k.shiftKey || k.altKey || k.ctrlKey || k.metaKey) return '';
  return named;
}

/**
 * Whether this keystroke belongs to the shell rather than to the window.
 *
 * The window's own handlers ask this before acting, and it is one function
 * rather than a rule repeated at each of them: while a terminal is attached,
 * every key that has a terminal meaning goes to the shell — including Escape,
 * which the panels elsewhere use to close.
 */
export function isTerminalKey(k: KeyDescriptor): boolean {
  return encodeKey(k) !== '';
}
