import { memo, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useT } from '@/i18n/useT';

/**
 * The transcript's find bar (`Ctrl+F`).
 *
 * A **row of its own above the transcript**, not a floating panel over it. The
 * stream area is the one surface in this window that must never have anything
 * laid on top of it — the turn rail is a reserved lane rather than an overlay for
 * the same reason (`TurnRail.tsx`, and the 10px overlap `stream.css` measured) —
 * so the bar takes its own line and the transcript below it is 32px shorter. A
 * floating box would cover the answer the reader is scanning for a hit in.
 *
 * It is drawn by `StreamView`, which is also what runs the scan: the count and
 * the current hit come from the same pass, so there is no second copy of "how
 * many matches" to fall out of step with what is marked.
 */
export interface FindBarProps {
  query: string;
  count: number;
  /** Which hit is current, 0-based. May be past the end when the text under the
   *  reader changed — see the note on the count below. */
  index: number;
  /**
   * How many times the keyboard has been asked for, from the store.
   *
   * The effect below is keyed on this rather than on mount alone, because the bar
   * is already up when `Ctrl+F` is pressed a second time: the reader clicked into
   * the transcript and wants the box back, and the mount effect has already run.
   * It also covers the first open, since mounting runs the effect too.
   */
  focusToken: number;
  onQuery(q: string): void;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
}

export const FindBar = memo(function FindBar({
  query,
  count,
  index,
  focusToken,
  onQuery,
  onNext,
  onPrev,
  onClose,
}: FindBarProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Whether an IME is mid-composition.
   *
   * Committing every intermediate keystroke of a composition would search for
   * fragments the reader never typed — and with a Chinese or Japanese input the
   * box is *only* ever filled that way, so this is not an edge case, it is the
   * normal path in the languages this app is used in. The value is taken on
   * `compositionend`; `onChange` is ignored until then.
   */
  const composing = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.focus();
    // Select what is there, so a second `Ctrl+F` and typing replaces the needle
    // instead of appending to it — what every find box does.
    el.select();
  }, [focusToken]);

  // `0 of 12` is a real state rather than a formatting accident: the hit the
  // reader was on can be gone because the streamed body it lived in was replaced
  // by the final answer. Saying `12 of 12` there would point at a hit nobody is
  // looking at.
  const current = index >= count ? 0 : index + 1;
  const status = query === '' ? '' : count === 0 ? t('find.none') : t('find.count', { n: current, total: count });

  return (
    <div className="find-bar" role="search" aria-label={t('find.label')}>
      <Search size={13} className="muted" aria-hidden />
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        value={query}
        spellCheck={false}
        autoComplete="off"
        placeholder={t('find.placeholder')}
        aria-label={t('find.label')}
        onChange={(e) => {
          if (composing.current) return;
          if (e.target.value !== query) onQuery(e.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          if (e.currentTarget.value !== query) onQuery(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Cancelled so the window handler does not also see it: `Esc` here
            // means "close the search", and one press must not close two things.
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
      />

      {/* Announced rather than silently changing: with the box focused there is
          nothing else on screen that says how many hits there are. */}
      <span className="find-count" aria-live="polite">
        {status}
      </span>

      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={onPrev}
        disabled={count === 0}
        aria-label={t('find.prev')}
        title={t('find.prev')}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={onNext}
        disabled={count === 0}
        aria-label={t('find.next')}
        title={t('find.next')}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={onClose}
        aria-label={t('find.close')}
        title={t('find.close')}
      >
        <X size={14} />
      </button>
    </div>
  );
});
