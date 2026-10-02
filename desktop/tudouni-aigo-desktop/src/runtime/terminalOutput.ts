/**
 * PTY bytes → text a `<div>` can draw.
 *
 * This module exists because of one honest limitation, and it is worth stating
 * plainly before the code: **this window is not a terminal emulator.** A real one
 * keeps a screen grid and a cursor, and interprets escape sequences into cell
 * writes — `\x1b[2J` clears the screen, `\x1b[1;70H` moves the cursor, `\x1b[93m`
 * changes the ink. Emulating that is a project rather than a panel, and the
 * design puts that work on the *client's* side of the boundary precisely so the
 * runtime can stay one thing.
 *
 * What is here is the other half of that decision, and it is not optional: the
 * bytes that are **not** interpreted must not be **drawn** either. A shell writes
 * `\x1b[?25l` (hide the cursor) on essentially every prompt; painting that
 * literally puts `▯[?25l` on screen. Measured against a real ConPTY, one prompt
 * carries a dozen of them:
 *
 *     \x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HPS C:\ws>\x1b[1C
 *     \x1b]0;C:\...\powershell.exe\a\x1b[?25h\x1b[93mecho \x1b[37mhi\r\n
 *
 * Stripped, that is `PS C:\ws>echo hi` — which is the thing the person was
 * trying to read. So the rule this file implements is:
 *
 *   - **Escape sequences are removed**, never shown. That covers CSI (`ESC [ …`),
 *     the string sequences OSC/DCS/SOS/PM/APC (`ESC ] …` and friends, terminated
 *     by BEL or ST), and the single-character escapes (`ESC ( B` and the rest).
 *   - **Control characters are removed**, except `\n`, `\t` and `\r` — the three
 *     that mean something once the output is text. This is where the `NUL`s a
 *     Windows console scatters through its output go.
 *   - **A carriage return is a rewrite**, not a character. A progress bar redraws
 *     itself with `\r`, and the last rewrite is what a terminal would be showing;
 *     drawing all of them would print `10%50%100% done` on one line.
 *
 * What it deliberately does **not** do is emulate cursor movement. `\x1b[1;70H`
 * followed by more text arrives as that text appended to the line, so a
 * full-screen program's redraw shows up as its successive frames one after
 * another rather than as one repainted screen. That is the honest half: this pane
 * shows *what the shell printed*, in order, with nothing invented and nothing
 * drawn that was meant as an instruction.
 *
 * ## The batch boundary
 *
 * A PTY flushes wherever it happens to flush, so a sequence **can be split across
 * two batches** — `\x1b[` in one and `0m` in the next. A stateless stripper would
 * turn that into a stray `0m` in the middle of somebody's output, and it would
 * happen often enough to look like a memory bug.
 *
 * So the sanitizer is a **stream** transform with one piece of state: an
 * incomplete trailing sequence is held back and prepended to the next batch. This
 * is the same shape the runtime already uses for a rune split across a read
 * (`terminal.splitRunes`), for the same reason — the boundary is an artifact of
 * how the bytes were delivered, and it must not be visible.
 */

/** The escape byte, spelled once. */
const ESC = 0x1b;

/**
 * The longest incomplete sequence that will be held back for the next batch.
 *
 * Every real escape sequence is short — a dozen bytes, and an OSC window title is
 * the long one. Past this the bytes are emitted as text rather than carried
 * forever: a front end that buffered an unbounded "incomplete" sequence would
 * grow its state on malformed output, and showing the raw bytes is a far better
 * failure than showing nothing.
 */
const MAX_CARRY = 512;

/** One batch's worth of sanitized text, plus whatever is still incomplete. */
export interface SanitizedChunk {
  text: string;
  /** An escape sequence cut off by the batch boundary. `''` when none was. */
  carry: string;
}

/**
 * `true` for a character that has no meaning once the bytes are text.
 *
 * `\n`, `\t` and `\r` are the exceptions and each earns it: a newline separates
 * rows, a tab aligns columns, and a carriage return is the rewrite above. DEL and
 * the C1 range go, and C1 matters rather than being pedantry — `ansi.Strip` on
 * the runtime's side drops it, so keeping it here would make the two front ends
 * disagree about what a shell's output says.
 */
function isDroppedControl(code: number): boolean {
  if (code === 0x0a || code === 0x09 || code === 0x0d) return false;
  if (code < 0x20) return true;
  if (code === 0x7f) return true;
  return code >= 0x80 && code <= 0x9f;
}

/**
 * The index just past the escape sequence beginning at `start`, or `null` when it
 * is not complete yet.
 *
 * `null` is the batch-boundary case and the only reason this returns an optional:
 * the caller holds the remainder back rather than guessing at the rest.
 *
 * Every branch is guaranteed to make progress — the returned index is always
 * greater than `start` — so a malformed sequence cannot make the scanner spin.
 */
function escapedEnd(raw: string, start: number): number | null {
  let i = start + 1;
  if (i >= raw.length) return null;
  const kind = raw[i];

  if (kind === '[') {
    // CSI: parameter bytes, then intermediate bytes, then one final byte.
    i += 1;
    while (i < raw.length) {
      const code = raw.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
      if (code >= 0x20 && code <= 0x3f) {
        i += 1;
        continue;
      }
      // Something that cannot appear inside a CSI. The sequence is malformed, and
      // consuming up to here still moves past the `ESC [`.
      return i;
    }
    return null;
  }

  if (kind === ']' || kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
    // A string sequence — an OSC window title is the common one. It runs until BEL
    // or ST (`ESC \`), and it may legitimately contain anything in between,
    // including newlines.
    i += 1;
    while (i < raw.length) {
      const code = raw.charCodeAt(i);
      if (code === 0x07) return i + 1;
      if (code === ESC) {
        if (i + 1 >= raw.length) return null;
        if (raw[i + 1] === '\\') return i + 2;
        // An ESC that is not half of ST: malformed, and stopping here beats
        // swallowing the rest of the line.
        return i;
      }
      i += 1;
    }
    return null;
  }

  // Everything else: optional intermediates, then one final byte. `ESC ( B` and
  // `ESC =` are the shapes this covers.
  i += 1;
  while (i < raw.length && raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x2f) i += 1;
  if (i >= raw.length) return null;
  const code = raw.charCodeAt(i);
  if (code >= 0x30 && code <= 0x7e) return i + 1;
  return i;
}

/**
 * Strip one batch, carrying an incomplete trailing sequence into the next.
 *
 * `carry` is whatever the previous call handed back, and it is prepended before
 * anything is scanned — which is what makes a sequence split across two batches
 * indistinguishable from one that arrived whole.
 */
export function sanitizeTerminalChunk(carry: string, data: string): SanitizedChunk {
  const raw = carry + data;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === ESC) {
      const end = escapedEnd(raw, i);
      if (end === null) {
        const held = raw.slice(i);
        // A sequence that spans a newline is not one we are going to complete, and
        // one longer than the cap is not worth waiting for. Either way the raw
        // bytes go out as text: showing them is recoverable, holding them is not.
        if (held.length > MAX_CARRY || held.includes('\n')) {
          return { text: out + held, carry: '' };
        }
        return { text: out, carry: held };
      }
      i = end;
      continue;
    }
    if (isDroppedControl(code)) {
      i += 1;
      continue;
    }
    // Appended a code unit at a time on purpose: a surrogate pair is two units and
    // concatenating them reproduces the character exactly, whereas slicing by rune
    // would be more code for no difference in the result.
    out += raw[i];
    i += 1;
  }
  return { text: out, carry: '' };
}

/**
 * Apply one batch to a terminal's accumulated lines.
 *
 * The last element of `lines` is **the line being written**: it is what a
 * carriage return rewrites and what the next batch continues. That single rule is
 * what makes the two failure modes go away together — a `\r` progress bar
 * replaces its line instead of appending to it, and a fragment that continues a
 * line does not become a row of its own.
 *
 * It returns a new array and never mutates the one it was given: the store's
 * selectors compare by identity, so mutating the array a previous state holds is
 * how a React render silently shows nothing new.
 */
export function applyTerminalChunk(
  lines: string[],
  text: string,
  limit: number,
): string[] {
  const next = lines.length > 0 ? [...lines] : [''];
  // `\r\n` is a line ending and a lone `\r` is a rewrite; normalising first is what
  // tells the two apart without a second pass.
  const normalised = text.replace(/\r\n/g, '\n');
  for (const character of normalised) {
    if (character === '\n') {
      next.push('');
      continue;
    }
    if (character === '\r') {
      next[next.length - 1] = '';
      continue;
    }
    next[next.length - 1] += character;
  }
  if (next.length > limit) {
    // The **newest** lines survive: dropping the recent output would leave the pane
    // showing the start of a build with no sign of the end.
    return next.slice(next.length - limit);
  }
  return next;
}
