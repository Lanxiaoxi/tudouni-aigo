/**
 * The application's own mark.
 *
 * This is **not** the runtime's or anybody else's branding: it is the same
 * drawing `scripts/make-icons.mjs` renders into `src-tauri/icons`, described
 * once here as SVG so the window and the icon cannot drift apart. The shapes are
 * the generator's, in a 0..1 square scaled to a 24-unit viewBox:
 *
 *   - a rounded square (corner radius 0.22) in the accent colour;
 *   - a prompt glyph in the on-accent colour: a chevron at 0.28/0.50/0.70 and an
 *     underscore from 0.58 to 0.78, stroked at 0.085.
 *
 * Colours come from the tokens, so the mark follows the theme. `--fg-on-accent`
 * is a real colour in both themes (never the `clearRoles` sentinel), which is
 * what makes it safe to place on top of `--accent` — the pairing is the same one
 * `.btn-primary` and `.welcome-id .wi-mark` use.
 */
export function Logo({ size = 20, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect x="0" y="0" width="24" height="24" rx="5.28" fill="var(--accent)" />
      <path
        d="M6.72 7.2 L12 12 L6.72 16.8"
        fill="none"
        stroke="var(--fg-on-accent)"
        strokeWidth="2.04"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.92 17.28 L18.72 17.28"
        fill="none"
        stroke="var(--fg-on-accent)"
        strokeWidth="2.04"
        strokeLinecap="round"
      />
    </svg>
  );
}
