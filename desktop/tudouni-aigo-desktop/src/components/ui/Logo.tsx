/**
 * The application's own mark.
 *
 * This is **not** the runtime's or anybody else's branding: it is the rabbit
 * icon, drawn from the very file the packaged application wears — the one
 * `tauri.conf.json` bundles out of `src-tauri/icons/`. There is one drawing, so
 * the window and the task-bar icon cannot drift apart.
 *
 * That is a correction, not a preference. This component used to draw its own
 * mark: a rounded square in `--accent` with a terminal prompt glyph, the same
 * shapes `scripts/make-icons.mjs` rendered into `src-tauri/icons`. That
 * generator was then replaced by the hand-drawn rabbit (commit `7f1ee30`), and
 * the in-window marks were left behind — so every icon the person actually saw
 * (task bar, installer, Explorer) was the rabbit while the three marks *inside*
 * the window were still green squares. The old comment claimed the two "cannot
 * drift apart" because both were described here; two descriptions of one mark is
 * exactly how they drifted. Importing the file is the only version of that
 * promise that can be kept.
 *
 * Two consequences of using the icon file rather than an SVG, both deliberate:
 *
 *   - `128x128.png` is the size that fits the window. The mark is 30px at its
 *     largest (the first screen), which 128px covers even on a 2x display, and it
 *     is 9KB where the 512px master is 78KB;
 *   - the corners are clipped by `.app-mark` (components.css). The file is a
 *     rounded square drawn on an opaque black page, so its corner pixels are
 *     solid black — unclipped, the mark reads as a black box on the light theme.
 *     The clip radius there is measured against this file, not guessed.
 */
import markUrl from '../../../src-tauri/icons/128x128.png';

export function Logo({
  size = 20,
  title,
  dragRegion = false,
}: {
  size?: number;
  /** Omitted means decorative: the name is already in the text beside it. */
  title?: string;
  /**
   * Whether the title bar hands this element the drag gesture.
   *
   * Tauri's `drag.js` reads `data-tauri-drag-region` off the **event target**, so
   * an element inside the bar needs its own attribute or dragging from it does
   * nothing — which is why the bar's title and this mark each carry one while the
   * window controls beside them deliberately do not.
   */
  dragRegion?: boolean;
}) {
  return (
    <img
      className="app-mark"
      src={markUrl}
      width={size}
      height={size}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      // The browser's own image drag would swallow a title-bar drag: it starts a
      // native drag-and-drop of the picture and the window never moves.
      draggable={false}
      data-tauri-drag-region={dragRegion ? '' : undefined}
    />
  );
}
