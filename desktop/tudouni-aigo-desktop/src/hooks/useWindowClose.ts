import { useEffect } from 'react';
import { useApp } from '@/state/store';
import {
  acknowledgeClosePrompt,
  answerClosePrompt,
  onCloseRequested,
  type CloseChoice,
} from '@/runtime/tauri';
import { needsPrompt, readClosePolicy } from '@/runtime/windowClose';

/**
 * The window's X button, now that it means two things.
 *
 * Rust owns the event and the deadline (`CloseRequested`, `CLOSE_PROMPT_TIMEOUT`
 * in `lib.rs`); this owns the question, and the split is deliberate. Rust always
 * asks, because it does not know what the person decided last time — preferences
 * live in this front end (`aigo.prefs`), which is the same division every other
 * preference already follows. So the flow is:
 *
 *   1. `CloseRequested` → Rust refuses the close and emits
 *      `window://close-requested`;
 *   2. this hook reads the remembered policy:
 *      - `minimize` / `close` → answered immediately, no dialog at all. That is
 *        what "remember my choice" bought, and a remembered choice that still
 *        asks would be a checkbox that does nothing.
 *      - `ask` → `acknowledgeClosePrompt()` and the dialog is raised.
 *   3. the dialog's answer goes back through `answerClosePrompt`, which is the
 *      only path that closes the window from here.
 *
 * **The acknowledgement is the load-bearing half, and it is why (2b) calls it
 * before raising anything.** Rust's deadline covers a front end that never drew
 * the dialog — a wedged renderer — and it must not become a deadline on the
 * person: the prompt offers to remember a choice, so reading it before answering
 * is the expected behaviour, not an edge case. Acking is what says "the dialog is
 * coming", and from then on the wait is the person's and has no deadline.
 *
 * **A remembered choice is answered on the spot rather than synthesized to the
 * dialog.** There is no dialog to draw; going through one would either flash a
 * prompt nobody needs to read or make the remembered path depend on a render.
 */
export function useWindowClose(): void {
  const setClosePrompt = useApp((s) => s.setClosePrompt);

  useEffect(() => {
    return onCloseRequested(() => {
      const policy = readClosePolicy(useApp.getState().closePolicy);
      // A remembered choice. Applied directly, and the dialog is never raised —
      // which is the entire difference remembering makes.
      if (!needsPrompt(policy)) {
        void answerClosePrompt(policy);
        return;
      }
      // The question is about to be drawn. Say so first, so the round-trip
      // deadline is disarmed before it can expire behind a slow first paint.
      void acknowledgeClosePrompt();
      setClosePrompt(true);
    });
  }, [setClosePrompt]);
}

/**
 * Answer the prompt on screen.
 *
 * `remember` is passed in rather than read here because it belongs to the
 * dialog, which owns the checkbox; the store write is done by the caller before
 * this runs, so the answer that is sent and the preference that is kept are
 * decided from the same reading of the control. Splitting them would let a
 * person check the box and still be asked next time.
 *
 * The order matters: **the choice is sent first and the dialog dismissed
 * second.** Dismissing first would take the prompt off screen while the window
 * was still open and nothing had been decided — a frame in which the interface
 * shows no question and no action, which reads as a press that did nothing.
 */
export async function resolveClosePrompt(choice: CloseChoice): Promise<void> {
  await answerClosePrompt(choice);
  useApp.getState().setClosePrompt(false);
}
