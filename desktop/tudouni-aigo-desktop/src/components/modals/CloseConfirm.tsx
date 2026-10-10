import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Minus, X } from 'lucide-react';
import { useApp } from '@/state/store';
import { useT } from '@/i18n/useT';
import { resolveClosePrompt } from '@/hooks/useWindowClose';
import type { CloseChoice } from '@/runtime/tauri';

/**
 * The minimize-or-close prompt, raised by the window's X button.
 *
 * Two outcomes, and they are genuinely different: **minimize** hides the window
 * and leaves every session running (a turn in flight is not interrupted), while
 * **close** asks every child to finish and exits. Before the fact they look
 * identical; after it they are a lost turn and an application still in the tray.
 * So the application asks, once — and offers to remember the answer so that the
 * second time is not a question.
 *
 * ## Where the shapes come from
 *
 * It is a plain `DialogPrimitive` with the same chrome as every other dialog in
 * this application (`overlay-mask`, `dialog-head`, `dialog-body`,
 * `dialog-foot`), because it *is* one: a local question that must be answered
 * before anything else can happen in the window.
 *
 * It is deliberately **not** one of the two blocking modals in `modal/`. Those
 * exist for requests *the runtime* is waiting on, are queued, and follow
 * fail-closed rules — an approval with no timeout because the runtime waits on
 * the id forever. Nothing is waiting on this one: it is a question this window
 * asks itself, and putting it in that queue would make a local decision compete
 * with an approval for which one is answerable.
 *
 * ## Dismissal is a real answer
 *
 * Esc and a click outside both resolve to `cancel`: the window stays up and the
 * close request is over. That is not an oversight about "accidental dismissal
 * being unsafe" — the opposite case is the one that hurts. A prompt with no way
 * out turns one stray click on the frame into a forced choice between hiding the
 * window and ending every session, and both of those do something the person did
 * not ask for.
 *
 * ## Remembering
 *
 * The checkbox is **not** pre-checked and starts unchecked on every raise: a
 * preference that was set by a click nobody remembers making is a preference
 * that surprises people later. It applies to whichever choice is pressed, and it
 * is written to the store before the answer is sent, so the preference kept and
 * the action taken cannot disagree.
 */
export function CloseConfirm() {
  const t = useT();
  const open = useApp((s) => s.closePrompt);
  const sessionCount = useApp((s) => s.order.length);
  const setClosePolicy = useApp((s) => s.setClosePolicy);
  const [remember, setRemember] = useState(false);

  function answer(choice: Exclude<CloseChoice, 'cancel'>) {
    // Recorded first, and unconditionally when the box is ticked: the answer
    // that follows closes or hides the window, and a store write queued behind
    // it would race a window that is going away.
    if (remember) setClosePolicy(choice);
    setRemember(false);
    void resolveClosePrompt(choice);
  }

  function dismiss() {
    // Nothing is remembered from a dismissal. "I did not mean to press X" is not
    // a statement about what X should do next time.
    setRemember(false);
    void resolveClosePrompt('cancel');
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Esc and a click outside arrive here, and both mean the same thing:
        // the person is not answering. Resolving to `cancel` is what tells Rust
        // the request is over — without it the bridge would keep believing a
        // prompt is up and refuse the next press of X entirely.
        if (!next) dismiss();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {t('close.title')}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('close.subtitle')}
              </DialogPrimitive.Description>
            </div>
            {/* What "close" would actually end. With several conversations open
                this is the fact that decides the answer, and it is a count this
                front end owns (`order`) rather than one derived from the
                runtime. */}
            <span className="caption muted">{t('close.sessions', { n: sessionCount })}</span>
          </div>

          <div className="dialog-body scroll">
            <div className="close-choices">
              <button
                type="button"
                className="close-choice"
                onClick={() => answer('minimize')}
              >
                <span className="close-choice-icon" aria-hidden>
                  <Minus size={15} />
                </span>
                <span className="close-choice-main">
                  <span className="strong">{t('close.minimize')}</span>
                  <span className="caption muted">{t('close.minimizeHint')}</span>
                </span>
              </button>

              <button
                type="button"
                className="close-choice close-choice-danger"
                onClick={() => answer('close')}
              >
                <span className="close-choice-icon" aria-hidden>
                  <X size={15} />
                </span>
                <span className="close-choice-main">
                  <span className="strong">{t('close.close')}</span>
                  <span className="caption muted">{t('close.closeHint')}</span>
                </span>
              </button>
            </div>

            {/* The choice applies to whichever button is pressed, so it sits
                between them and the way out rather than beside one of them. */}
            <label className="close-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span className="close-remember-text">
                <span>{t('close.remember')}</span>
                <span className="caption muted">{t('close.rememberHint')}</span>
              </span>
            </label>
          </div>

          <div className="dialog-foot">
            <span className="grow" />
            <button type="button" className="btn btn-outline" onClick={dismiss}>
              {t('common.cancel')}
              <kbd className="kbd" style={{ marginLeft: 4 }}>
                Esc
              </kbd>
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
