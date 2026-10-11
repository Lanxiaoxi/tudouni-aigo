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
 *
 * ## Colour, and why it is an overlay rather than a grid
 *
 * SGR (`CSI … m`) is applied instead of dropped, so a shell's colours survive:
 * `ls --color`, a PowerShell prompt, `npm`'s warnings, PSReadLine's syntax
 * highlighting. The runtime does not need to change for this — it forwards the
 * PTY's bytes verbatim (`internal/terminal/session.go`), so the codes were always
 * on the wire and only this end was throwing them away.
 *
 * A real emulator would store one attribute set **per cell**. That is not what
 * happens here, and the choice is deliberate: a row stays a plain `string`, and
 * the colour lives beside it as **style runs** — `runs[row]` is a sorted,
 * non-overlapping list of `{ start, end, attr }`. Everything that depends on the
 * text keeps working unchanged (`lines` is still `string[]`, `visibleLines` still
 * slices rows), and only the pane, which has to paint it, reads the runs.
 *
 * The alternative — `rows: Cell[][]` — would have made every one of the string
 * assertions in `terminal.test.ts` wrong instead of merely incomplete, and it buys
 * nothing this pane needs: it does not emulate a screen grid (see above), so there
 * is no cell for an attribute to belong to.
 *
 * The cost of the overlay is that **every write has to carry its runs with it**,
 * and that is where the remaining difficulty in this module lives: a write replaces
 * a span, an erase clears one, a scroll and a trim move whole rows. Each of those
 * is a place where the text and its colours can drift apart, and the symptom (a
 * line that is suddenly the wrong colour, only after a long build) is invisible in
 * a short test — so each of them sets its runs at the same moment it sets the text.
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

/* ============================================================
   Colour: the pen, the runs, and the pixels
   ============================================================ */

/**
 * One SGR state: the colours and the switches a piece of text is drawn with.
 *
 * `color` and `background` are **CSS values, already resolved**. `null` means "the
 * terminal's default", which is what SGR 39/49 restore — it is not the same thing
 * as "the colour happens to be white", because the pane's default pair changes
 * with nothing here while a white foreground does not.
 *
 * Resolving indices to CSS in this module, rather than handing the pane a palette
 * index to look up, is what keeps the drawing side free of palette logic: the 16
 * base colours name the theme's own tokens (`--term-ansi-0` … `--term-ansi-15` in
 * `tokens.css`, so a theme may choose them), the 216-colour cube and the 24-step
 * greyscale are the standard xterm values (`ansiColour`), and a truecolour
 * sequence is the `rgb(...)` it asked for. One pure function knows how an index
 * becomes a colour, and it is asserted on its own.
 *
 * Attrs are treated as **immutable**, and that is load-bearing rather than
 * stylistic: the pane caches each one's inline style by identity (a `WeakMap`
 * keyed by the attr object), so an attr mutated in place would paint the old
 * colours for ever. Every write path below therefore builds a new attr instead of
 * editing the one it has, and `DEFAULT_ATTR` is frozen because it is shared.
 */
export interface TerminalAttr {
  /** Foreground, or `null` for the terminal's default. */
  color: string | null;
  /** Background, or `null` for the terminal's default. */
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** SGR 7: the two colours swap at draw time. */
  inverse: boolean;
}

/** The pen a terminal starts with: no colours, no switches. */
export const DEFAULT_ATTR: TerminalAttr = Object.freeze({
  color: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});

/** Whether an attr paints anything at all — i.e. equals the default. */
export function isDefaultAttr(attr: TerminalAttr): boolean {
  return (
    attr.color === null &&
    attr.background === null &&
    !attr.bold &&
    !attr.dim &&
    !attr.italic &&
    !attr.underline &&
    !attr.strike &&
    !attr.inverse
  );
}

/**
 * One stretch of a row that shares one attr. `start` inclusive, `end` exclusive.
 *
 * Runs within a row are **sorted and non-overlapping**, and they never claim a
 * range that the row's text does not have — because a run is only ever produced by
 * a write, and a write sets the text and the runs in the same operation (see
 * `spliceRuns`). The pane still clips defensively: a stale run would otherwise be
 * a slice of a shorter line, which is harmless, rather than a shifted colour,
 * which is not.
 */
export interface StyleRun {
  start: number;
  end: number;
  attr: TerminalAttr;
}

/**
 * The rows' runs, parallel to `rows`.
 *
 * A parallel array rather than a map keyed by row index, because a row index
 * shifts on a trim and on a scroll: with one list the two facts move together by
 * construction (`rows.slice(over)` / `runs.slice(over)`, `rows.push('')` /
 * `runs.push(NO_RUNS)`), and the invariant a reader has to hold is one sentence —
 * `runs.length === rows.length`, index for index.
 *
 * Most entries are the shared frozen `NO_RUNS`, so plain output costs one pointer
 * per row rather than an array per row.
 */
export const NO_RUNS: StyleRun[] = Object.freeze([]) as unknown as StyleRun[];

/** The xterm 6×6×6 cube's levels, and the only place they are written down. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/**
 * An ANSI palette index as a CSS colour.
 *
 * 0–15 go through the theme's tokens so the base colours are a design decision
 * rather than a hard-coded guess; 16–231 are the xterm colour cube and 232–255 the
 * 24-step greyscale, both by the standard formula, because there is no token for
 * "index 173" and inventing one would be 240 variables nobody would ever edit.
 */
export function ansiColour(index: number): string {
  const at = Math.max(0, Math.min(255, Math.floor(index)));
  if (at < 16) return `var(--term-ansi-${at})`;
  if (at < 232) {
    const n = at - 16;
    const r = CUBE_LEVELS[Math.floor(n / 36) % 6];
    const g = CUBE_LEVELS[Math.floor(n / 6) % 6];
    const b = CUBE_LEVELS[n % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const level = 8 + (at - 232) * 10;
  return `rgb(${level}, ${level}, ${level})`;
}

/** A truecolour sequence's components as CSS, each clamped to a byte. */
export function rgbColour(r: number, g: number, b: number): string {
  const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

/**
 * The inline style for one attr: the fields the pane hands to React.
 *
 * Typed as its own record rather than as `CSSProperties` so that this module stays
 * free of a React import, and `fontStyle` is the literal `'italic'` rather than
 * `string` so the object is assignable to `CSSProperties` without a cast (React's
 * own type is a union, and a plain `string` does not fit it).
 */
export interface TerminalAttrCss {
  color?: string;
  backgroundColor?: string;
  fontWeight?: number;
  fontStyle?: 'italic';
  textDecoration?: string;
  opacity?: number;
}

/**
 * The style for one attr, **cached by identity**.
 *
 * The cache is why `undefined` is a return value rather than an empty object: the
 * default pen is the overwhelmingly common case (any output that never changes
 * colour), and returning `undefined` for it means the pane hands React no `style`
 * at all rather than an object it has to diff. Every other attr is built once and
 * reused for as long as that attr is on screen — a build log has a handful of
 * distinct attrs and tens of thousands of spans.
 */
const ATTR_CSS_CACHE = new WeakMap<TerminalAttr, TerminalAttrCss>();

export function attrStyle(attr: TerminalAttr): TerminalAttrCss | undefined {
  if (isDefaultAttr(attr)) return undefined;
  const cached = ATTR_CSS_CACHE.get(attr);
  if (cached !== undefined) return cached;
  const css = attrCssOf(attr);
  ATTR_CSS_CACHE.set(attr, css);
  return css;
}

function attrCssOf(attr: TerminalAttr): TerminalAttrCss {
  // Inverse swaps the pair, and the swapped *default* is this pane's own pair
  // rather than the browser's black-on-white: the pane's background is
  // `--terminal-bg` in both themes, so that is what "the default background"
  // means on this surface.
  const color = attr.inverse ? (attr.background ?? 'var(--terminal-bg)') : attr.color;
  const background = attr.inverse ? (attr.color ?? 'var(--terminal-fg)') : attr.background;
  const css: TerminalAttrCss = {};
  if (color !== null) css.color = color;
  if (background !== null) css.backgroundColor = background;
  // 600 rather than `bold`, because the pane is set in a monospace face whose
  // bold is what a terminal's bold looks like — and `bolder` would depend on the
  // parent's weight, which is the pane's, not the run's.
  if (attr.bold) css.fontWeight = 600;
  // Faint is drawn the way a terminal draws it where the font has no light
  // weight, which is what the shipped face is.
  if (attr.dim) css.opacity = 0.65;
  if (attr.italic) css.fontStyle = 'italic';
  const decoration = [attr.underline ? 'underline' : '', attr.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  if (decoration !== '') css.textDecoration = decoration;
  return css;
}

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
  /**
   * Each row's coloured stretches, index for index with `rows`.
   *
   * `runs.length === rows.length` is the module's one structural invariant, and
   * it is maintained by moving the two together: `rows.slice` with `runs.slice`,
   * `rows.push('')` with `runs.push(NO_RUNS)`. A row with no colour at all holds
   * the shared `NO_RUNS`, so the common case costs a pointer rather than an array.
   */
  runs: StyleRun[][];
  /**
   * The pen the shell has set: what the next text written will look like.
   *
   * It lives on the state rather than being local to a batch because SGR is
   * **sticky across batches** — a shell emits `ESC[93m`, then flushes, and the
   * text that carries that colour arrives in the next read. A pen reset at each
   * batch boundary would colour the first line of each flush and nothing else.
   */
  attrs: TerminalAttr;
  /** The index in `rows` of the screen's first row. */
  screenTop: number;
  /** How many of `rows` — from `screenTop` on — are the screen. */
  viewportRows: number;
  /** The cursor's row **on the screen**, 0-based. */
  row: number;
  /** The cursor's column, 0-based, counted in string indices. */
  col: number;
  /**
   * Whether the shell wants the cursor drawn: `CSI ?25h` shows it, `CSI ?25l`
   * hides it.
   *
   * It is tracked rather than assumed because the shell **wraps every redraw in
   * the pair**. Measured from a real ConPTY, one keystroke arrives as
   * `ESC[m ESC[?25l` and then `ESC[93m… ESC[?25h`, and the boot sequence does the
   * same. So a pane that never read these two sequences drew no cursor at all —
   * the cursor was not merely in the wrong place, there was nothing on screen to
   * be in a place.
   *
   * It starts `true`, which is what a fresh terminal shows: the cursor is where
   * it is, and no shell has said otherwise yet.
   */
  cursorVisible: boolean;
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
  runs: Object.freeze([NO_RUNS]) as unknown as StyleRun[][],
  attrs: DEFAULT_ATTR,
  screenTop: 0,
  viewportRows: 1,
  row: 0,
  col: 0,
  cursorVisible: true,
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
 * Append one run, **unless it paints nothing**.
 *
 * "The default pen is the absence of a run" is the representation's one rule, and
 * this is where it is enforced: a stretch written with no colours and no switches is
 * simply not recorded, and the pane draws a gap. That is why plain output — which is
 * most output — makes no runs at all rather than a list of runs saying "no colour".
 *
 * Adjacent runs with the **same attr object** merge, because a shell that writes a
 * line in several flushes (which is ordinary: the PTY flushes where it flushes)
 * would otherwise leave one run per flush. Identity is the test rather than a deep
 * comparison, and that is enough: the pen is carried on the state and only replaced
 * when a sequence actually changes it, so consecutive writes with the same pen hold
 * the same object.
 */
function appendRun(into: StyleRun[], start: number, end: number, attr: TerminalAttr): void {
  if (end <= start) return;
  if (isDefaultAttr(attr)) return;
  const last = into[into.length - 1];
  if (last !== undefined && last.attr === attr && last.end === start) {
    into[into.length - 1] = { start: last.start, end, attr };
    return;
  }
  into.push({ start, end, attr });
}

/** The runs list for a row, or the shared empty one. Never `undefined`. */
function runsAt(state: TerminalState, at: number): StyleRun[] {
  return state.runs[at] ?? NO_RUNS;
}

/**
 * Replace the runs covering `[start, end)` with one run in `attr`.
 *
 * This is the operation the whole colour model rests on, and it is deliberately the
 * **same** operation for every write: text is written over a span, so its colour is
 * written over the same span. The three cases a row can be in are all here — a run
 * that ends before the span survives, one that starts after it survives, and one
 * that overlaps it is split into whatever lies outside the span. Doing it anywhere
 * else (patching runs after the fact, or recomputing them from the row's text) is how
 * the colours end up describing a row the text no longer is.
 *
 * The result is sorted and non-overlapping by construction, since a single in-order
 * pass over a sorted list emits the kept parts in order and inserts the new run
 * exactly once — at the first position where it belongs.
 */
function spliceRuns(
  runs: StyleRun[],
  start: number,
  end: number,
  attr: TerminalAttr,
): StyleRun[] {
  if (end <= start) return runs;
  const next: StyleRun[] = [];
  let placed = false;
  const place = () => {
    if (placed) return;
    appendRun(next, start, end, attr);
    placed = true;
  };
  for (const run of runs) {
    if (run.end <= start) {
      appendRun(next, run.start, run.end, run.attr);
      continue;
    }
    if (run.start >= end) {
      place();
      appendRun(next, run.start, run.end, run.attr);
      continue;
    }
    // Overlaps the span: the part before it and the part after it are kept, and the
    // middle — which is exactly what is being overwritten — is not.
    //
    // Both kept parts go through `appendRun` rather than being pushed, and that is
    // what makes "the same pen twice is one run" hold in the case a shell actually
    // produces: a redraw that rewrites the *middle* of a coloured line with that
    // same colour. Pushed directly, the three pieces would be three adjacent runs of
    // one colour — the same pixels, three times the spans and three style objects
    // for React to diff, on every keystroke of a coloured prompt.
    if (run.start < start) appendRun(next, run.start, start, run.attr);
    place();
    if (run.end > end) appendRun(next, end, run.end, run.attr);
  }
  place();
  return next.length === 0 ? NO_RUNS : next;
}

/** The runs clipped to `[0, end)` — what an erase that shortens a row leaves. */
function clipRuns(runs: StyleRun[], end: number): StyleRun[] {
  if (runs === NO_RUNS) return NO_RUNS;
  if (end <= 0) return NO_RUNS;
  const next: StyleRun[] = [];
  for (const run of runs) {
    if (run.start >= end) break;
    appendRun(next, run.start, Math.min(run.end, end), run.attr);
  }
  return next.length === 0 ? NO_RUNS : next;
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
 *
 * The padding columns are deliberately **left without runs**: a shell that moves its
 * cursor past the end of a line has not written there, so those columns are blank
 * cells in whatever attr the row already had for them — which is the default, and
 * therefore the absence of a run.
 */
function writeAtCursor(state: TerminalState, value: string): void {
  const at = bufferIndex(state, state.row);
  const current = state.rows[at] ?? '';
  const padded =
    current.length < state.col ? current + ' '.repeat(state.col - current.length) : current;
  state.rows[at] = padded.slice(0, state.col) + value + padded.slice(state.col + value.length);
  state.runs[at] = spliceRuns(runsAt(state, at), state.col, state.col + value.length, state.attrs);
  state.col += value.length;
}

/**
 * One row down, scrolling the screen when the cursor is already at its bottom.
 *
 * A scroll moves `screenTop` and appends a blank row; the cursor stays on the last
 * screen row, which is now that new row. Nothing is rewritten and no index is
 * renumbered, which is what keeps an absolute `CSI r;cH` sent after a scroll
 * landing where the shell meant.
 *
 * The runs move with the rows — `push` here, `push` there. This is the invariant in
 * practice: **every** place that touches `rows` touches `runs` in the same breath,
 * and a scroll that appended a row without appending its (empty) runs would shift
 * every colour in the pane by one line from that moment on.
 */
function advanceRow(state: TerminalState): void {
  if (state.row + 1 < state.viewportRows) {
    state.row += 1;
    const at = bufferIndex(state, state.row);
    if (state.rows[at] === undefined) {
      state.rows[at] = '';
      state.runs[at] = NO_RUNS;
    }
    return;
  }
  state.rows.push('');
  state.runs.push(NO_RUNS);
  state.screenTop += 1;
  state.col = 0;
}

/** Erase part of one row. `0` cursor→end, `1` start→cursor, `2` the whole row. */
function eraseLine(state: TerminalState, mode: number): void {
  const at = bufferIndex(state, state.row);
  const current = state.rows[at] ?? '';
  if (mode === 1) {
    // The prefix is replaced by spaces rather than removed, so what lies from the
    // cursor on **keeps its column and its colour** — this is the erasure a shell
    // uses to wipe the part of a line it is about to redraw.
    const kept = Math.min(state.col, current.length);
    state.rows[at] = ' '.repeat(kept) + current.slice(state.col);
    state.runs[at] = spliceRuns(runsAt(state, at), 0, kept, DEFAULT_ATTR);
    return;
  }
  if (mode === 2) {
    state.rows[at] = '';
    state.runs[at] = NO_RUNS;
    return;
  }
  state.rows[at] = current.slice(0, state.col);
  state.runs[at] = clipRuns(runsAt(state, at), state.col);
}

/** Erase part of the screen. `0` cursor→end, `1` start→cursor, `2` everything. */
function eraseDisplay(state: TerminalState, mode: number): void {
  const clear = (screenRow: number) => {
    const at = bufferIndex(state, screenRow);
    state.rows[at] = '';
    state.runs[at] = NO_RUNS;
  };
  if (mode === 2) {
    for (let r = 0; r < state.viewportRows; r += 1) clear(r);
    return;
  }
  if (mode === 0) {
    eraseLine(state, 0);
    for (let r = state.row + 1; r < state.viewportRows; r += 1) clear(r);
    return;
  }
  for (let r = 0; r < state.row; r += 1) clear(r);
  eraseLine(state, 1);
}

/** Whether two attrs are the same pen, field by field. */
function sameAttr(a: TerminalAttr, b: TerminalAttr): boolean {
  return (
    a.color === b.color &&
    a.background === b.background &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.inverse === b.inverse
  );
}

/**
 * Set some fields of the pen, **keeping the previous object when nothing changed**.
 *
 * The identity is what makes run merging work (see `appendRun`) and what makes the
 * pane's style cache hit: PSReadLine re-sends `ESC[93m` before every redraw, and a
 * fresh object each time would turn a cosmetic repeat into a new style for every
 * keystroke.
 */
function withAttr(current: TerminalAttr, patch: Partial<TerminalAttr>): TerminalAttr {
  const next: TerminalAttr = { ...current, ...patch };
  return sameAttr(current, next) ? current : next;
}

/**
 * The SGR parameters of one `CSI … m`, as numbers.
 *
 * An empty parameter means `0` (`ESC[m` is a reset, and `ESC[1;;31m` means
 * `1;0;31`), which is the rule the sequence itself is defined with rather than a
 * convenience. A **private** sequence (`CSI >4;2m`, `CSI ?25m`) is not SGR at all
 * and returns nothing: those share the final byte `m` and mean something else
 * entirely, and reading them as colour would paint somebody's output from an
 * instruction that was never about colour.
 *
 * Both separator forms are accepted. Semicolons are the common form; **colons** are
 * the ITU T.416 form (`38:5:196`), which is what some modern programs emit, and
 * leaving it unparsed would silently drop the colour of exactly those programs.
 */
function sgrParams(params: string): number[] {
  if (params === '') return [0];
  if (/^[?<=>]/.test(params)) return [];
  return params.split(/[;:]/).map((raw) => {
    if (raw === '') return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  });
}

/**
 * Apply one SGR sequence to the pen.
 *
 * Everything a terminal is expected to understand is here: the eight/ sixteen base
 * colours, the bright pair, the 256-colour and truecolour selects, and the switches
 * a shell actually uses (`bold`, `faint`, `italic`, `underline`, `inverse`,
 * `strike`) together with the codes that turn each of them back off.
 *
 * The **off** codes are not optional detail. A shell emits `ESC[1m…ESC[22m` around a
 * bold word, and a model that only read the "on" half would leave everything after
 * that word bold for the rest of the session — the failure would look like a
 * renderer that forgot where the word ended, which is exactly what it would be.
 *
 * Codes with no representation here (blink, conceal, fonts, ideogram attributes)
 * are skipped rather than treated as errors: a terminal that drew them as text would
 * be far worse than one that ignores them, and that is the same rule the module
 * applies to every unrecognised sequence.
 */
function applySgr(current: TerminalAttr, params: string): TerminalAttr {
  const codes = sgrParams(params);
  if (codes.length === 0) return current;
  let attr = current;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) {
      attr = DEFAULT_ATTR;
      continue;
    }
    if (code >= 30 && code <= 37) {
      attr = withAttr(attr, { color: ansiColour(code - 30) });
      continue;
    }
    if (code >= 40 && code <= 47) {
      attr = withAttr(attr, { background: ansiColour(code - 40) });
      continue;
    }
    if (code >= 90 && code <= 97) {
      attr = withAttr(attr, { color: ansiColour(code - 90 + 8) });
      continue;
    }
    if (code >= 100 && code <= 107) {
      attr = withAttr(attr, { background: ansiColour(code - 100 + 8) });
      continue;
    }
    if (code === 38 || code === 48) {
      // `…;5;n` selects a palette index, `…;2;r;g;b` a truecolour triple. The colon
      // form of the latter carries a colour-space id between the `2` and the
      // components (`38:2:0:255:0:0`, and programs write it with the id empty), so
      // one value is stepped over there — and only there, or the semicolon form
      // `38;2;255;0;0` would lose its red channel.
      //
      // The offsets are spelled out rather than derived from a "rest of the list"
      // slice, and that is the whole point of this block being written out: the
      // selector and its argument live at `i + 1` and `i + 2`, and reading the
      // **argument** out of `slice(i + 1)` would take the selector (`5`) as the
      // colour index — `38;5;196` would draw colour 5 and swallow the 196.
      const colon = params.includes(':');
      const mode = codes[i + 1];
      let value: string | null = null;
      // How many parameters after `code` this sequence consumed, the selector
      // included. `i` advances by this and then by the loop's own step.
      let used = 0;
      if (mode === 5) {
        value = ansiColour(codes[i + 2] ?? 0);
        used = 2;
      } else if (mode === 2) {
        // `base` is the first component; the colon form puts the colour-space id
        // immediately before it.
        const base = i + 2 + (colon ? 1 : 0);
        value = rgbColour(codes[base] ?? 0, codes[base + 1] ?? 0, codes[base + 2] ?? 0);
        used = base + 3 - i;
      }
      if (value !== null) {
        attr = withAttr(attr, code === 38 ? { color: value } : { background: value });
        // The consumed numbers are parameters like any other and must not be read
        // again: otherwise the `196` of `38;5;196` would be read as SGR 196 next
        // time round, which happens to mean nothing — but `38;5;1` would come back
        // as SGR 1 and turn the rest of the line bold.
        i += used;
      }
      continue;
    }
    switch (code) {
      case 1:
        attr = withAttr(attr, { bold: true });
        break;
      case 2:
        attr = withAttr(attr, { dim: true });
        break;
      case 3:
        attr = withAttr(attr, { italic: true });
        break;
      case 4:
        attr = withAttr(attr, { underline: true });
        break;
      case 7:
        attr = withAttr(attr, { inverse: true });
        break;
      case 9:
        attr = withAttr(attr, { strike: true });
        break;
      case 22:
        // `22` clears **both**, which is what the code says: there is no separate
        // "not faint".
        attr = withAttr(attr, { bold: false, dim: false });
        break;
      case 23:
        attr = withAttr(attr, { italic: false });
        break;
      case 24:
        attr = withAttr(attr, { underline: false });
        break;
      case 27:
        attr = withAttr(attr, { inverse: false });
        break;
      case 29:
        attr = withAttr(attr, { strike: false });
        break;
      case 39:
        attr = withAttr(attr, { color: null });
        break;
      case 49:
        attr = withAttr(attr, { background: null });
        break;
      default:
        break;
    }
  }
  return attr;
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
    case 'm':
      // **SGR, and it changes the pen rather than the screen.** Nothing is written
      // here: the sequence says what the *next* text looks like, which is why the
      // attr is state (and state that survives a batch boundary) rather than an
      // argument to the write.
      //
      // It is also why the erase paths need care about colour at all. Erasing does
      // not use the current pen here, and that is the ordinary behaviour: the cells
      // an erase clears are blank in the row's own attributes rather than in the
      // pen's, so a `ESC[41m ESC[K` leaves the row without a red run — a difference
      // from a real emulator, and one this model cannot express, because a row has
      // no attribute for cells nobody wrote to. What it can express, and does, is
      // that an erase never leaves a colour behind on text that is gone.
      state.attrs = applySgr(state.attrs, token.params);
      return;
    case 'h':
    case 'l': {
      // **DECTCEM, the cursor show/hide pair — `CSI ?25h` and `CSI ?25l`.**
      //
      // These were on the ignored list, and that is why this pane drew no cursor
      // at all: a real ConPTY wraps *every* redraw in the pair (measured: one
      // keystroke is `ESC[m ESC[?25l` then `ESC[93m… ESC[?25h`, and the boot
      // batch does the same around its repaint), so the sequence is not an
      // occasional decoration that could be skipped — it is on the wire
      // constantly, and a model that dropped it had nothing to draw a cursor
      // from.
      //
      // Only the **private** form is read. `CSI 25h` without the `?` is a
      // different mode number space entirely, and `param` strips the marker, so
      // the check has to be made on the raw text rather than on the parsed
      // number: treating a bare `CSI 25h` as DECTCEM would be reading somebody
      // else's instruction.
      if (token.params.startsWith('?') && param(token.params, 0, 0) === 25) {
        state.cursorVisible = token.final === 'h';
      }
      return;
    }
    default:
      // The other modes (`h`/`l`), window manipulation (`t`), device status (`n`),
      // scroll regions (`r`), saved cursors (`s`/`u`) and everything else:
      // recognised, and deliberately without an effect. Colour used to be on this
      // list; it is applied now (see the `m` case). See the module comment for
      // which of the rest are real remaining limitations.
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
 * Where the caret goes, as an index into what `visibleLines` returned, or `null`
 * when there is nothing to draw.
 *
 * `visibleLines` slices from index `0` of `rows`, so a row's **buffer** index is
 * also its index in `lines` — the cursor's row on the screen (`state.row`) is
 * therefore *not* its index here; `screenTop + row` is.
 *
 * Split out as a function rather than inlined into the pane for the same reason
 * `contentBoxOf` is: the arithmetic is one line, it has no error to throw, and
 * getting it wrong puts the caret on the wrong line — which looks exactly like a
 * cursor that tracks nothing, and is the failure this whole change exists to fix.
 *
 * The `col` is a **string index**, which is what the model counts in (see the
 * module comment on wide characters). An index past the end of the line is kept
 * as-is: that is the ordinary "about to type" position, and the pane draws it as a
 * bar. Clamping it to the line's length instead would silently move the caret onto
 * the last character of a line the shell believes it has already left.
 */
export function caretPosition(
  state: TerminalState,
  lines: string[],
): { line: number; col: number } | null {
  if (!state.cursorVisible) return null;
  const line = bufferIndex(state, state.row);
  if (line < 0 || line >= lines.length) return null;
  return { line, col: Math.max(0, state.col) };
}

/** One thing the pane draws on a row: a stretch of text, or the caret. */
export interface LineSegment {
  text: string;
  /**
   * The colours to draw it in, or **`null` for the pane's own**.
   *
   * `null` rather than a `DEFAULT_ATTR` because the pane's default is a CSS
   * variable pair, and the two are not the same thing: a run that explicitly
   * selected colour 7 draws that colour, while a row with no run at all draws
   * whatever the theme's terminal foreground is. The pane distinguishes them by
   * passing `style={undefined}` for `null`.
   */
  attr: TerminalAttr | null;
  /** True for the zero-width caret marker, which carries no text. */
  caret: boolean;
}

/**
 * One row, cut into the pieces the pane draws: its text split where its colours
 * change, and the caret inserted where the shell's cursor is.
 *
 * The caret is folded in here rather than being a second special case in the view,
 * and that is the whole point of the function: **a caret and a colour change can be
 * in the same place**, and two independent passes over the row would each have to
 * know about the other to avoid dropping a character between them. Splitting once,
 * in string-offset order, is what makes "the caret sits between two characters" and
 * "those two characters are different colours" one operation instead of a matrix of
 * cases.
 *
 * `runs` is walked rather than assumed to cover the row: a run may start past a gap,
 * and the gaps are emitted as uncoloured text. Everything is clipped to the row's
 * own length, so a stale run — which a later erase could leave behind — draws too
 * little rather than slicing text out of a row it no longer belongs to.
 *
 * `caret` is a **string index**, like the cursor's `col` everywhere else, and it is
 * allowed to be past the end of the text: that is the ordinary "about to type"
 * position, and the caret goes at the end there.
 */
export function lineSegments(line: string, runs: StyleRun[], caret: number | null): LineSegment[] {
  const pieces: LineSegment[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(run.start, at);
    const end = Math.min(run.end, line.length);
    if (end <= start) continue;
    if (start > at) pieces.push({ text: line.slice(at, start), attr: null, caret: false });
    pieces.push({ text: line.slice(start, end), attr: run.attr, caret: false });
    at = end;
  }
  if (at < line.length) pieces.push({ text: line.slice(at), attr: null, caret: false });
  if (caret === null) return pieces;

  const target = Math.max(0, caret);
  const out: LineSegment[] = [];
  let placed = false;
  let before = 0;
  for (const piece of pieces) {
    const end = before + piece.text.length;
    if (!placed && target <= before) {
      out.push({ text: '', attr: null, caret: true });
      placed = true;
    }
    if (!placed && target < end) {
      const cut = target - before;
      out.push({ text: piece.text.slice(0, cut), attr: piece.attr, caret: false });
      out.push({ text: '', attr: null, caret: true });
      placed = true;
      const rest = piece.text.slice(cut);
      if (rest !== '') out.push({ text: rest, attr: piece.attr, caret: false });
    } else {
      out.push(piece);
    }
    before = end;
  }
  // Past the end of every piece: the caret is simply the last thing on the row,
  // which is where it sits while a line is being typed on an empty prompt.
  if (!placed) out.push({ text: '', attr: null, caret: true });
  return out;
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
  const runs = [...state.runs];
  // The two grow together, or the invariant `runs.length === rows.length` is broken
  // by exactly the rows a taller screen just added — and the colours of every row
  // below the first new one would be attributed to the row above it.
  while (rows.length < state.screenTop + height) {
    rows.push('');
    runs.push(NO_RUNS);
  }
  return {
    ...state,
    rows,
    runs,
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
  // the array once per token. `runs` is copied alongside it for the same reason and
  // as a single act: the two lists are one structure with two halves, and a batch
  // that wrote text into a copied `rows` while pushing to the previous `runs` is the
  // one way the invariant can be broken without anybody noticing.
  const next: TerminalState = { ...state, rows: [...state.rows], runs: [...state.runs] };
  for (const token of tokens) applyToken(next, token);
  next.carry = carry;

  if (next.rows.length > limit) {
    const over = next.rows.length - limit;
    next.rows = next.rows.slice(over);
    // The runs are trimmed by the same `over`, so a row's colours stay attached to
    // that row — a trim that sliced only the text would shift every colour in the
    // pane up by the number of rows dropped, from the first bound onwards.
    next.runs = next.runs.slice(over);
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
  const rows = new Array<string>(height).fill('');
  const state: TerminalState = {
    lines: [],
    rows,
    runs: new Array<StyleRun[]>(height).fill(NO_RUNS),
    attrs: DEFAULT_ATTR,
    screenTop: 0,
    viewportRows: height,
    row: 0,
    col: 0,
    cursorVisible: true,
    carry: '',
    dropped: 0,
  };
  state.lines = visibleLines(state);
  return state;
}
