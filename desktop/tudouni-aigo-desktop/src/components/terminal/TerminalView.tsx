import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useApp, useSessionField, NO_TERMINALS } from '@/state/store';
import { useT } from '@/i18n/useT';
import { Tip } from '@/components/ui/kit';
import { encodeKey } from '@/runtime/terminalKeys';
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
  const killTerminal = useApp((s) => s.killTerminal);
  const attachTerminal = useApp((s) => s.attachTerminal);

  const attached = useMemo(
    () => terminals.find((row) => row.id === attachedId) ?? null,
    [terminals, attachedId],
  );

  return (
    <div className="term-view">
      <TerminalTabs
        terminals={terminals}
        attachedId={attachedId}
        onPick={attachTerminal}
        onNew={() => createTerminal()}
        onKill={killTerminal}
      />
      {attached ? (
        <AttachedPane key={attached.id} row={attached} />
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

/** The tab strip: one tab per terminal, plus the new-terminal button. */
function TerminalTabs({
  terminals,
  attachedId,
  onPick,
  onNew,
  onKill,
}: {
  terminals: TerminalRow[];
  attachedId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onKill: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="term-tabs" role="tablist">
      {terminals.map((row) => (
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
            title={row.cwd === '' ? t('panel.term.cwdRoot') : row.cwd}
          >
            <span className="mono">{row.id}</span>
            {/* The status is the runtime's word, never derived here. Three
                endings read three ways: `killed`, `exited` with a code, and
                `exited` with none are different facts. */}
            <span className="term-tab-state">
              {row.status === 'running'
                ? t('panel.term.running')
                : row.status === 'killed'
                  ? t('panel.term.killed')
                  : row.exit_code === null || row.exit_code === undefined
                    ? t('panel.term.exitedNoCode')
                    : t('panel.term.exited', { code: row.exit_code })}
            </span>
          </button>
          <button
            type="button"
            className="term-tab-close"
            aria-label={t('panel.term.kill')}
            disabled={row.status !== 'running'}
            onClick={() => onKill(row.id)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <Tip label={t('panel.term.new')}>
        <button type="button" className="term-tab-add" aria-label={t('panel.term.new')} onClick={onNew}>
          <Plus size={12} />
        </button>
      </Tip>
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
function AttachedPane({ row }: { row: TerminalRow }) {
  const t = useT();
  const lines = useSessionField((rt) => rt.terminalOutput[row.id] ?? EMPTY_LINES, EMPTY_LINES);
  const terminalInput = useApp((s) => s.terminalInput);
  const resizeTerminal = useApp((s) => s.resizeTerminal);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);

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
      const cols = Math.max(1, Math.floor(target.clientWidth / cell.width));
      const rows = Math.max(1, Math.floor(target.clientHeight / cell.height));
      setSize((previous) =>
        previous && previous.cols === cols && previous.rows === rows ? previous : { cols, rows },
      );
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
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
          // Index keys are correct here and deliberately chosen: this is an
          // append-only bounded tail, so a line's position *is* its identity —
          // and a content hash would collide on the many repeated lines a build
          // log produces.
          <div className="term-line" key={i}>
            {line}
          </div>
        ))}
        {lines.length === 0 ? <div className="term-line faint">{t('common.loading')}</div> : null}
      </div>
      <div className="term-foot caption faint">
        {row.status === 'running' ? t('panel.term.hint') : t('panel.term.outline')}
        {size ? (
          <span className="mono">
            {' '}
            {size.cols}×{size.rows}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A stable empty array: a fresh `[]` on every render is a new reference and
 *  would re-render this pane on every store write. */
const EMPTY_LINES: string[] = [];

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
