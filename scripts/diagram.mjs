/**
 * Mechanism diagram generator — sluice's one diagram, per
 * showcase-program/DESIGN-DIRECTION.md: "the four-state effect machine —
 * in_flight -> succeeded / failed / indeterminate, with the fail-closed edge
 * in amber, because that one edge is the argument."
 *
 * Same conventions as scripts/brand.mjs: deterministic (no Math.random, no
 * webfont, no network, no date stamping), same house palette, ink strokes,
 * exactly one amber element, 0-2px radius, no gradients, no drop shadows.
 * Stroke weights are derived from the same 64-unit grid brand.mjs draws
 * glyphs on, so a diagram reads as the same instrument at any size — the
 * canvas itself is larger because a state machine needs room for four boxes
 * and their labels, but the line language (SW/SWH below) is identical.
 *
 * The states and transitions below are not invented for the picture: they
 * are packages/sluice/src/types.ts's `EffectStatus` and the transitions
 * sluice.ts actually performs in `execute()`/`persistThrow()`. `indeterminate`
 * is the only status with no automatic path back to `in_flight` — reclaiming
 * it requires an explicit `onIndeterminate: 'reclaim'` call or a human
 * decision through a gate (docs/failure-modes F2-F4). That asymmetry — not
 * a stylistic choice — is why its edge is the one amber element.
 *
 * Usage:  node scripts/diagram.mjs --out=apps/web/public/diagram
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// docs/DESIGN.md palette (BRAND-KIT.md — binding). Do not invent colours.
const PAPER = "#FAF7F2";
const INK = "#1A1712";
const AMBER = "#B45309";
const RULE = "#E4DDD3";

const G = 64; // the same grid unit scripts/brand.mjs draws glyphs on
const SW = (G * 0.047).toFixed(3); // standard stroke — matches brand.mjs
const SWH = (G * 0.031).toFixed(3); // hairline — matches brand.mjs
// Single-quoted family names: this string is embedded inside a
// double-quoted SVG/XML attribute, so it must not contain literal `"`.
const MONO = "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace";

const W = 720;
const H = 424;

// Left node: the single non-terminal state.
const SRC = { x: 40, y: 155, w: 184, h: 70 };
// Right nodes: the three terminal states, stacked.
const DST_W = 184;
const DST_H = 70;
const DST_X = 520;
const SUCCEEDED = { x: DST_X, y: 36, w: DST_W, h: DST_H };
const FAILED = { x: DST_X, y: 155, w: DST_W, h: DST_H };
const INDETERMINATE = { x: DST_X, y: 274, w: DST_W, h: DST_H };

const FORK_X = 368; // where the single stem splits into three branches
const STEM_Y = SRC.y + SRC.h / 2; // 190 — vertical centre, matches FAILED's y

/**
 * A node box: a bold title plus up to two short caption lines. Lines are
 * kept short by the caller (not measured here) so they never run past the
 * box edge at this font size on this box width — see the char budgets noted
 * where each box is drawn below.
 */
function box({ x, y, w, h }, label, subLines = [], { strong = false } = {}) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const titleY = subLines.length === 0 ? cy : cy - 4 - (subLines.length - 1) * 6;
  const subs = subLines
    .map(
      (line, i) =>
        `<text x="${cx}" y="${(titleY + 20 + i * 13).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="${MONO}" font-size="10.5" fill="${INK}" fill-opacity="0.62">${line}</text>`
    )
    .join("");
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${PAPER}" stroke="${INK}" stroke-width="${strong ? SW : SWH}"/>`,
    `<text x="${cx}" y="${titleY}" text-anchor="middle" dominant-baseline="middle" font-family="${MONO}" font-size="18" font-weight="600" fill="${INK}">${label}</text>`,
    subs,
  ].join("");
}

/** A right-pointing ink or amber arrowhead, tip at (x, y). */
function arrowhead(x, y, color) {
  const s = 9;
  return `<path d="M${(x - s).toFixed(1)} ${(y - s * 0.62).toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)} L${(x - s).toFixed(1)} ${(y + s * 0.62).toFixed(1)} Z" fill="${color}"/>`;
}

function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    })
  );
  const outDir = args.out ?? "apps/web/public/diagram";
  mkdirSync(outDir, { recursive: true });

  const succeededMidY = SUCCEEDED.y + SUCCEEDED.h / 2;
  const indeterminateMidY = INDETERMINATE.y + INDETERMINATE.h / 2;

  const parts = [];

  // The stem: in_flight's right edge to the fork point. One line, one state.
  parts.push(
    `<path d="M${SRC.x + SRC.w} ${STEM_Y} H${FORK_X}" fill="none" stroke="${INK}" stroke-width="${SW}"/>`
  );
  parts.push(`<circle cx="${FORK_X}" cy="${STEM_Y}" r="4" fill="${INK}"/>`);

  // Branch 1 (ink): succeeded — the effect ran and the result is durable.
  parts.push(
    `<path d="M${FORK_X} ${STEM_Y} V${succeededMidY} H${SUCCEEDED.x - 14}" fill="none" stroke="${INK}" stroke-width="${SW}"/>`
  );
  parts.push(arrowhead(SUCCEEDED.x, succeededMidY, INK));

  // Branch 2 (ink): failed — provably did not happen. Straight; it shares
  // the stem's y, so no elbow is needed.
  parts.push(
    `<path d="M${FORK_X} ${STEM_Y} H${FAILED.x - 14}" fill="none" stroke="${INK}" stroke-width="${SW}"/>`
  );
  parts.push(arrowhead(FAILED.x, STEM_Y, INK));

  // Branch 3 (AMBER — the one signal): indeterminate. The only edge with no
  // automatic path back to in_flight; sluice fails closed here by default.
  parts.push(
    `<path d="M${FORK_X} ${STEM_Y} V${indeterminateMidY} H${INDETERMINATE.x - 14}" fill="none" stroke="${AMBER}" stroke-width="${SW}"/>`
  );
  parts.push(arrowhead(INDETERMINATE.x, indeterminateMidY, AMBER));

  // Boxes. Caption lines are pre-wrapped short (<=22 chars) so they sit
  // inside the box at this font size without measuring text width.
  parts.push(box(SRC, "in_flight", ["retries happen here,", "under one lease"], { strong: true }));
  parts.push(box(SUCCEEDED, "succeeded", ["result persisted;", "replayed to callers"]));
  parts.push(box(FAILED, "failed", ["provably did not", "happen"]));
  parts.push(box(INDETERMINATE, "indeterminate", ["we do not know"], { strong: true }));

  // The fail-closed caption, set on the amber branch — the entire argument.
  const captionY = (STEM_Y + indeterminateMidY) / 2 + 8;
  parts.push(
    `<rect x="${FORK_X + 6}" y="${captionY - 15}" width="280" height="20" fill="${PAPER}"/>`
  );
  parts.push(
    `<text x="${FORK_X + 12}" y="${captionY}" font-family="${MONO}" font-size="13" font-weight="600" fill="${AMBER}">fails closed — never auto-retried</text>`
  );

  // Baseline rule, house convention (see chaos-table / mdx tables): a
  // hairline footer separating the diagram from its two-line summary. Each
  // line stays well under ~85 monospace characters so it never runs past
  // the 720-wide canvas.
  const footerY = H - 54;
  parts.push(`<path d="M0 ${footerY} H${W}" stroke="${RULE}" stroke-width="1"/>`);
  parts.push(
    `<text x="0" y="${H - 32}" font-family="${MONO}" font-size="12" fill="${INK}" fill-opacity="0.6">in_flight is the only non-terminal state here; the other three are final once reached.</text>`
  );
  parts.push(
    `<text x="0" y="${H - 14}" font-family="${MONO}" font-size="12" fill="${INK}" fill-opacity="0.6">Leaving indeterminate needs an explicit reclaim or a gate decision — never a retry.</text>`
  );

  const title = "sluice's exactly-once state machine: in_flight to succeeded, failed, or indeterminate";
  const desc =
    "A directed diagram. One box, in_flight, has three outgoing arrows, drawn as a single stem that forks into three branches. " +
    "The first branch leads to succeeded: the effect ran and its result was durably recorded, so every future caller replays that result instead of running the effect again. " +
    "The second branch leads to failed: the effect provably did not happen, so it is safe to know the outcome and act on it. " +
    "The third branch, drawn in amber because it is the only one that matters for this argument, leads to indeterminate: sluice could not determine whether the effect happened, for example a timeout after the call was sent, or a crash after the effect ran but before its result was persisted. " +
    "Unlike the other two branches, indeterminate has no automatic path back to in_flight. By default sluice fails closed: the effect is parked as indeterminate and never silently retried. " +
    "Leaving that state requires an explicit reclaim call, where the caller has declared the downstream operation safe to repeat, or a human decision recorded through an approval gate. " +
    "Retries happen inside in_flight, under a single lease, before any terminal state is reached — they never turn a failed or indeterminate outcome into a fresh attempt.";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="sluice-diagram-title sluice-diagram-desc">
<title id="sluice-diagram-title">${title}</title>
<desc id="sluice-diagram-desc">${desc}</desc>
<rect width="${W}" height="${H}" fill="${PAPER}"/>
${parts.join("\n")}
</svg>
`;

  const outPath = join(outDir, "states.svg");
  writeFileSync(outPath, svg);
  console.log(`diagram: sluice -> ${outPath}`);
}

main();
