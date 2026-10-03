/**
 * PTY bytes → text a `<div>` can draw.
 *
 * ## Why this is not "strip the escapes and append"
 *
 * The bytes a PTY delivers are **screen updates**, not a text stream: the shell
 * says where the cursor is and then rewrites what is there. Two measured shapes
 * from a real ConPTY/powershell on Windows make that concrete, and both are the
 * commonest things a person does in a terminal:
 *
 *   1. **Every keystroke redraws the line being typed.** PSReadLine emits the
 *      changed part and moves the cursor back over the unchanged part — with a
 *      backspace for a one-character move, and with an absolute `CSI r;cH` when
 *      the move is longer:
 *
 *          a   ->  ESC[93m  a             ESC[?25h
 *          b   ->  ESC[93m  \b ab         ESC[?25h
 *          c   ->  ESC[93m  ESC[1;60H abc ESC[?25h
 *
 *      Append-only rendering turns that into `a` + `aab` + `aababc`: the text a
 *      person sees stops being the text they typed, and it gets worse with every
 *      key. Measured on a 27-character command, the drawn line was 385 chars.
 *
 *   2. **A resize makes the shell resend the whole screen.** ConPTY answers
 *      `terminal_resize` with a full repaint — home the cursor, then every row,
 *      then `ESC[K` for each row below the content, then put the cursor back:
 *
 *          ESC[?25l ESC[8;16;70t ESC[H PS C:\ws> "R1"; "R2" ESC[K CRLF
 *                 R1 ESC[K CRLF  R2 ESC[K CRLF  PS C:\ws> ESC[K CRLF ... ESC[K
 *                 ESC[4;60H ESC[?25h
 *
 *      Append-only rendering turns one screenful of output into two copies plus
 *      `rows` blank lines. Measured in the app: folding a rail took the pane from
 *      61 lines to 90, of which 84 were blank. The pane is resized on mount and on
 *      every layout change, so this fires without anybody asking for it.
 *
 * So this module keeps **the two pieces of state that make those bytes mean what
 * they say**: the rows of a screen, and a cursor on it. `\b`, the CSI movement
 * sequences and the erase sequences are then *instructions*, applied rather than
 * drawn — the same rule the old version already applied to `\r` and to colour
 * codes, extended to the sequences it was missing.
 *
 * ## How the screen is represented, and why
 *
 * One list, `rows`, holding the scrollback **and** the visible screen, with
 * `screenTop` saying where the visible part begins. Nothing is ever discarded from
 * the front by a scroll — `screenTop` moves instead — so a row's index stays valid
 * for the life of the terminal, and "the screen" is just a window onto the list.
 *
 * The alternative (a fixed-size screen array that shifts on every scroll) was
 * rejected because of `CSI r;cH`: the cursor is addressed in **screen** coordinates,
 * so any scheme where a scroll also renumbers the rows has to get the renumbering
 * and the cursor clamping right at the same moment. Here a scroll moves one integer.
 *
 * `row` and `col` are therefore screen coordinates, which is exactly what the shell
 * itself is addressing — the model does not translate between two coordinate
 * systems, it holds the one the wire uses.
 *
 * ## What it still is not
 *
 * It is not a terminal emulator, and the difference is worth stating because it is
 * where the remaining honest limitations live. There is no per-cell grid, no
 * scrolling region (`CSI r`), no alternate screen (`CSI ?1049h`), and no
 * wide-character accounting: a cursor column is a **string index**, so a row
 * holding CJK or emoji counts each code unit as one column while the shell counts
 * cells. A full-screen program (`vim`, `top`) still shows its successive frames
 * rather than one repainted screen, because nothing here implements the cell
 * addressing those use.
 *
 * What is fixed is the case a workspace terminal is actually wanted for: typing a
 * command and reading what it said — including the prompt redraws, the repaints and
 * the erasures that go with it.
 *
 * ## The batch boundary
 *
 * A PTY flushes wherever it happens to flush, so a sequence **can be split across
 * two batches** — `ESC[` in one and `0m` in the next. A stateless scanner would
 * turn that into a stray `0m` in the middle of somebody's output, and it would
 * happen often enough to look like a memory bug. An incomplete trailing sequence
 * is therefore held back in `carry` and prepended to the next batch — the same
 * shape the runtime uses for a rune split across a read.
 */

/** The escape byte, spelled once. */
const ESC = 0x1b;

/**
 * The longest incomplete sequence that will be held back for the next batch.
 *
 * Every real escape sequence is short — a dozen bytes, and an OSC window title is
 * the long one. Past this the bytes are emitted as text rather than carried
 * forever: a front end that buffered an unbounded "incomplete" sequence would grow
 * its state on malformed output, and showing the raw bytes is a far better failure
 * than showing nothing.
 */
const MAX_CARRY = 512;

/**
 * How tall the screen is assumed to be before the pane says otherwise.
 *
 * It only decides **when the screen scrolls**, so a guess that is too small moves a
 * row out of view a little early and a guess that is too large a little late — the
 * text, its order and the cursor's relationship to it are all unaffected. The pane
 * sends the real size as soon as it has measured itself.
 */
export const DEFAULT_VIEWPORT_ROWS = 24;

/**
 * One terminal's output: the rows, and the cursor on the screen they show.
 *
 * `viewportRows`, `row` and `col` are the shell's own numbers — the pane measures
 * itself and sends them, and the runtime owns them. They are kept here because the
 * bytes are meaningless without them: the same `CSI 1;60H` means a different row
 * on a 24-row screen than on a 10-row one, and `\n` at the bottom of one scrolls
 * while at the bottom of the other it does not.
 */
export interface TerminalState {
  /**
   * What the pane draws. Derived from `rows` and the cursor by `visibleLines`, and
   * kept as a field rather than computed at read time because the pane reads it
   * through the store, whose selectors compare by identity.
   */
  lines: string[];
  /** Every row this front end still holds: the scrollback, then the screen. */
  rows: string[];
  /** The index in `rows` of the screen's first row. */
  screenTop: number;
  /** How many of `rows` — from `screenTop` on — are the screen. */
  viewportRows: number;
  /** The cursor's row **on the screen**, 0-based. */
  row: number;
  /** The cursor's column, 0-based, counted in string indices. */
  col: number;
  /** An escape sequence the batch boundary cut in half. `''` when there is none. */
  carry: string;
  /**
   * How many rows have fallen off the front of the bound.
   *
   * It exists so the pane can **say** that what is on screen is not the whole of
   * what the shell printed. The bound discards the oldest output silently
   * otherwise, and a log that has been cut with no sign of it is a log somebody
   * reads as complete — the exact failure `panel.term.dropped` was written for.
   */
  dropped: number;
}

/**
 * The shared empty tail, so a selector's fallback is a stable reference.
 *
 * A **one-row screen**: `screenTop` and `viewportRows` have to describe rows that
 * exist, or the cursor addresses a row that does not. One row satisfies that at
 * the smallest size, and the first batch fits it to the pane's real height.
 *
 * Frozen because it is shared: the store hands it out as a fallback, and a caller
 * that mutated it would corrupt every terminal that has not printed yet.
 */
export const EMPTY_TERMINAL_STATE: TerminalState = Object.freeze({
  lines: Object.freeze(['']) as unknown as string[],
  rows: Object.freeze(['']) as unknown as string[],
  screenTop: 0,
  viewportRows: 1,
  row: 0,
  col: 0,
  carry: '',
  dropped: 0,
}) as TerminalState;

/* ============================================================
   Scanning: bytes -> tokens
   ============================================================ */

/**
 * One thing the shell asked for. `text` is written; the rest are applied to the
 * cursor or to the screen.
 *
 * `escape.final` is the CSI final byte (or `''` for a non-CSI escape, which is
 * always ignored) and `escape.params` the parameter bytes between `CSI` and it.
 * Keeping the sequence's identity rather than pre-deciding its effect is what lets
 * the scanner stay a scanner and the model stay the only thing that knows where the
 * cursor is.
 */
type Token =
  | { kind: 'text'; value: string }
  | { kind: 'newline' }
  | { kind: 'carriage' }
  | { kind: 'backspace' }
  | { kind: 'tab' }
  | { kind: 'escape'; final: string; params: string };

/**
 * `true` for a character that has no meaning once the bytes are text.
 *
 * `\n`, `\t`, `\r` and `\b` are the exceptions and each earns it: a newline
 * separates rows, a tab aligns columns, a carriage return rewrites the row the
 * cursor is on, and a backspace moves the cursor back within it — which is what the
 * prompt redraw above is made of. DEL and the C1 range go, and C1 matters rather
 * than being pedantry: `ansi.Strip` on the runtime's side drops it, so keeping it
 * here would make the two front ends disagree about what a shell's output says.
 */
function isDroppedControl(code: number): boolean {
  if (code === 0x0a || code === 0x09 || code === 0x0d || code === 0x08) return false;
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

/** The CSI final byte and parameter bytes of one complete escape sequence. */
function parseEscape(sequence: string): Token {
  if (sequence[1] !== '[') return { kind: 'escape', final: '', params: '' };
  let at = 2;
  let params = '';
  while (at < sequence.length) {
    const code = sequence.charCodeAt(at);
    if (code < 0x30 || code > 0x3f) break;
    params += sequence[at];
    at += 1;
  }
  // Intermediates (`CSI ! p` and friends) are the one part no caller needs.
  while (at < sequence.length && sequence.charCodeAt(at) >= 0x20 && sequence.charCodeAt(at) <= 0x2f) {
    at += 1;
  }
  return { kind: 'escape', final: at < sequence.length ? sequence[at] : '', params };
}

/**
 * Split one batch into tokens, carrying an incomplete trailing sequence into the
 * next call.
 *
 * `carry` is whatever the previous call handed back, and it is prepended before
 * anything is scanned — which is what makes a sequence split across two batches
 * indistinguishable from one that arrived whole.
 */
export function tokenizeTerminalChunk(
  carry: string,
  data: string,
): { tokens: Token[]; carry: string } {
  const raw = carry + data;
  const tokens: Token[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') {
      tokens.push({ kind: 'text', value: text });
      text = '';
    }
  };
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === ESC) {
      const end = escapedEnd(raw, i);
      if (end === null) {
        const held = raw.slice(i);
        // A sequence that spans a newline is not one we are going to complete, and
        // one longer than the cap is not worth waiting for. Either way the raw bytes
        // go out as text: showing them is recoverable, holding them is not.
        flush();
        if (held.length > MAX_CARRY || held.includes('\n')) {
          tokens.push({ kind: 'text', value: held });
          return { tokens, carry: '' };
        }
        return { tokens, carry: held };
      }
      flush();
      tokens.push(parseEscape(raw.slice(i, end)));
      i = end;
      continue;
    }
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x08) {
      flush();
      tokens.push(
        code === 0x0a
          ? { kind: 'newline' }
          : code === 0x0d
            ? { kind: 'carriage' }
            : code === 0x09
              ? { kind: 'tab' }
              : { kind: 'backspace' },
      );
      i += 1;
      continue;
    }
    if (isDroppedControl(code)) {
      i += 1;
      continue;
    }
    // Appended a code unit at a time on purpose: a surrogate pair is two units and
    // concatenating them reproduces the character exactly, whereas slicing by rune
    // would be more code for no difference in the result.
    text += raw[i];
    i += 1;
  }
  flush();
  return { tokens, carry: '' };
}

/* ============================================================
   The screen and its cursor
   ============================================================ */

/** Parameter `index` of a CSI, or `fallback` when it was omitted or unparseable. */
function param(params: string, index: number, fallback: number): number {
  // Private-mode markers (`?25l`, `>4;2m`) are not parameters; those sequences are
  // ignored below anyway, and reading past the marker keeps the arithmetic total.
  const body = /^[?<=>]/.test(params) ? params.slice(1) : params;
  const raw = body.split(';')[index];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** The index in `rows` of a screen row. */
function bufferIndex(state: TerminalState, screenRow: number): number {
  return state.screenTop + screenRow;
}

/**
 * Overwrite the cursor's row from the cursor's column onwards.
 *
 * The two details that make this a screen write rather than an append:
 *
 *   - the row is **padded** when the cursor was moved past its end, so a shell that
 *     homes to column 60 writes there and stays aligned with what is on screen;
 *   - the write **replaces** the same columns rather than inserting, so a redraw of
 *     the line being typed lands on the characters it is redrawing.
 */
function writeAtCursor(state: TerminalState, value: string): void {
  const at = bufferIndex(state, state.row);
  const current = state.rows[at] ?? '';
  const padded =
    current.length < state.col ? current + ' '.repeat(state.col - current.length) : current;
  state.rows[at] = padded.slice(0, state.col) + value + padded.slice(state.col + value.length);
  state.col += value.length;
}

/**
 * One row down, scrolling the screen when the cursor is already at its bottom.
 *
 * A scroll moves `screenTop` and appends a blank row; the cursor stays on the last
 * screen row, which is now that new row. Nothing is rewritten and no index is
 * renumbered, which is what keeps an absolute `CSI r;cH` sent after a scroll
 * landing where the shell meant.
 */
function advanceRow(state: TerminalState): void {
  if (state.row + 1 < state.viewportRows) {
    state.row += 1;
    const at = bufferIndex(state, state.row);
    if (state.rows[at] === undefined) state.rows[at] = '';
    return;
  }
  state.rows.push('');
  state.screenTop += 1;
  state.col = 0;
}

/** Erase part of one row. `0` cursor→end, `1` start→cursor, `2` the whole row. */
function eraseLine(state: TerminalState, mode: number): void {
  const at = bufferIndex(state, state.row);
  const current = state.rows[at] ?? '';
  if (mode === 1) {
    state.rows[at] = ' '.repeat(Math.min(state.col, current.length)) + current.slice(state.col);
    return;
  }
  if (mode === 2) {
    state.rows[at] = '';
    return;
  }
  state.rows[at] = current.slice(0, state.col);
}

/** Erase part of the screen. `0` cursor→end, `1` start→cursor, `2` everything. */
function eraseDisplay(state: TerminalState, mode: number): void {
  if (mode === 2) {
    for (let r = 0; r < state.viewportRows; r += 1) state.rows[bufferIndex(state, r)] = '';
    return;
  }
  if (mode === 0) {
    eraseLine(state, 0);
    for (let r = state.row + 1; r < state.viewportRows; r += 1) {
      state.rows[bufferIndex(state, r)] = '';
    }
    return;
  }
  for (let r = 0; r < state.row; r += 1) state.rows[bufferIndex(state, r)] = '';
  eraseLine(state, 1);
}

/**
 * Apply one already-scanned token.
 *
 * Unknown finals are **ignored rather than drawn**: every sequence the scanner
 * recognised is an instruction by definition, and the ones this model does not
 * implement (scrolling regions, alternate screen, window manipulation) are still not
 * text. That is the rule the whole module rests on.
 */
function applyToken(state: TerminalState, token: Token): void {
  switch (token.kind) {
    case 'text':
      writeAtCursor(state, token.value);
      return;
    case 'carriage':
      // The rewrite rule: the cursor returns to the start of the row, and what is
      // written next replaces it. This is what a progress bar needs, and it is also
      // the CR half of CRLF — the LF that follows is what advances the row.
      state.col = 0;
      return;
    case 'backspace':
      state.col = Math.max(0, state.col - 1);
      return;
    case 'tab':
      state.col = (Math.floor(state.col / 8) + 1) * 8;
      return;
    case 'newline':
      advanceRow(state);
      return;
    case 'escape':
      break;
  }

  // A non-CSI escape (an OSC title, a character-set switch) has no cursor effect
  // and is dropped here, which is where the old implementation dropped it too.
  if (token.final === '') return;

  switch (token.final) {
    case 'A':
      state.row = Math.max(0, state.row - param(token.params, 0, 1));
      return;
    case 'B':
      state.row = Math.min(state.viewportRows - 1, state.row + param(token.params, 0, 1));
      return;
    case 'C':
      state.col += param(token.params, 0, 1);
      return;
    case 'D':
      state.col = Math.max(0, state.col - param(token.params, 0, 1));
      return;
    case 'E':
      state.row = Math.min(state.viewportRows - 1, state.row + param(token.params, 0, 1));
      state.col = 0;
      return;
    case 'F':
      state.row = Math.max(0, state.row - param(token.params, 0, 1));
      state.col = 0;
      return;
    case 'G':
    case '`':
      state.col = Math.max(0, param(token.params, 0, 1) - 1);
      return;
    case 'H':
    case 'f': {
      // **Row 1 means the top row of the screen**, which is what makes the resize
      // repaint work: measured against a real ConPTY, the repaint homes here and
      // then walks down, and the numbers stay within 1..rows however far the
      // scrollback has grown.
      const row = param(token.params, 0, 1);
      const col = param(token.params, 1, 1);
      state.row = Math.min(state.viewportRows - 1, Math.max(0, row - 1));
      state.col = Math.max(0, col - 1);
      return;
    }
    case 'd': {
      const row = param(token.params, 0, 1);
      state.row = Math.min(state.viewportRows - 1, Math.max(0, row - 1));
      return;
    }
    case 'J':
      eraseDisplay(state, param(token.params, 0, 0));
      return;
    case 'K':
      eraseLine(state, param(token.params, 0, 0));
      return;
    default:
      // Colour (`m`), modes (`h`/`l`), window manipulation (`t`), device status
      // (`n`), scroll regions (`r`), saved cursors (`s`/`u`) and everything else:
      // recognised, and deliberately without an effect. See the module comment for
      // which of these is a real remaining limitation.
      return;
  }
}

/* ============================================================
   The pane's view, and the entry point
   ============================================================ */

/**
 * The rows the pane draws: everything, minus the blank rows below both the last
 * thing written and the cursor.
 *
 * Trimming matters rather than being cosmetic. The screen is as tall as the pane, so
 * an untrimmed list draws a screenful of empty `<div>`s under every short output —
 * the prompt would sit in a mostly blank pane with a scrollbar beside it. Which is
 * also why the trailing `ESC[K` rows of a resize repaint must land *inside* the
 * screen rather than after it: they are erasures, and an erasure of a row below the
 * content draws nothing.
 *
 * The cursor's own row is kept **even when blank**, because that is where a fresh
 * prompt is about to be written and where the person is looking.
 */
export function visibleLines(state: TerminalState): string[] {
  let end = -1;
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    if (state.rows[i] !== '') {
      end = i;
      break;
    }
  }
  const last = Math.max(end, bufferIndex(state, state.row));
  if (last < 0) return [''];
  return state.rows.slice(0, last + 1);
}

/**
 * Fit the screen to a new height.
 *
 * The only invariant to restore is that the buffer is at least as long as the
 * screen, because `screenTop` and `viewportRows` have to describe rows that exist.
 * Nothing has to be moved to keep the cursor on the same content: the two are
 * independent, so a taller screen simply takes more of what came before into view
 * and a shorter one leaves rows outside it. The cursor is clamped because a row
 * that is no longer on the screen cannot hold it.
 */
export function fitViewport(state: TerminalState, viewportRows: number): TerminalState {
  const height = Math.max(1, Math.floor(viewportRows));
  if (height === state.viewportRows) return state;
  const rows = [...state.rows];
  while (rows.length < state.screenTop + height) rows.push('');
  return {
    ...state,
    rows,
    row: Math.min(state.row, height - 1),
    viewportRows: height,
  };
}

/**
 * Apply one PTY batch to a terminal's state.
 *
 * The screen's height is read from the state, not passed in, because it is a fact
 * about the terminal rather than about the batch: `fitViewport` is the only writer,
 * and the pane reaches it through `resizeTerminal`. Two sources for it would be two
 * things to keep in step, and a batch applied against the wrong height scrolls at
 * the wrong moment.
 *
 * The bound is on the whole buffer, and the newest rows survive: dropping the recent
 * output would leave the pane showing the start of a build with no sign of the end,
 * which is the failure this bound exists to avoid rather than to create. `dropped`
 * says how many rows went, so the pane can state that it is not showing everything.
 * `screenTop` moves with the trim, so the screen keeps showing the same rows.
 */
export function applyTerminalOutput(
  state: TerminalState,
  data: string,
  limit: number,
): TerminalState {
  const { tokens, carry } = tokenizeTerminalChunk(state.carry, data);

  // A shallow copy of the mutable half, then the tokens are applied in order. The
  // rows array is copied once here rather than inside `writeAtCursor`, so a batch
  // of pure cursor movement — which is most of what a repaint is — does not copy
  // the array once per token.
  const next: TerminalState = { ...state, rows: [...state.rows] };
  for (const token of tokens) applyToken(next, token);
  next.carry = carry;

  if (next.rows.length > limit) {
    const over = next.rows.length - limit;
    next.rows = next.rows.slice(over);
    next.screenTop = Math.max(0, next.screenTop - over);
    next.dropped = next.dropped + over;
  }

  next.lines = visibleLines(next);
  return next;
}

/**
 * The tail a terminal starts life with.
 *
 * Exported as a function rather than a constant because the screen is as tall as
 * the pane, and a shared array would be mutated by the first write into it.
 */
export function initialTerminalState(viewportRows = DEFAULT_VIEWPORT_ROWS): TerminalState {
  const height = Math.max(1, Math.floor(viewportRows));
  const state: TerminalState = {
    lines: [],
    rows: new Array<string>(height).fill(''),
    screenTop: 0,
    viewportRows: height,
    row: 0,
    col: 0,
    carry: '',
    dropped: 0,
  };
  state.lines = visibleLines(state);
  return state;
}
