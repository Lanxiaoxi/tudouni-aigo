import { useEffect, useState } from 'react';

/**
 * Does the stylesheet hide the sidebar at this width?
 *
 * `global.css` hides `.app-sidebar` below 1024px, which is the window's own
 * minimum width (`tauri.conf.json` sets `minWidth: 960`) — so the range where
 * this bites is reachable by simply resizing.
 *
 * This has to be asked of the **stylesheet's own rule**, in CSS pixels, rather
 * than inferred from JS state: the two disagreed, and the disagreement was a
 * blank screen. `sidebarVisible` stayed `true` while the CSS hid the sidebar, so
 * `Sidebar` was mounted-but-invisible *and* `CollapsedSummary` was not rendered
 * either — the summary row is drawn only when `sidebarVisible` is false. Both
 * were hidden at once.
 */
const SIDEBAR_BREAKPOINT = '(max-width: 1024px)';

export function useSidebarHiddenByCss(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(SIDEBAR_BREAKPOINT).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SIDEBAR_BREAKPOINT);
    const onChange = (e: MediaQueryListEvent) => setHidden(e.matches);
    setHidden(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return hidden;
}
