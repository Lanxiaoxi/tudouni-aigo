import { useEffect } from 'react';
import { activeRuntime, selectPhase, useApp } from '@/state/store';

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
      const target = e.target as HTMLElement | null;
      const inField =
        !!target &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);

      /* ---- Reload keys: suppressed, and they must be suppressed here ----
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
       * devtools' own button, which is not a key the app can swallow. */
      if (e.key === 'F5' || (mod && !e.shiftKey && ['r', 'p', 'f'].includes(e.key.toLowerCase()))) {
        e.preventDefault();
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
          case 'c': {
            // Quit — but only when nothing is selected, so copy is not stolen.
            // One quit path for `Ctrl+C` and `/exit` (`store.quit` → the
            // bridge's shutdown), so a deliberate exit is never reported back
            // to the person as a crash.
            if (!inField && !window.getSelection()?.toString()) {
              e.preventDefault();
              void s.quit();
            }
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
           other. */
        if (/^[1-9]$/.test(e.key) && s.panel === null) {
          const item = (activeRuntime(s)?.sessionList ?? [])[Number(e.key) - 1];
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
