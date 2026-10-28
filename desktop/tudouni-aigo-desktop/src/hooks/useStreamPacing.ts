import { useApp } from '@/state/store';
import {
  clampBaseCps,
  clampMaxCps,
  REVEAL_BASE_CPS,
  REVEAL_MAX_CPS,
  type RevealLimits,
} from '@/streamReveal';

/** The ends a person can choose: the engine's constructor takes a partial and
 *  lets the untouched fields run at the curve's own defaults. */
type ChosenPaces = Partial<Pick<RevealLimits, 'baseCps' | 'maxCps'>>;
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * The answer every place that draws paced text needs, in one place.
 *
 * Three separate vetoes decide `enabled`, and they belong together because they
 * are the same question ("may this text be held back for a moment?") asked by
 * three different parties:
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
 * `limits` is the person's chosen ends of the pacing curve, clamped to the
 * curve's own ranges as a belt over the store's setter (which clamps too).
 * **It takes effect when the paced row starts**, not mid-row: the engine of a
 * mounted row keeps the limits it was constructed with, and a row is mounted by
 * its first delta, so a value changed in the settings panel reaches the next
 * reply. A speed change under a sentence that is on screen would be the kind
 * of jump the pacing exists to prevent.
 *
 * Kept as a hook rather than passed down as a prop because the three consumers
 * (`EntryView`'s stream and reasoning rows, and any future one) sit at
 * different depths, and threading the values through the block partition would
 * put a reading preference into a function that exists to group rows.
 */
export interface StreamPacing {
  /** Whether to pace at all. False is the honest "show it now". */
  readonly enabled: boolean;
  /** The ends of the pacing curve, in characters/second, ready for an engine. */
  readonly limits: ChosenPaces;
}

const PACING_IDLE: StreamPacing = {
  enabled: false,
  limits: { baseCps: REVEAL_BASE_CPS, maxCps: REVEAL_MAX_CPS },
};

export function useStreamPacing(): StreamPacing {
  const enabled = useApp((s) => s.streamSmoothing);
  const finding = useApp((s) => s.findOpen);
  const baseCps = useApp((s) => s.streamBaseCps);
  const maxCps = useApp((s) => s.streamMaxCps);
  const reducedMotion = usePrefersReducedMotion();
  const may = enabled && !finding && !reducedMotion;
  if (!may && baseCps === REVEAL_BASE_CPS && maxCps === REVEAL_MAX_CPS) {
    // Nothing to read and nothing chosen: one shared object keeps the
    // selectors' identity rule — a fresh literal here would re-render every
    // consumer on every store change while the answer could not change.
    return PACING_IDLE;
  }
  const base = clampBaseCps(baseCps);
  return {
    enabled: may,
    limits: { baseCps: base, maxCps: clampMaxCps(maxCps, base) },
  };
}
