import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/useT';

/**
 * The in-place note box for an annotated selection.
 *
 * Opened by the selection menu's "Annotate" under the selected passage. Enter
 * (or the confirm button) hands the note back; Shift+Enter is a newline, the
 * composer's own rule, so the two inputs do not teach opposite keys. Escape or
 * a click outside cancels. An empty note cannot be confirmed: a chip that
 * carries a quote and nothing else is "add to input", which already exists.
 */
export function AnnotatePopover(props: {
  quote: string;
  left: number;
  top: number;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const { quote, left, top, onConfirm, onCancel } = props;
  const t = useT();
  const [note, setNote] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Where it is drawn, after it has been measured: kept inside the window, and
  // flipped above the anchor when there is no room under it.
  const [place, setPlace] = useState<{ left: number; top: number }>({ left, top: top + 6 });

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const { width, height } = box.getBoundingClientRect();
    const margin = 8;
    let y = top + 6;
    if (y + height > window.innerHeight - margin) y = Math.max(margin, top - height - 30);
    const x = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    setPlace({ left: x, top: y });
  }, [left, top]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    // Capture phase, like the selection menu's Escape: the stream's own keys
    // must not see an Escape that was meant for this box.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const blank = note.trim() === '';
  const confirm = () => {
    if (!blank) onConfirm(note);
  };

  return (
    <div
      className="stream-menu-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div
        ref={boxRef}
        className="annotate-pop"
        role="dialog"
        aria-label={t('stream.annotate.title')}
        style={{ left: place.left, top: place.top }}
      >
        <blockquote className="annotate-pop-quote" title={quote}>
          {quote}
        </blockquote>
        <textarea
          ref={inputRef}
          className="annotate-pop-input"
          rows={2}
          value={note}
          placeholder={t('stream.annotate.placeholder')}
          aria-label={t('stream.annotate.placeholder')}
          onChange={(e) => setNote(e.currentTarget.value)}
          onKeyDown={(e) => {
            // An IME composition's Enter picks a candidate; it is not a confirm.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              confirm();
            }
          }}
        />
        <div className="annotate-pop-actions">
          <span className="annotate-pop-hint">{t('stream.annotate.hint')}</span>
          <button type="button" className="annotate-pop-btn" onClick={onCancel}>
            {t('stream.annotate.cancel')}
          </button>
          <button
            type="button"
            className="annotate-pop-btn is-primary"
            disabled={blank}
            onClick={confirm}
          >
            {t('stream.annotate.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
