import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Inlines scripts/diagram.mjs's generated SVG directly into the page DOM
 * (not an <img src>) so its real <title>/<desc> are part of the accessibility
 * tree — DESIGN-DIRECTION.md: "Diagrams carry a real <title>/<desc>, not
 * aria-label='image'." An <img> can only expose an `alt` string; a screen
 * reader never sees an SVG's own title/desc when it's referenced as an image
 * source instead of inlined markup.
 *
 * Reads the file at render time (this is a Server Component, so Node's fs is
 * available) rather than importing it, because there is no SVG-as-string
 * loader configured — the same "generated once, rendered from disk" shape
 * chaos-table.tsx uses for chaos/results/latest.json.
 */
export function DiagramFigure() {
  const svg = readFileSync(join(process.cwd(), "public", "diagram", "states.svg"), "utf8");
  return (
    <div
      className="raised border border-edge-lo [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
      // Trusted, build-time-only content: scripts/diagram.mjs's own
      // deterministic output, never user input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
