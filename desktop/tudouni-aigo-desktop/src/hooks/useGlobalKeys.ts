import { useEffect } from 'react';
import {
  activeRuntime,
  activeWorkspaceOf,
  selectPhase,
  selectSavedSessions,
  useApp,
} from '@/state/store';

/** The class the terminal pane carries. Named here so the guard below and the
 *  pane itself cannot disagree about what "the terminal" is. */
export const TERMINAL_PANE_CLASS = 'term-pane';

/**
 * Is the keyboard inside the terminal pane?
 *
 * A pure two-argument function rather than a `document` read, because this
 * decision is the one that used to be made wrongly and there is no way to see it
 * in a rendered string — "typing at a shell does something" is a fact about
 * focus, not about markup.
 *
 * `contains` covers the pane's own children, which matters the moment anything
 * inside it becomes focusable.
 */
export function focusIsInTerminal(active: Element | null, pane: Element | null): boolean {
  if (active === null || pane === null) return false;
  return active === pane || pane.contains(active);
}

/** The live answer, for the window handler. */
function keyboardIsAtAShell(): boolean {
  if (typeof document === 'undefined') return false;
  return focusIsInTerminal(
    document.activeElement,
    document.querySelector(`.${TERMINAL_PANE_CLASS}`),
  );
}

/**
 * Global keys (the capability list).
 *
 * Division of labour: a modal's own keys belong to the modal, a panel's keys to
 * the panel, and this handles only the global layer and the fall-through case.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Someone closer to the event already handled it. The composer does this
      // for Esc-while-running: without the check, one press sent `interrupt`
      // twice — once from the textarea's own handler and once from here, since
      // the event bubbles to `window`.
      if (e.defaultPrevented) return;

      const s = useApp.getState();
      const mod = e.ctrlKey || e.metaKey;

      /* ---- Reload keys: suppressed, and they must be suppressed *first* ----
       *
       * A reload of the WebView re-runs `attachRuntime({})`, and the bridge's
       * restart path kills the current child and starts a **new session** — the
       * `--session` flag is not carried over. One stray F5 therefore loses the
       * whole transcript and any turn in flight.
       *
       * This used to say the native layer did it. It did not: there is no menu,
       * no `initialization_script` and no key interception in `src-tauri`, so
       * nothing was intercepting anything. The mechanism below is the same one
       * `Ctrl+S` already relies on. A developer who wants a reload can use the
       * devtools' own button, which is not a key the app can swallow.
       *
       * **It comes before the terminal guard below, and that order is the whole
       * point.** `encodeKey({key:'F5'})` is `\x1b[15~` and `Ctrl+R` is `\x12`, so
       * both looked like keys "the pane would handle" and the guard returned
       * before this ever ran — reopening the exact hole this block exists to
       * close. A reload key has no meaning to a shell, so there is nothing to
       * concede. */
      if (e.key === 'F5' || (mod && !e.shiftKey && ['r', 'p', 'f'].includes(e.key.toLowerCase()))) {
        e.preventDefault();
        return;
      }

      /* ---- An attached terminal owns the keyboard, while it has focus ----
       *
       * While a shell has the keyboard, every key that has a terminal meaning
       * belongs to it — including `Ctrl+K`, `Ctrl+B`, `Ctrl+C` and Escape. The
       * pane itself handles this (it `preventDefault`s and stops propagation),
       * but that only covers the case where the pane has focus. Clicking the tab
       * strip or the status bar moves focus away, and the window handler would
       * then fold a rail or interrupt a turn **while somebody was
       * typing at a shell** — the one state where the interface must look like a
       * terminal and behave like one.
       *
       * **The test is focus, not "does this key encode to something".** That was
       * the old rule, and it was wrong in the direction that hurts: `encodeKey`
       * answers `''` for very few keys, so a plain letter, `Ctrl+C`, F5 and
       * everything else hit the guard and `return`ed — leaving the key to a pane
       * that had not been focused, and never calling `preventDefault`. The result
       * was a keyboard that did nothing at all until the black area was clicked
       * with a mouse. Asking where the focus actually is says what the guard
       * means: "the terminal is the thing receiving keys right now." */
      if (activeRuntime(s)?.activeTerminalId != null && keyboardIsAtAShell()) {
        // Not `preventDefault`: the pane is about to handle it, and cancelling
        // here would swallow the key before it gets there.
        return;
      }

      /* ---- Esc: modal > panel > interrupt the turn ---- */
      if (e.key === 'Escape') {
        // A modal handles its own Esc (it resolves to deny / skip).
        if (s.modal !== null) return;
        if (s.panel !== null) {
          e.preventDefault();
          useApp.setState({ panel: null });
          return;
        }
        // Esc interrupts **the session on screen** and nothing else. With
        // several running, "stop" has to mean the one being watched — stopping
        // a background conversation would be an act the person cannot see.
        if (selectPhase(s, s.activeKey) === 'running') {
          e.preventDefault();
          s.interrupt();
        }
        return;
      }

      /* ---- A blocking modal really blocks ----
       *
       * Only Esc was checked above, so Ctrl+K/B/S/T/` and Ctrl+1..9 all ran
       * straight through a fail-closed approval prompt: a person could open the
       * command palette *behind* the prompt, answer it, and watch a panel appear
       * that they had no memory of asking for. "Blocking" has to mean blocked. */
      if (s.modal !== null) return;

      /* ---- Ctrl/Cmd combinations ---- */
      if (mod && !e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 'k': {
            e.preventDefault();
            useApp.setState({ panel: s.panel === 'commands' ? null : 'commands' });
            return;
          }
          case 'b': {
            e.preventDefault();
            s.toggleSidebar();
            return;
          }
          case 'l': {
            // The left rail is its own switch: it answers "where am I working
            // and in which conversation", which is not the question Ctrl+B
            // folds. `Ctrl+L` is free — nothing else claims it.
            e.preventDefault();
            s.toggleLeftbar();
            return;
          }
          case 's': {
            e.preventDefault();
            useApp.setState({ panel: s.panel === 'skills' ? null : 'skills' });
            if (s.panel !== 'skills') s.requestSkills();
            return;
          }
          case 't': {
            // Fold or unfold reasoning: applies to the last reasoning block in
            // the stream.
            e.preventDefault();
            const last = [...(activeRuntime(s)?.entries ?? [])]
              .reverse()
              .find((x) => x.kind === 'reason');
            if (last) s.toggleReasoning(last.id);
            return;
          }
          case '\\': {
            e.preventDefault();
            s.toggleQuiet();
            return;
          }
          default:
            break;
        }

        /* ---- Ctrl+1..9: focus a session (a panel gets first refusal) ----

           Focusing rather than switching: with one process per conversation,
           what this changes is which transcript is drawn. It sends nothing, so
           it cannot disturb a turn that is running — in this session or in any
           other.

           **The list is the workspace's, not the focused child's.** Reading it
           per child made the numbering depend on which row was already selected
           — Ctrl+2 named a different conversation before and after a click,
           because the child that had the newest copy of the files answered
           differently. See `SavedSessions`. */
        if (/^[1-9]$/.test(e.key) && s.panel === null) {
          const item = selectSavedSessions(s, activeWorkspaceOf(s)).items[Number(e.key) - 1];
          if (item) {
            e.preventDefault();
            void s.openSession(item.id);
          }
        }
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
