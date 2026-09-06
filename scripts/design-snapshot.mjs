/**
 * Assembles apps/web/out/ — a flat, servable snapshot of the prerendered landing page
 * plus the stylesheets it actually links — so the substrate verifier can resolve them.
 *
 * Why this exists: substrate-kit's verify.mjs gate G2 reads the built HTML and follows
 * its <link rel="stylesheet"> hrefs *relative to the HTML file's own directory*. Next's
 * prerendered HTML lives at .next/server/app/index.html while its CSS lives at
 * .next/static/chunks/, and public/ is never copied into .next at all, so from that
 * file's directory neither `/_next/static/...` nor `/substrate/substrate.css`
 * resolves and G2 can only report CANNOT-CHECK. This script puts the same bytes in
 * the layout a static host serves, which is the layout the gate assumes.
 *
 * It is a verification artifact, not a deploy target: vercel.json still ships
 * apps/web/.next, and apps/web/out is gitignored. Nothing is rewritten or minified —
 * the HTML and CSS copied here are byte-for-byte what the build produced.
 *
 * Usage:  pnpm --filter @jamessuuu/sluice-web build && node scripts/design-snapshot.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps/web");
const NEXT = join(WEB, ".next");
const OUT = join(WEB, "out");

const html = join(NEXT, "server/app/index.html");
if (!existsSync(html)) {
  throw new Error(`no prerendered landing page at ${html} — run the web build first`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const source = readFileSync(html, "utf8");
writeFileSync(join(OUT, "index.html"), source);

// Copy every same-origin stylesheet the page links, preserving its href path so the
// snapshot resolves exactly the way a static host would.
const hrefs = [...source.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
  .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
  .filter((h) => h && !/^https?:|^\/\//.test(h));

const copied = [];
for (const href of new Set(hrefs)) {
  const rel = href.replace(/^\//, "").split("?")[0];
  const from = rel.startsWith("_next/") ? join(NEXT, rel.slice("_next/".length)) : join(WEB, "public", rel);
  if (!existsSync(from)) {
    process.stdout.write(`  skipped (not found): ${href}\n`);
    continue;
  }
  const to = join(OUT, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  copied.push(rel);
}

process.stdout.write(`design snapshot -> apps/web/out (index.html + ${copied.length} stylesheet(s))\n`);
for (const rel of copied) process.stdout.write(`  ${rel}\n`);
