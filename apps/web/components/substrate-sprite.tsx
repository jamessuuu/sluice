import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The 14-glyph substrate sprite (PORTFOLIO-DESIGN-DNA.md §3.6), inlined once per
 * document.
 *
 * It has to be INLINED, not referenced. `<use href="/substrate/sprite.svg#icon-x">`
 * renders an empty box in Chromium: `currentColor` inside an external SVG document
 * does not resolve against the referencing page's inherited colour, so the stroke is
 * invisible. That is the substrate package's own recorded footgun (GLYPHS.md, and
 * sprite.svg's header comment) — verified there, not assumed from a spec reading.
 *
 * Read from public/substrate/ at build time (Server Component, static route), the
 * same "generated once, rendered from disk" shape diagram-figure.tsx uses. The file
 * on disk stays byte-identical to the canonical package, which is what gate G11
 * hashes; nothing here rewrites it.
 */
export function SubstrateSprite() {
  const svg = readFileSync(join(process.cwd(), "public", "substrate", "sprite.svg"), "utf8");
  return <span hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * One glyph. The outer <svg> carries its own viewBox AND explicit width/height:
 * without those two attributes Chromium lays the element out at 0x0 even when CSS
 * gives it a size (also GLYPHS.md, also verified rather than assumed).
 */
export function Icon({
  name,
  size = 20,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#icon-${name}`} />
    </svg>
  );
}
