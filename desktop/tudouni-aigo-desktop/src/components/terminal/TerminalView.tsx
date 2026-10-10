import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { useApp, useSessionField, EMPTY_TAIL, NO_STRINGS, NO_TERMINALS } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { encodeKey } from '@/runtime/terminalKeys';
import { caretPosition } from '@/runtime/terminalOutput';
import type { TerminalRow } from '@/protocol/types';

/**
 * The terminal view: a shell's output, and a keyboard that belongs to it.
 *
 * **It replaces the transcript, and that is a deliberate choice about what this
 * window can honestly show.** A real terminal is a screen grid plus a cursor:
 * escape sequences move the cursor, clear regions, scroll, and a program like
 * `vim` or `top` addresses cells directly. Emulating that properly is a terminal
 * emulator, which is a project rather than a panel — and the design puts that
 * work on the *client's* side of the boundary precisely so the runtime can stay
 * one thing.
 *
 * So this view does the honest half: it draws the bytes as text (with the
 * runtime's own batch boundaries preserved, so nothing is reordered), keeps a
 * **bounded** tail of them, and hands every keystroke to the shell byte for byte.
 * That is enough for the case a workspace terminal is usually wanted for —
 * running a command and reading what it said — and it is not pretending to be
 * more than it is.
 *
 * What it must never do is **interpret** a keystroke. `Ctrl+C` goes to the shell
 * (where it interrupts that shell's command) rather than closing anything here;
 * Escape is the ESC byte rather than "leave"; arrows are CSI sequences rather
 * than caret movement. A front end that kept its own bindings while attached
 * would make the shell's own job control unreachable — which is the one thing
 * the design is explicit about.
 *
 * Which terminal is attached is `activeTerminalId` — the **only** fact about a
 * terminal this front end owns (design §21). The process, the cwd and the status
 * are the runtime's, and this view reads them from the snapshot rather than
 * deciding any of them.
 */
export function TerminalView() {
  const t = useT();
  const terminals = useSessionField((rt) => rt.terminals, NO_TERMINALS);
  const attachedId = useSessionField((rt) => rt.activeTerminalId, null);
  const createTerminal = useApp((s) => s.createTerminal);
  const closeTerminal = useApp((s) => s.closeTerminal);
  const attachTerminal = useApp((s) => s.attachTerminal);

  const attached = useMemo(
    () => terminals.find((row) => row.id === attachedId) ?? null,
    [terminals, attachedId],
  );

  const pending = useSessionField((rt) => rt.terminalPending, NO_STRINGS);

  // Leaving is a **first-class control**, not a side effect of picking a tab.
  // The view replaced the transcript and the composer, so without this the only
  // way back was to close a shell — a destructive answer to "I want to read what
  // the model said".
  const leave = () => attachTerminal(null);

  return (
    <div className="term-view">
      <TerminalTabs
        terminals={terminals}
        attachedId={attachedId}
        pending={pending}
        onPick={(id) => attachTerminal(id === attachedId ? null : id)}
        onNew={() => createTerminal()}
        onClose={closeTerminal}
        onLeave={leave}
      />
      {attached ? (
        <AttachedPane key={attached.id} row={attached} onLeave={leave} />
      ) : (
        <div className="term-empty">
          <p>{t('panel.term.empty')}</p>
          <button type="button" className="btn btn-outline" onClick={() => createTerminal()}>
            <Plus size={13} />
            {t('panel.term.new')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The tab strip: one tab per terminal, the new-terminal button, and the way out.
 *
 * `onPick` **toggles**: clicking the tab already being read goes back to the
 * conversation rather than re-selecting it. That is *a* way out, but it was the
 * only one, and it is not one a person can find — a tab that looks like a tab
 * does not advertise "press me again to leave". So there is also an explicit
 * `onLeave`, drawn as a named button, and the pane's footer names the key.
 */
function TerminalTabs({
  terminals,
  attachedId,
  pending,
  onPick,
  onNew,
  onClose,
  onLeave,
}: {
  terminals: TerminalRow[];
  attachedId: string | null;
  pending: string[];
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onLeave: () => void;
}) {
  const t = useT();
  /**
   * Which running terminal has asked to be closed once already.
   *
   * The same two-press rule the session list uses for a delete, and for the same
   * reason: ending a terminal takes down a **whole process tree** — `shell → npm
   * → node` is the ordinary shape of a command — and it cannot be undone. An
   * ended terminal needs no confirmation, because forgetting a record destroys
   * nothing but the record.
   */
  const [armed, setArmed] = useState<string | null>(null);
  return (
    <div className="term-tabs" role="tablist">
      {terminals.map((row) => {
        const running = row.status === 'running';
        const isArmed = armed === row.id;
        return (
          <div
            key={row.id}
            className={`term-tab${row.id === attachedId ? ' is-current' : ''}`}
            data-status={row.status}
          >
            <button
              type="button"
              role="tab"
              aria-selected={row.id === attachedId}
              className="term-tab-main"
              onClick={() => onPick(row.id)}
              title={
                row.id === attachedId
                  ? t('panel.term.detach')
                  : row.cwd === ''
                    ? t('panel.term.cwdRoot')
                    : row.cwd
              }
            >
              <span className="mono">{row.id}</span>
              {/* The status is the runtime's word, never derived here. Three
                  endings read three ways: `killed`, `exited` with a code, and
                  `exited` with none are different facts. */}
              <span className="term-tab-state">
                {running
                  ? t('panel.term.running')
                  : row.status === 'killed'
                    ? t('panel.term.killed')
                    : row.exit_code === null || row.exit_code === undefined
                      ? t('panel.term.exitedNoCode')
                      : t('panel.term.exited', { code: row.exit_code })}
              </span>
            </button>
            {/* End it, then forget it — and **both presses are needed**, so this
                says which one it will do. An ended terminal is only forgotten
                (nothing is lost but the record); a running one has to be ended
                first, because the runtime refuses to forget a terminal whose
                process is alive.

                It used to be one press here and two in the panel — the same
                destructive act with two different confirmation rules — and the
                20px button sits right against the tab it belongs to, so "switch
                tab" and "kill the process tree" were one slip apart. */}
            {/* **It is never disabled.** An ended terminal's tab used to have a
                dead button here, which left no way at all to remove it — the row
                stays in the list on purpose (it is what answers "what was I
                running"), so the only thing that could ever take it off was the
                control that was greyed out. */}
            <button
              type="button"
              className={`term-tab-close${isArmed ? ' is-armed' : ''}`}
              aria-label={
                running
                  ? isArmed
                    ? t('panel.term.closeRunningConfirm')
                    : t('panel.term.closeRunning')
                  : t('panel.term.close')
              }
              title={
                running
                  ? isArmed
                    ? t('panel.term.closeRunningConfirm')
                    : t('panel.term.closeRunning')
                  : t('panel.term.close')
              }
              onClick={() => {
                if (running && !isArmed) {
                  setArmed(row.id);
                  return;
                }
                setArmed(null);
                onClose(row.id);
              }}
              onBlur={() => {
                if (isArmed) setArmed(null);
              }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      {/* **Disabled while a create is in flight.** Two quick presses used to send
          two `terminal_create` messages, which the runtime answered with two real
          shells — and because the reply attaches the view to the newest one, the
          first was left as a tab nobody remembered asking for. */}
      <Tip label={t('panel.term.new')}>
        <button
          type="button"
          className="term-tab-add"
          aria-label={t('panel.term.new')}
          disabled={pending.includes('new')}
          onClick={onNew}
        >
          <Plus size={12} />
        </button>
      </Tip>
      {/* The way back, as a named control rather than a hint. It is on the strip
          because that is where the person already is, and it is only drawn while
          a terminal has the screen — there is nothing to leave otherwise. */}
      {attachedId !== null ? (
        <button
          type="button"
          className="term-leave"
          title={t('panel.term.leaveHint')}
          onClick={onLeave}
        >
          <ArrowLeft size={12} />
          {t('panel.term.leave')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One attached terminal: its output, and the keyboard.
 *
 * `key` on this component is set to the terminal's id so switching terminals
 * remounts it — which is what drops the previous shell's seen-output cursor and
 * scroll position. Carrying them across would leave the view scrolled to the
 * bottom of a *different* terminal's output.
 */
function AttachedPane({ row, onLeave }: { row: TerminalRow; onLeave: () => void }) {
  const t = useT();
  const tail = useSessionField((rt) => rt.terminalTails[row.id] ?? EMPTY_TAIL, EMPTY_TAIL);
  const lines = tail.lines;
  // **Where the caret goes, or `null` when the shell has hidden it.** Read from
  // the same tail as `lines` rather than from a second source: the cursor and the
  // row text only mean anything together, which is why they are one value.
  const caret = useMemo(() => caretPosition(tail, lines), [tail, lines]);
  const terminalInput = useApp((s) => s.terminalInput);
  const resizeTerminal = useApp((s) => s.resizeTerminal);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  // Whether an overlay is holding the keyboard. Read here because it decides who
  // owns the keyboard, and the pane is the other claimant.
  const overlayOpen = useApp((s) => s.panel !== null || s.modal !== null);

  /**
   * **The pane takes the keyboard whenever no overlay is holding it.**
   *
   * `onKeyDown` fires only while the pane has focus, so focus *is* the feature: a
   * pane without it is a terminal that silently ignores everything typed into it.
   * Two measured paths made that the case, and this effect is the one rule that
   * covers both:
   *
   *   - **On mount**, because nothing focused it: the pane has `tabIndex` but no
   *     `autoFocus`, so after pressing Enter on a terminal in the panel the
   *     keyboard went nowhere at all. The person had to work out that clicking the
   *     black area was the missing step — a rule nobody was told about and nothing
   *     on screen hinted at.
   *   - **When an overlay closes**, which is the half that a mount-only effect
   *     could not do and did not: the pane mounts while the panel that created it
   *     is still open, so its focus call runs *inside* the dialog's focus trap and
   *     is then undone when Radix restores focus on close. Measured: `Esc` after
   *     "New terminal" left `document.activeElement` as `BODY`, so typing did
   *     nothing until the pane was clicked with the mouse.
   *
   * A frame's delay on the second path is deliberate rather than incidental: the
   * restore Radix performs happens after its own close handling, so claiming focus
   * in the same commit would be claimed *before* it is taken back. One frame later
   * is after it, and still before a person can type.
   *
   * Done in an effect rather than with `autoFocus` because the pane must take focus
   * **after** it is in the document; and `preventScroll` because focusing an element
   * inside a scroller can otherwise scroll it into view and move the output under
   * the reader.
   */
  useEffect(() => {
    // The dialog owns the keyboard while it is up; taking it then would fight the
    // focus trap and lose (see above). It gets claimed when the overlay closes.
    if (overlayOpen) return;
    const frame = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [row.id, overlayOpen]);

  // Scroll with the output, which is what a terminal does. Only when the shell
  // is still running: a finished shell's last screenful is a record somebody is
  // reading, and yanking it away as a late batch arrives would be worse than
  // useless.
  useEffect(() => {
    if (row.status !== 'running') return;
    const node = ref.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines, row.status]);

  /**
   * Tell the runtime how big the pane is.
   *
   * It is required rather than cosmetic: `vim`, `top`, `htop` and `less` read the
   * size and lay themselves out from it, so a shell that is never told draws at
   * 80 columns inside a 900-pixel pane. `ResizeObserver` rather than a window
   * listener because the pane's size changes for reasons that are not window
   * resizes — folding the sidebar, opening a panel.
   *
   * The cell size is measured rather than assumed: an 8px monospace cell is a
   * guess, and a guess that is wrong by 20% gives the shell a width that does
   * not match what is on screen, which is the same failure as not resizing at
   * all.
   */
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    function measure() {
      const target = ref.current;
      if (!target) return;
      const cell = measureCell(target);
      if (cell.width <= 0 || cell.height <= 0) return;
      // The **content box**, not `clientWidth`/`clientHeight`. Both of those
      // include padding, and this pane has some (`--space-2 --space-3` = 8px
      // vertical, 12px horizontal): measured, a 424px `clientWidth` with a
      // 6.873px cell reported **61** columns where the real usable width of
      // 400px is **58**. A shell told 61 wraps its output past the pane's right
      // edge — the same failure as never resizing, reached from the other side.
      // `offsetWidth - clientWidth` is the scrollbar, which `overflow: auto`
      // adds when it appears and which `clientWidth` already excludes but
      // `clientHeight` does not for a horizontal one.
      const box = contentBox(target);
      const cols = Math.max(1, Math.floor(box.width / cell.width));
      const rows = Math.max(1, Math.floor(box.height / cell.height));
      setSize((previous) =>
        previous && previous.cols === cols && previous.rows === rows ? previous : { cols, rows },
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // **Re-measure once the webfont arrives.** `ResizeObserver` fires on *size*
    // changes, and swapping the font does not change the pane's size — it changes
    // how wide a character is. Mounted before JetBrains Mono was ready, the
    // measurement above is of the fallback (Consolas, 6.873px) and nothing would
    // ever measure again, so `cols` stayed too large for the life of the pane.
    // `document.fonts` is absent in some hosts, hence the guard.
    void document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!size) return;
    resizeTerminal(row.id, size.cols, size.rows);
  }, [row.id, size, resizeTerminal]);

  /**
   * The keyboard. `tabIndex` plus `onKeyDown` rather than a window listener, and
   * that is the load-bearing choice: this fires only while the pane has focus, so
   * a person can click into it, use their modifier keys for the shell, and then
   * click out and use the window's shortcuts again without any mode to escape
   * from.
   *
   * Every key that has a terminal meaning is sent and **`preventDefault`ed**, so
   * nothing leaks to the window's handlers — otherwise `Ctrl+B` would fold a rail
   * while the shell was also receiving it.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // **`Ctrl+Shift+\` leaves, and it is tested before the encoder.** That order
    // is required rather than tidy: `encodeKey` deliberately ignores Shift on a
    // single character, so `Ctrl+\` and `Ctrl+Shift+\` both encode to `0x1C` —
    // checking after it would mean taking plain `Ctrl+\` away from the shell,
    // which is a real byte a program may want. `Ctrl+Shift+\` is the combination
    // the TUI picked for the same reason, and the pane's footer names it.
    //
    // It comes **before the `running` guard** as well: leaving has to work for an
    // ended terminal, which is exactly the case where the view had no way out at
    // all (its close button was disabled and the shell was gone).
    if (e.ctrlKey && e.shiftKey && e.key === '\\') {
      e.preventDefault();
      e.stopPropagation();
      onLeave();
      return;
    }
    if (row.status !== 'running') return;
    const data = encodeKey(e);
    if (data === '') return;
    e.preventDefault();
    e.stopPropagation();
    terminalInput(row.id, data);
  }

  return (
    <div className="term-pane-wrap">
      <div
        className="term-pane scroll"
        ref={ref}
        tabIndex={0}
        role="log"
        aria-label={t('panel.term.title')}
        onKeyDown={onKeyDown}
      >
        {lines.map((line, i) => (
          // **The absolute line number, not the index.** The array is bounded and
          // drops from the front, so index `0` is a *different* line before and
          // after a drop: with `key={i}` every row's key shifts at once and React
          // rewrites the text of the whole pane, on the batch where a long command
          // is already producing the most output.
          //
          // `tail.dropped + i` is stable, because a line is only ever appended or
          // removed from the head — which is exactly the identity a key needs. A
          // content hash would be the other candidate and is wrong here: a build
          // log repeats the same line many times, so equal keys would collide.
          <div className="term-line" key={tail.dropped + i}>
            {/* **The row the shell's cursor is on is drawn as a grid of two
                spans**, so the caret can sit *between* two characters rather than
                next to them — the one thing `textContent` cannot express. Splitting
                only this row (and only when its column is inside it) keeps the rest
                of the pane as plain text, which is what `white-space: pre` and the
                row's `content-visibility` were written for. */}
            {caret !== null && caret.line === i ? (
              <>
                <span>{line.slice(0, caret.col)}</span>
                <span className="term-caret" />
                <span>{line.slice(caret.col)}</span>
              </>
            ) : (
              line
            )}
          </div>
        ))}
        {lines.length === 0 ? <div className="term-line faint">{t('common.loading')}</div> : null}
      </div>
      {/* The footer states **both** halves of the contract: what the keys do
          (the runtime's own sentence), and how to get out. The way out used to
          be undocumented — the only one was clicking the current tab again, and
          nothing on screen said so. */}
      <div className="term-foot caption faint">
        {/* **How the shell ended, in the pane that is showing it.**
            The ending is also written into the transcript as a note, and while a
            terminal is attached the transcript is *replaced by this view* — so
            the one message about the shell somebody was watching was the one
            message they could not see. The tab's status word is not a substitute:
            it says `killed`, and the footer is where the sentence is read.

            Three endings, three sentences, and the same three the note uses:
            `killed`, `exited` with a code, and `exited` with none are different
            facts — a killed shell did not choose an exit status. */}
        <span className="term-foot-hint">
          {row.status === 'running' ? (
            t('panel.term.hint')
          ) : (
            <span className="term-ended">
              {row.status === 'killed'
                ? t('panel.term.killed')
                : row.exit_code === null || row.exit_code === undefined
                  ? t('panel.term.exitedNoCode')
                  : t('panel.term.exited', { code: row.exit_code })}
              {' · '}
              {t('panel.term.outline')}
            </span>
          )}
        </span>
        <span className="term-foot-right">
          {/* **The buffer is bounded, and it says so once it has bitten.**
              `TERMINAL_SCROLLBACK` discards the oldest output, and a log that has
              been cut with no sign of it is a log somebody reads as complete —
              they will search it, not find what they expected, and conclude the
              command did not print it. The sentence existed in i18n and had no
              reference anywhere. */}
          {tail.dropped > 0 ? (
            <span className="term-dropped" role="status">
              {t('panel.term.dropped')}
            </span>
          ) : null}
          <button type="button" className="term-leave-inline" onClick={onLeave}>
            {t('panel.term.leave')}
          </button>
          {size ? (
            <span className="mono">
              {size.cols}×{size.rows}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * The pane's **content box**, in pixels.
 *
 * `clientWidth`/`clientHeight` include padding; the padding here is
 * `--space-2 --space-3` (8px vertical, 12px horizontal), which is 24px of width
 * and 16px of height that no character can occupy. Reporting it as usable made
 * the shell wrap three columns past the pane's right edge — and the code below
 * already measures the cell precisely, so being wrong at the other end defeats
 * the same care.
 *
 * The vertical scrollbar is the other half: `overflow: auto` takes it out of
 * `clientWidth` already, but a horizontal scrollbar (which `white-space: pre`
 * makes likely) comes out of `clientHeight` only through the difference against
 * `offsetHeight`.
 */
export function contentBox(el: HTMLElement): { width: number; height: number } {
  const cs = window.getComputedStyle(el);
  return contentBoxOf({
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
    offsetWidth: el.offsetWidth,
    paddingLeft: parseFloat(cs.paddingLeft),
    paddingRight: parseFloat(cs.paddingRight),
    paddingTop: parseFloat(cs.paddingTop),
    paddingBottom: parseFloat(cs.paddingBottom),
  });
}

/** The measurements `contentBoxOf` needs. A subset of what an element reports. */
export interface PaneMeasurements {
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
}

/**
 * The same arithmetic, as a **pure function**.
 *
 * Split out from the DOM read on purpose, and it is the same reason
 * `terminalKeys.ts` takes a plain descriptor rather than a `KeyboardEvent`: the
 * mistake this exists to prevent is in the arithmetic, it has no error to throw
 * and nothing about the pane looks wrong — it just quietly wraps the shell's
 * output three columns past the right edge. The report's own measurement is what
 * the assertion in `terminal.test.ts` replays:
 *
 *     clientWidth = 424, padding 12 + 12, cell 6.873px
 *     424 / 6.873 = 61.7 -> 61 columns   (wrong: 24px of padding is not usable)
 *     400 / 6.873 = 58.2 -> 58 columns   (right)
 *
 * The scrollbar term is the other half. `overflow: auto` takes a vertical
 * scrollbar out of `clientWidth` already, but a **horizontal** one — which
 * `white-space: pre` makes likely — comes out of the visible height only through
 * `offsetWidth - clientWidth`, and a `rows` that ignores it is a line too tall.
 */
export function contentBoxOf(m: PaneMeasurements): { width: number; height: number } {
  const padX = m.paddingLeft + m.paddingRight;
  const padY = m.paddingTop + m.paddingBottom;
  const scrollbar = m.offsetWidth - m.clientWidth;
  // Floored at 1 so a pane mid-layout reports a size a shell can use rather than
  // zero: the runtime refuses a nonsensical size, and "no resize" is a worse
  // answer than a small one.
  return {
    width: Math.max(1, m.clientWidth - padX - scrollbar),
    height: Math.max(1, m.clientHeight - padY),
  };
}

/**
 * Measure one character cell by rendering a known string off-screen.
 *
 * It is done rather than assumed because the assumption is not safe: the pane's
 * font is whatever the system resolution gave it, and a cell assumed to be 8px
 * in a pane whose real cell is 9px reports a width 12% too wide — the shell then
 * wraps its output past the right edge of the pane showing it.
 */
function measureCell(parent: HTMLElement): { width: number; height: number } {
  const probe = document.createElement('span');
  probe.textContent = 'MMMMMMMMMM';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  const computed = window.getComputedStyle(parent);
  probe.style.font = computed.font;
  probe.style.fontFamily = computed.fontFamily;
  probe.style.fontSize = computed.fontSize;
  probe.style.lineHeight = computed.lineHeight;
  parent.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  parent.removeChild(probe);
  return { width: rect.width / 10, height: rect.height || 1 };
}
