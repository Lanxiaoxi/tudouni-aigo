import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * The rail's "you are here" capsule, as **one element that moves** rather than
 * a background each row owns.
 *
 * When every row painted its own green background, switching rows could only
 * fade one out and another in: two unrelated elements, nothing to slide. This
 * hook keeps a single absolutely-positioned capsule inside a container and
 * moves it to whichever row carries `is-current`. The rows keep the class (it
 * still drives their text and icon colour, and `disabled`), they just stop
 * painting the background.
 *
 * **When it slides and when it does not.** The slide is for one thing: the
 * current row *changing*. Everything else snaps, because a capsule that trails
 * behind its own row reads as lag, not as motion:
 *
 *   - the same row moving because the list above it grew or shrank → snap;
 *   - the first measurement, or a list that had no current row → snap into
 *     place and fade in, never slide in from wherever it was last;
 *   - `scope` changing (another workspace: the whole list is a different set of
 *     rows, so "from the old row to the new one" means nothing) → snap.
 *
 * Reduced motion needs nothing here: `global.css` zeroes every transition under
 * `prefers-reduced-motion`, and this capsule's motion is all transitions.
 */
const TARGET = '.lb-row.is-current, .lb-session.is-current';

interface Memory {
  target: Element | null;
  scope: string | null;
  shown: boolean;
  box: string;
}

export interface SlidingHighlight {
  /** Goes on the element the capsule lives in (`.lb-slide`). */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Goes on the capsule itself (`.lb-slide-hl`), anywhere inside the container. */
  highlightRef: RefObject<HTMLDivElement | null>;
}

export function useSlidingHighlight(scope: string): SlidingHighlight {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef(scope);
  const memory = useRef<Memory>({ target: null, scope: null, shown: false, box: '' });

  // Stable across renders: it only reads refs.
  const place = useRef(() => {
    const container = containerRef.current;
    const hl = highlightRef.current;
    if (container === null || hl === null) return;
    const mem = memory.current;
    const scopeNow = scopeRef.current;

    const target = container.querySelector(TARGET);
    if (target === null) {
      if (mem.shown) {
        hl.style.opacity = '0';
        mem.shown = false;
      }
      mem.target = null;
      mem.scope = scopeNow;
      return;
    }

    const c = container.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    // A collapsed or hidden section measures zero; keep the last placement
    // rather than parking the capsule at 0×0 and sliding out of it later.
    if (r.width === 0 || r.height === 0) return;

    const x = r.left - c.left;
    const y = r.top - c.top;
    const box = `${x.toFixed(2)}|${y.toFixed(2)}|${r.width.toFixed(2)}|${r.height.toFixed(2)}`;
    const targetChanged = mem.target !== target;
    if (!targetChanged && mem.shown && box === mem.box && mem.scope === scopeNow) return;

    const animate = mem.shown && targetChanged && mem.scope === scopeNow;
    if (!animate) hl.style.transition = 'none';
    hl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    hl.style.width = `${r.width}px`;
    hl.style.height = `${r.height}px`;
    if (targetChanged) hl.style.borderRadius = getComputedStyle(target).borderTopLeftRadius;
    if (!animate) {
      // Flush the un-animated placement before the transition comes back, or
      // the browser folds the two writes together and slides anyway.
      void hl.offsetWidth;
      hl.style.transition = '';
    }
    if (!mem.shown) {
      hl.style.opacity = '1';
      mem.shown = true;
    }

    mem.target = target;
    mem.scope = scopeNow;
    mem.box = box;
  }).current;

  // Every render: the current row is decided by props the rail reads from the
  // store, and a row appearing above it moves it without any resize event.
  useLayoutEffect(() => {
    scopeRef.current = scope;
    place();
  });

  // The rail's width and the list's height change without a render here.
  //
  // Observed from the every-render effect rather than a mount-only one: the
  // workspace list is only in the tree once something is listed, so its
  // container can arrive (and leave) long after this hook mounted. A new
  // container also means the old measurements describe a different element, so
  // the memory is dropped and the capsule snaps instead of sliding from a place
  // that no longer exists.
  const observed = useRef<{ el: HTMLDivElement | null; observer: ResizeObserver | null }>({
    el: null,
    observer: null,
  });
  useLayoutEffect(() => {
    const container = containerRef.current;
    const watch = observed.current;
    if (watch.el === container) return;
    watch.observer?.disconnect();
    watch.observer = null;
    watch.el = container;
    memory.current = { target: null, scope: null, shown: false, box: '' };
    if (container === null || typeof ResizeObserver === 'undefined') return;
    watch.observer = new ResizeObserver(() => place());
    watch.observer.observe(container);
  });
  useLayoutEffect(
    () => () => {
      observed.current.observer?.disconnect();
      observed.current = { el: null, observer: null };
    },
    [],
  );

  return { containerRef, highlightRef };
}
