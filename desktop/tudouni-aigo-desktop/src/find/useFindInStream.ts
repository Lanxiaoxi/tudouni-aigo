import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useApp } from '@/state/store';
import type { Entry } from '@/state/entries';
import {
  clearPaint,
  findPaintSupported,
  jumpToHit,
  paintHits,
  scanTranscript,
  type FindHit,
} from './engine';

/**
 * The find bar's behaviour, in one place: scan the transcript, paint the hits,
 * jump to the current one, and count.
 *
 * ### Why the counting is here and not in the store
 *
 * "How many matches are there" has exactly one honest source — the hits this
 * window just built from the rows it just read — and the prototype is what showed
 * the tempting alternative to be a lie: `CSS.highlights.get(...).size` keeps
 * reporting ranges that draw nothing, because a commit that rewrites a text node
 * leaves the range empty rather than removing it. So the count lives beside the
 * hits that produced it, and the store holds only the request (`findQuery`,
 * `findIndex`).
 *
 * ### Why the jump is keyed on the request, not on the hits
 *
 * The transcript changes on every streamed chunk, and each pass repaints. If the
 * jump were part of that pass, the viewport would be dragged back to the current
 * hit several times a second while an answer streams — the reader could not look
 * anywhere else. So a jump happens only when what was **asked for** changed (the
 * needle, or which hit), and a repaint caused by new text never moves anything.
 */
export interface FindController {
  /** Whether the bar is up. The caller draws it, and unpins the transcript. */
  open: boolean;
  query: string;
  /** How many hits the last pass found. */
  count: number;
  /** Which one is current; may be past the end when the text under it changed. */
  index: number;
  /** How many times the keyboard has been asked for. Passed through to the bar,
   *  which keys its focus effect on it — see `findFocus` in the store. */
  focusToken: number;
  setQuery(q: string): void;
  next(): void;
  prev(): void;
  close(): void;
}

export function useFindInStream(
  scrollerRef: RefObject<HTMLDivElement | null>,
  entries: Entry[],
): FindController {
  const open = useApp((s) => s.findOpen);
  const query = useApp((s) => s.findQuery);
  const index = useApp((s) => s.findIndex);
  const focusToken = useApp((s) => s.findFocus);
  const setQuery = useApp((s) => s.setFindQuery);
  const setIndex = useApp((s) => s.setFindIndex);
  const close = useApp((s) => s.closeFind);

  const [count, setCount] = useState(0);
  /** The last pass's hits. A ref, because the jump must not depend on them —
   *  see the note above about streaming. */
  const hits = useRef<FindHit[]>([]);
  /** The last `query`+`index` a jump was made for, so that new text does not
   *  re-jump. Cleared when the bar closes, so reopening lands again. */
  const landed = useRef('');

  /**
   * The model, by id, as identity tokens for the engine's cache.
   *
   * Only the four searchable kinds are in here — that is the same allowlist as
   * `FIND_CONTENT_SELECTORS`, expressed from the model's side, and it keeps the
   * engine from walking 160 rows that cannot hold a hit.
   */
  const searchable = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const entry of entries) {
      if (
        entry.kind === 'user' ||
        entry.kind === 'stream' ||
        entry.kind === 'answer' ||
        entry.kind === 'reason'
      ) {
        map.set(entry.id, entry);
      }
    }
    return map;
  }, [entries]);

  useEffect(() => {
    if (!open) {
      // Both sets off the registry, and the memo of where the last jump landed
      // dropped, so a bar raised again over the same needle lands on its hit
      // rather than on whatever scroll position was left behind.
      clearPaint();
      hits.current = [];
      landed.current = '';
      setCount(0);
      return;
    }

    if (query === '' || !findPaintSupported()) {
      clearPaint();
      hits.current = [];
      setCount(0);
      return;
    }

    const scan = scanTranscript(searchable, query);
    hits.current = scan.hits;
    setCount(scan.hits.length);
    // Out of range is a real state, not a bug: the hit the reader was on can be
    // gone because the streamed body it lived in was replaced by the final
    // answer. Nothing is highlighted as current there, and the count says so.
    paintHits(scan.hits, index);

    const request = `${query}\u0000${index}`;
    if (landed.current === request) return;
    landed.current = request;
    const hit = scan.hits[index];
    const scroller = scrollerRef.current;
    if (hit !== undefined && scroller !== null) jumpToHit(hit, scroller);
  }, [open, query, index, searchable, scrollerRef]);

  const next = useCallback(() => {
    if (count === 0) return;
    setIndex((index + 1) % count);
  }, [count, index, setIndex]);

  const prev = useCallback(() => {
    if (count === 0) return;
    setIndex((index - 1 + count) % count);
  }, [count, index, setIndex]);

  return { open, query, count, index, focusToken, setQuery, next, prev, close };
}
