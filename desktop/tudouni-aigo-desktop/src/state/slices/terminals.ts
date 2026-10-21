/**
 * terminals slice.
 *
 * Moved verbatim out of store.ts; the wrapper is all that changed — the
 * shared helpers arrive as `ctx` instead of being closed over.
 */
import type { StoreContext } from '../storeContext';
import type { AppStore } from '../storeShape';
import { nextId } from '@/state/entries';
import { sendTo } from '@/runtime/bus';
import { nextTerminalId, resizeTerminalTail } from '../terminal';

export function terminalsSlice(ctx: StoreContext): Pick<AppStore, 'listTerminals' | 'createTerminal' | 'terminalInput' | 'resizeTerminal' | 'killTerminal' | 'stopSubagent' | 'closeTerminal' | 'attachTerminal' | 'toggleTerminalView'> {
  const { get, patch, patchWith } = ctx;
  return {
    listTerminals() {
      const key = get().activeKey;
      if (key === null) return;
      sendTo(key, { v: 1, t: 'terminal_list' });
    },

    createTerminal(options) {
      const key = get().activeKey;
      if (key === null) return;
      // **Marked in flight before the request goes out**, and that is not an
      // optimistic update: it claims nothing about a terminal — it records that
      // this window has just asked for one. Without it the two "+" buttons stayed
      // live, and two quick presses created **two real shells**; the second
      // `terminal_created` then attached the view to it, so the first one was
      // left as a tab nobody remembers asking for.
      //
      // The sentinel is the string `'new'` rather than an id, because there is no
      // id yet — creation is what produces one. `terminal_created` releases it on
      // success and `ui(terminals)` releases it on a refusal, which is why a
      // refused create cannot leave the button disabled for ever.
      patchWith(key, (current) => ({
        terminalPending: current.terminalPending.includes('new')
          ? current.terminalPending
          : [...current.terminalPending, 'new'],
      }));
      // The size is sent only when the caller has one: the runtime's own default
      // is the right answer here, and this layer has no idea how big the pane
      // will be when the shell's first output arrives.
      const message: {
        v: 1;
        t: 'terminal_create';
        cwd?: string;
        cols?: number;
        rows?: number;
      } = { v: 1, t: 'terminal_create' };
      if (options?.cwd !== undefined && options.cwd !== '') message.cwd = options.cwd;
      if (options?.cols !== undefined) message.cols = options.cols;
      if (options?.rows !== undefined) message.rows = options.rows;
      sendTo(key, message);
    },

    terminalInput(id, data) {
      const key = get().activeKey;
      if (key === null) return;
      // Fire and forget, and that is the shape of a terminal rather than a
      // shortcut: the reply is `ui(terminal_output)` on its own schedule, and
      // most input (a keystroke in a shell that is waiting) produces none at all.
      sendTo(key, { v: 1, t: 'terminal_input', terminal_id: id, data });
    },

    resizeTerminal(id, cols, rows) {
      const key = get().activeKey;
      if (key === null) return;
      // A size nobody asked for is worse than none: `vim` and `top` redraw at the
      // wrong width, which on screen is indistinguishable from a rendering bug
      // in this window. So a nonsensical size is dropped here as well as in the
      // runtime.
      if (cols <= 0 || rows <= 0) return;
      // **The local screen is fitted as well as the shell being told.** The two are
      // not the same fact and both are needed: the runtime needs it so the shell
      // lays itself out, and this front end needs it because the cursor is addressed
      // in screen rows — a 10-row shell redraws at `CSI 9;60H`, and a model that
      // still believed it had 24 rows would resolve that row to the wrong line.
      // Fitting it here rather than when the bytes arrive also means the next batch
      // is already interpreted against the right height.
      patchWith(key, (current) => ({
        terminalTails: resizeTerminalTail(current.terminalTails, id, rows),
      }));
      sendTo(key, { v: 1, t: 'terminal_resize', terminal_id: id, cols, rows });
    },

    killTerminal(id) {
      const key = get().activeKey;
      if (key === null) return;
      patchWith(key, (current) => ({
        terminalPending: current.terminalPending.includes(id)
          ? current.terminalPending
          : [...current.terminalPending, id],
      }));
      // **No optimistic status change.** The row still reads whatever the
      // runtime last said, and it changes when `ui(terminal_exit)` arrives —
      // which is the design's rule that the runtime is the only source of truth
      // for whether a terminal is running. A kill that was refused must not look
      // like a kill that worked.
      sendTo(key, { v: 1, t: 'terminal_kill', terminal_id: id });
    },

    stopSubagent(id) {
      const key = get().activeKey;
      if (key === null) return;
      // Same discipline as killTerminal: no optimistic removal. The row stays
      // whatever the last snapshot said until the settlement comes back through
      // the board and the next `ui(state)` carries it.
      sendTo(key, { v: 1, t: 'subagent_stop', subagent_id: id });
    },

    closeTerminal(id) {
      const key = get().activeKey;
      if (key === null) return;
      const bucket = get().sessions[key];
      const row = bucket?.terminals.find((candidate) => candidate.id === id);
      if (!row) return;

      // Counter-intuitive but required: **a running shell cannot be closed, only
      // ended first.** The runtime refuses to forget a terminal whose process is
      // alive — a record that vanished while the shell kept going would be
      // something nobody can see and nobody can end — so the person's single
      // gesture is carried out in the two parts the rule actually allows. The
      // second half runs in the `terminal_exit` handler below, when the runtime
      // has confirmed the process is gone.
      //
      // The view switches at once rather than after the round trip, because
      // that is this window's own preference (`activeTerminalId`) and the
      // person's intent is not in doubt. **It switches to the next tab, not out
      // of the terminal** — see `nextTerminalId` for the bug that reading this
      // as "leave" turned out to be. `null` here means, and only means, that
      // there was nothing else open.
      const next = nextTerminalId(bucket.terminals, id);
      if (row.status === 'running') {
        patchWith(key, (current) => ({
          terminalClosing: current.terminalClosing.includes(id)
            ? current.terminalClosing
            : [...current.terminalClosing, id],
          terminalPending: current.terminalPending.includes(id)
            ? current.terminalPending
            : [...current.terminalPending, id],
          activeTerminalId: current.activeTerminalId === id ? next : current.activeTerminalId,
        }));
        sendTo(key, { v: 1, t: 'terminal_kill', terminal_id: id });
        return;
      }

      // Already ended, so there is no process to lose track of and the runtime
      // will accept this. **No optimistic removal**: the row and the tail go when
      // the runtime's list comes back without them, which keeps one place
      // (`ui(terminals)`) responsible for what this window still holds.
      patch(key, { activeTerminalId: bucket.activeTerminalId === id ? next : bucket.activeTerminalId });
      sendTo(key, { v: 1, t: 'terminal_close', terminal_id: id });
    },

    attachTerminal(id) {
      const key = get().activeKey;
      if (key === null) return;
      const bucket = get().sessions[key];
      // **Going back is recorded, because it is the one moment the fact matters.**
      // The shell keeps running after the person returns to the conversation, and
      // nothing else on screen says so: the terminal view is gone, the tab strip
      // is gone, and the composer looks exactly like it does with no shells at
      // all. `panel.term.detached` was written for this and had no reference
      // anywhere.
      //
      // Only for a **running** shell: leaving an ended one needs no sentence,
      // because the row in the panel still reports how it ended.
      const leaving = bucket?.activeTerminalId ?? null;
      const row = leaving === null ? undefined : bucket?.terminals.find((r) => r.id === leaving);
      patchWith(key, (current) => ({
        activeTerminalId: id,
        ...(id === null && row?.status === 'running'
          ? {
              entries: [
                ...current.entries,
                {
                  kind: 'note' as const,
                  id: nextId('note'),
                  tone: 'info' as const,
                  code: 'terminal',
                  text: '',
                  message: { code: 'terminalDetached' as const, id: row.id },
                },
              ],
            }
          : {}),
      }));
    },

    toggleTerminalView() {
      const key = get().activeKey;
      if (key === null) return;
      const bucket = get().sessions[key];
      if (!bucket) return;
      // Already reading a shell: this is the way back to the conversation. It
      // goes through `attachTerminal(null)` rather than patching the field, so
      // the "still running" note is written by the one place that writes it —
      // leaving a shell behind is exactly the moment that sentence is for.
      if (bucket.activeTerminalId !== null) {
        get().attachTerminal(null);
        return;
      }
      const id = nextTerminalId(bucket.terminals);
      // Nothing to attach to. The badge is disabled in this state, so reaching
      // here means the list changed between the render and the press — and
      // attaching to an id that no longer exists would draw the terminal view
      // over an empty list, which is a screen with no tab to leave by.
      if (id === null) return;
      get().attachTerminal(id);
    },
  };
}
