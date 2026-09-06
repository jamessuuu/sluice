/**
 * sluice's own mark (identity.json `glyph: "sluice-gate"`), inline so it themes.
 *
 * Same construction as public/brand/glyph.svg — a raised weir gate across a channel,
 * drawn on scripts/brand.mjs's 64-unit grid — with the two baked hex values swapped
 * for `currentColor` and `var(--signal)`. That is the only change: DNA §3.7 keeps the
 * form, and DNA §3.2 forbids a project authoring its own colour. The raster/file version
 * stays the favicon and the OG image, where a CSS variable cannot reach.
 *
 * Exactly one signal-coloured element (DNA §3.7): the gate block that is through.
 */
export function ProjectGlyph({
  size = 44,
  className,
  decorative = false,
}: {
  size?: number;
  className?: string;
  /** Set when the mark sits next to the wordmark in text — one accessible name per
   * link, not two. */
  decorative?: boolean;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : "sluice"}
      fill="none"
      stroke="currentColor"
    >
      <path d="M8 14 V50" strokeWidth="3.008" />
      <path d="M56 14 V50" strokeWidth="3.008" />
      <path d="M8 50 H56" strokeWidth="3.008" />
      <path d="M24 10 V26" strokeWidth="1.984" />
      <path d="M40 10 V26" strokeWidth="1.984" />
      <rect x="24" y="18" width="16" height="8" strokeWidth="3.008" />
      <rect x="44" y="40" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="34" y="40" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="14" y="40" width="6" height="6" fill="var(--signal)" stroke="none" />
    </svg>
  );
}
