import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useT } from '@/i18n/useT';

/**
 * One session named by the board's Idle column, captured when the prompt was
 * raised.
 *
 * The **key** is what the act uses; the `id` is only what the sentence shows.
 * `id` is null while `init` has not landed — a conversation that is still
 * starting has no runtime id yet, and inventing one here would name a file that
 * does not exist. The prompt says "starting…" for that row instead.
 */
export interface IdleCloseTarget {
  key: string;
  id: string | null;
}

/**
 * The board's Idle column, closing everything in it.
 *
 * ## Why this is a dialog and not the two-press arm
 *
 * Every other destructive act on this board arms on the first press and acts on
 * the second (the card menu's delete, the rail row's delete). This one is
 * **bulk**, and that changes the arithmetic: an arm is one misread label away
 * from closing a dozen conversations, and a double click is enough to walk
 * through it. A dialog also has room for the two facts a person needs before
 * answering, and neither fits in a tooltip:
 *
 * - **which** conversations are about to end (the list below);
 * - that the conversations themselves are **not** lost — the runtime has already
 *   written them down, so they can be reopened from the library. What does not
 *   come back is what was never written down: a draft, pasted pictures, a shell
 *   still attached to the session.
 *
 * ## The set is a snapshot, and it is the board's own
 *
 * `targets` holds the rows the column showed when the prompt was raised, and
 * the answer acts on exactly those. Recomputing "which sessions are idle" at
 * confirm time would let a card that started running between the two clicks be
 * closed under a sentence that never named it — the one thing a confirmation
 * must not do.
 *
 * It is **component state rather than a store field** on purpose: this question
 * exists only while the board is open, it is about the board's own cards, and
 * nothing else in the window has any use for it. The store's contract is the
 * shared surface of the app; a prompt nobody else can see does not belong on it.
 *
 * ## Dismissal is a real answer
 *
 * Esc and a click outside both cancel, the same rule `CloseConfirm` keeps: a
 * prompt with no way out turns one stray click into a forced choice.
 */
export function IdleCloseConfirm({
  targets,
  onCancel,
  onConfirm,
}: {
  /** The rows to close, or null when no prompt is up. */
  targets: IdleCloseTarget[] | null;
  onCancel: () => void;
  onConfirm: (targets: IdleCloseTarget[]) => void;
}) {
  const t = useT();

  const open = targets !== null;
  const count = targets?.length ?? 0;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-mask" />
        <DialogPrimitive.Content className="dialog">
          <div className="dialog-head">
            <div className="grow">
              <DialogPrimitive.Title className="dialog-title">
                {t('board.idleClose.title', { n: count })}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="dialog-desc">
                {t('board.idleClose.subtitle')}
              </DialogPrimitive.Description>
            </div>
          </div>

          <div className="dialog-body scroll-fade">
            {/* The conversations themselves, by the runtime's own name. A row
                still waiting for `init` has no id yet, and says so rather than
                inventing one — the same word the rail's live rows use. */}
            <ul className="idle-close-list">
              {(targets ?? []).map((target) => (
                <li key={target.key} className="idle-close-item mono">
                  {target.id !== null ? target.id : t('lb.sessionPending')}
                </li>
              ))}
            </ul>
            <p className="idle-close-warn">{t('board.idleClose.warn')}</p>
          </div>

          <div className="dialog-foot">
            <span className="grow" />
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              {t('common.cancel')}
              <kbd className="kbd" style={{ marginLeft: 4 }}>
                Esc
              </kbd>
            </button>
            <button
              type="button"
              className="btn btn-destructive"
              onClick={() => onConfirm(targets ?? [])}
            >
              <X size={13} />
              {t('board.idleClose.confirm')}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
