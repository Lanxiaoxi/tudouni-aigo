import { useApp } from '@/state/store';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Whether streamed text may be paced right now — one answer, asked in every
 * place that draws one.
 *
 * Three separate vetoes, and they belong together because they are the same
 * question ("may this text be held back for a moment?") asked by three
 * different parties:
 *
 *   - **the person** — the settings switch, which is the whole feature;
 *   - **the operating system** — `prefers-reduced-motion`, whose stylesheet
 *     counterpart already zeroes every animation in this window
 *     (`global.css`), so honouring it here is the same promise kept by the one
 *     means the stylesheet cannot reach;
 *   - **the find bar** — a search reads the DOM, and text the cursor has not
 *     reached is text that is not there. Holding it back during a search is how
 *     a hit the person can see in the stream goes uncounted.
 *
 * The find veto is not "reduced" smoothing, it is **off**: a partly-revealed
 * answer cannot be searched in the part that has not arrived, and a search that
 * silently misses the last paragraph is worse than a jumpy one. `StreamView`
 * already unpins the follow when the bar opens for the same family of reasons;
 * this is the text half of that decision.
 *
 * Kept as a hook rather than passed down as a prop because the three consumers
 * (`EntryView`'s stream and reasoning rows, and any future one) sit at
 * different depths, and threading a boolean through the block partition would
 * put a reading preference into a function that exists to group rows.
 */
export function useStreamPacing(): boolean {
  const enabled = useApp((s) => s.streamSmoothing);
  const finding = useApp((s) => s.findOpen);
  const reducedMotion = usePrefersReducedMotion();
  return enabled && !finding && !reducedMotion;
}
