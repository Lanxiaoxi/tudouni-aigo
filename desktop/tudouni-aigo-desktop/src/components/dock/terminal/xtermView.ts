/**
 * The xterm.js end of a terminal view (docs/design/workspace-dock.md §7.3).
 *
 * This is the only file that imports `@xterm/xterm`: everything the manager
 * decides is written against `TermView`, so it can be tested without a DOM.
 *
 * A view owns **one container element for its whole life**. Showing a terminal
 * appends that element to a slot; hiding it removes it again. xterm is opened
 * into the container once, the first time it is shown, and is never re-opened or
 * disposed by a tab switch or a fold: the scrollback lives in the instance.
 */
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TermSize, TermView, ViewFactory } from '@/workspaceHost';

/** Token → xterm's palette slot, in ANSI order (0–7 normal, 8–15 bright). */
const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

/** The terminal's colours, read from the app's tokens (`tokens.css`) at the
 *  moment of the call, so a theme switch is picked up the next time it is shown.
 *  An unset token leaves xterm's own default for that slot. */
export function readTerminalTheme(root: Element = document.documentElement): ITheme {
  const style = getComputedStyle(root);
  const token = (name: string): string | undefined => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? undefined : value;
  };
  const theme: ITheme = {
    background: token('--terminal-bg'),
    foreground: token('--terminal-fg'),
    cursor: token('--accent'),
    cursorAccent: token('--terminal-bg'),
    selectionBackground: token('--lb-selected-line'),
  };
  ANSI_SLOTS.forEach((slot, n) => {
    theme[slot] = token(`--term-ansi-${n}`);
  });
  return theme;
}

function readFont(): { fontFamily: string | undefined; fontSize: number } {
  const style = getComputedStyle(document.documentElement);
  const family = style.getPropertyValue('--font-mono').trim();
  const size = Number.parseFloat(style.getPropertyValue('--text-code'));
  return { fontFamily: family === '' ? undefined : family, fontSize: Number.isFinite(size) ? size : 13 };
}

export const createXtermView: ViewFactory = ({ cols, rows, onData }) => {
  const font = readFont();
  const term = new Terminal({
    cols,
    rows,
    theme: readTerminalTheme(),
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    cursorBlink: true,
    scrollback: 5000,
    // The PTY already speaks CRLF; translating again would double-space output.
    convertEol: false,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const container = document.createElement('div');
  container.className = 'dterm-view';
  let opened = false;

  term.onData(onData);

  // Copy without breaking Ctrl+C: with a selection it copies, without one it is
  // the interrupt the shell expects. Ctrl+Shift+C always copies.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'c' && (event.shiftKey || term.hasSelection())) {
      const text = term.getSelection();
      if (text !== '') void navigator.clipboard?.writeText(text).catch(() => undefined);
      return false;
    }
    return true;
  });

  return {
    write(data) {
      term.write(data);
    },
    mount(slot) {
      (slot as HTMLElement).appendChild(container);
      if (!opened) {
        term.open(container);
        opened = true;
      }
    },
    unmount() {
      container.remove();
    },
    fit(): TermSize | null {
      // Hidden or not laid out yet: measuring would answer 0 and shrink the
      // PTY to nothing.
      if (!opened || !container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) {
        return null;
      }
      const proposed = fitAddon.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
      if (proposed.cols !== term.cols || proposed.rows !== term.rows) term.resize(proposed.cols, proposed.rows);
      return { cols: term.cols, rows: term.rows };
    },
    focus() {
      term.focus();
    },
    refreshTheme() {
      term.options.theme = readTerminalTheme();
    },
    dispose() {
      container.remove();
      term.dispose();
    },
  } satisfies TermView;
};
