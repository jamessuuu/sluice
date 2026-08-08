// SPEC §9 branding: "OG image generated at build time (deterministic), not
// hand-exported." scripts/brand.mjs already committed the deterministic
// source (public/brand/og.svg, house palette, dot-matrix type, chip mark);
// this script's only job is to rasterize that same SVG to PNG at build time
// via sharp — no design decisions live here, so a brand-asset regeneration
// (`pnpm brand`) is the only thing that ever changes og.png's pixels.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const ROOT = resolve(import.meta.dirname, "..");
const SVG = resolve(ROOT, "public", "brand", "og.svg");
const OUT = resolve(ROOT, "public", "og.png");

async function main() {
  const svg = readFileSync(SVG);
  const png = await sharp(svg, { density: 144 }).resize(1200, 630).png().toBuffer();
  writeFileSync(OUT, png);
  console.log(`generate-og: ${SVG} -> ${OUT} (${String(png.length)} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
