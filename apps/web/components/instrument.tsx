import type { CSSProperties } from "react";

// The hero instrument (PORTFOLIO-DESIGN-DNA.md §4): sluice's own primary data
// structure — the delivery state machine — promoted to the hero object and drawn in
// the shared physics, at build time, from the committed artifact.
//
//   "sluice | The delivery state machine: 200 intents fanning into 2-5 deliveries
//    each, collapsing to one side effect, against the naive branch's 666 duplicate
//    charges — same fault schedule, two outcomes."   (DNA §4's own table)
//
// Every mark is a datum. The 200 marks in the workload block are the 200 logical
// intents (20 intents x 10 seeds). The 666 marks in the upper aperture are the 666
// duplicate side effects the naive retry loop committed — one square per duplicate
// charge, not a bar whose height stands in for them. The lower aperture is the same
// aperture with nothing in it, because sluice committed zero under the identical
// fault schedule. Nothing here is authored by hand: `pnpm chaos` regenerates
// chaos/results/latest.json and this drawing follows it (gate G10).
//
// Static SVG at compile time, per DNA §6: zero runtime cost, crawlable, printable,
// sharp at any zoom, renders with JavaScript off (gate G7).
//
// Two authored layouts, not one squeezed (DNA §3.5: "390px: 4 columns... an authored
// breakpoint, not a squeeze of 1440"). The wide one forks a fan; the narrow one drops
// the fan, because at 390px the fan is decoration rather than information.
import latest from "../../../chaos/results/latest.json" with { type: "json" };

interface ChaosResults {
  baseline: {
    workload: {
      intents: number;
      seeds: number;
      deliveries: [number, number];
      injectedFailureRate: number;
    };
    naive: { successRate: number; duplicateEffects: number; attempts: number; deliveries: number };
    sluice: {
      successRate: number;
      duplicateEffects: number;
      attempts: number;
      failClosedRate: number;
    };
  };
}

const b = (latest as unknown as ChaosResults).baseline;

export const BASELINE = {
  intents: b.workload.intents * b.workload.seeds,
  intentCols: b.workload.intents,
  intentRows: b.workload.seeds,
  deliveryMin: b.workload.deliveries[0],
  deliveryMax: b.workload.deliveries[1],
  injectedFailureRate: b.workload.injectedFailureRate,
  deliveries: b.naive.deliveries,
  naiveDuplicates: b.naive.duplicateEffects,
  naiveAttempts: b.naive.attempts,
  naiveSuccessRate: b.naive.successRate,
  sluiceDuplicates: b.sluice.duplicateEffects,
  sluiceAttempts: b.sluice.attempts,
  sluiceSuccessRate: b.sluice.successRate,
  sluiceFailClosedRate: b.sluice.failClosedRate,
};

export const fmt = (n: number) => n.toLocaleString("en-US");
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** One square per datum, laid out row-major, as a single path: `count` subpaths,
 * exactly — never a rounded-up rectangle standing in for a number. */
function marks(count: number, cols: number, pitch: number, size: number, x0: number, y0: number) {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + (i % cols) * pitch;
    const y = y0 + Math.floor(i / cols) * pitch;
    parts.push(`M${String(x)} ${String(y)}h${String(size)}v${String(size)}h-${String(size)}z`);
  }
  return parts.join("");
}

/** The zero reading: a needle at rest across the empty aperture, drawn with the same
 * tick grammar as the READOUT's baseline. */
function restLine(x0: number, x1: number, y: number, ticks: number) {
  const parts = [`M${String(x0)} ${String(y)}H${String(x1)}`];
  for (let i = 0; i <= ticks; i++) {
    const x = x0 + ((x1 - x0) * i) / ticks;
    parts.push(`M${String(x)} ${String(y - 4)}V${String(y + 4)}`);
  }
  return parts.join("");
}

// The aperture is sized so its mark count IS the reading: cols x ceil(n/cols) cells,
// every cell either a committed duplicate or empty. Two authored sizes, one grammar.
const WIDE = { cols: 48, pitch: 7, size: 3.5, w: 352, h: 116 };
const NARROW = { cols: 42, pitch: 6, size: 3, w: 272, h: 116 };

// DNA §3.1: Archivo wdth 85 for dense labels, Commit Mono (tabular) for every figure.
const LABEL: CSSProperties = {
  fontFamily: "var(--font-structure)",
  fontStretch: "85%",
  fontWeight: 600,
  letterSpacing: "0.03em",
};
const DATA: CSSProperties = {
  fontFamily: "var(--font-data)",
  fontVariantNumeric: "tabular-nums",
};
const MICRO: CSSProperties = { ...DATA, fontWeight: 500, letterSpacing: "0.06em" };

export function Instrument() {
  const dup = BASELINE.naiveDuplicates;
  const rows = Math.ceil(dup / WIDE.cols);
  const description =
    `The delivery state machine. ${fmt(BASELINE.intents)} logical intents, delivered ` +
    `${String(BASELINE.deliveryMin)} to ${String(BASELINE.deliveryMax)} times each under ` +
    `${pct(BASELINE.injectedFailureRate)} injected failure, produce ${fmt(BASELINE.deliveries)} ` +
    `deliveries. Given that identical fault schedule the naive retry branch commits ` +
    `${fmt(dup)} duplicate side effects, drawn as ${fmt(dup)} squares in a ` +
    `${String(WIDE.cols)} by ${String(rows)} aperture; sluice commits ` +
    `${fmt(BASELINE.sluiceDuplicates)}, drawn as the same aperture, empty.`;

  return (
    <>
      {/* ------------------------------- >= 768px ------------------------------- */}
      <svg
        className="hidden h-auto w-full md:block"
        viewBox="0 0 1120 340"
        role="img"
        aria-label={description}
      >
        {/* the workload: 200 marks, 20 intents across x 10 seeds down */}
        <text x="0" y="130" fill="var(--ink-3)" fontSize="12" style={MICRO}>
          {fmt(BASELINE.intents)} INTENTS
        </text>
        <path d={marks(BASELINE.intents, BASELINE.intentCols, 10, 4, 0, 139)} fill="var(--ink-2)" />
        <text x="0" y="256" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {BASELINE.intentCols} intents x {BASELINE.intentRows} seeds
        </text>
        <text x="0" y="274" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {BASELINE.deliveryMin}-{BASELINE.deliveryMax} deliveries each
        </text>

        {/* the fan: one schedule, two branches. 0/45/90 only (DNA §3.6). */}
        <g stroke="var(--ink-3)" strokeWidth="1.5" fill="none" strokeLinecap="square">
          <path d="M196 186H215" />
          <path d="M215 186L301 100H384" />
          <path d="M215 186L301 272H384" />
          <path d="M376 94L384 100L376 106" />
          <path d="M376 266L384 272L376 278" />
        </g>

        {/* branch A — naive retry */}
        <text x="400" y="90" fill="var(--ink)" fontSize="14" style={LABEL}>
          NAIVE RETRY
        </text>
        <text x="400" y="112" fill="var(--ink-2)" fontSize="12" style={DATA}>
          {fmt(BASELINE.deliveries)} deliveries in
        </text>
        <text x="400" y="130" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {fmt(BASELINE.naiveAttempts)} downstream attempts
        </text>
        <rect
          x="590"
          y="44"
          width={WIDE.w}
          height={WIDE.h}
          fill="none"
          stroke="var(--edge-lo)"
          strokeWidth="1"
        />
        <path d={marks(dup, WIDE.cols, WIDE.pitch, WIDE.size, 600, 54)} fill="var(--fail)" />
        <text x="964" y="114" fill="var(--fail-ink)" fontSize="48" fontWeight="500" style={DATA}>
          {fmt(dup)}
        </text>
        <text x="964" y="136" fill="var(--ink-3)" fontSize="12" style={MICRO}>
          DUPLICATE CHARGES
        </text>

        {/* branch B — with sluice */}
        <text x="400" y="262" fill="var(--ink)" fontSize="14" style={LABEL}>
          WITH SLUICE
        </text>
        <text x="400" y="284" fill="var(--ink-2)" fontSize="12" style={DATA}>
          {fmt(BASELINE.deliveries)} deliveries in
        </text>
        <text x="400" y="302" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {fmt(BASELINE.sluiceAttempts)} downstream attempts
        </text>
        <rect
          x="590"
          y="216"
          width={WIDE.w}
          height={WIDE.h}
          fill="none"
          stroke="var(--edge-lo)"
          strokeWidth="1"
        />
        <path
          d={restLine(600, 932, 274, 8)}
          stroke="var(--signal)"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="square"
        />
        <text x="964" y="286" fill="var(--signal-ink)" fontSize="48" fontWeight="500" style={DATA}>
          {fmt(BASELINE.sluiceDuplicates)}
        </text>
        <text x="964" y="308" fill="var(--ink-3)" fontSize="12" style={MICRO}>
          DUPLICATE CHARGES
        </text>
      </svg>

      {/* -------------------------------- < 768px -------------------------------- */}
      <svg
        className="h-auto w-full md:hidden"
        viewBox="0 0 360 520"
        role="img"
        aria-label={description}
      >
        <text x="180" y="14" textAnchor="middle" fill="var(--ink-3)" fontSize="12" style={MICRO}>
          {fmt(BASELINE.intents)} INTENTS
        </text>
        <path d={marks(BASELINE.intents, BASELINE.intentCols, 8, 3.5, 100, 26)} fill="var(--ink-2)" />
        <text x="180" y="124" textAnchor="middle" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {BASELINE.intentCols} x {BASELINE.intentRows} seeds, {BASELINE.deliveryMin}-
          {BASELINE.deliveryMax} deliveries each
        </text>
        <path d="M0 140H360" stroke="var(--edge-lo)" strokeWidth="1" />

        <text x="0" y="170" fill="var(--ink)" fontSize="13" style={LABEL}>
          NAIVE RETRY
        </text>
        <text x="0" y="188" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {fmt(BASELINE.naiveAttempts)} downstream attempts
        </text>
        <text x="360" y="172" textAnchor="end" fill="var(--fail-ink)" fontSize="38" fontWeight="500" style={DATA}>
          {fmt(dup)}
        </text>
        <text x="360" y="192" textAnchor="end" fill="var(--ink-3)" fontSize="12" style={MICRO}>
          DUPLICATE CHARGES
        </text>
        <rect
          x="44"
          y="204"
          width={NARROW.w}
          height={NARROW.h}
          fill="none"
          stroke="var(--edge-lo)"
          strokeWidth="1"
        />
        <path d={marks(dup, NARROW.cols, NARROW.pitch, NARROW.size, 54, 214)} fill="var(--fail)" />

        <text x="0" y="358" fill="var(--ink)" fontSize="13" style={LABEL}>
          WITH SLUICE
        </text>
        <text x="0" y="376" fill="var(--ink-3)" fontSize="12" style={DATA}>
          {fmt(BASELINE.sluiceAttempts)} downstream attempts
        </text>
        <text x="360" y="360" textAnchor="end" fill="var(--signal-ink)" fontSize="38" fontWeight="500" style={DATA}>
          {fmt(BASELINE.sluiceDuplicates)}
        </text>
        <text x="360" y="380" textAnchor="end" fill="var(--ink-3)" fontSize="12" style={MICRO}>
          DUPLICATE CHARGES
        </text>
        <rect
          x="44"
          y="392"
          width={NARROW.w}
          height={NARROW.h}
          fill="none"
          stroke="var(--edge-lo)"
          strokeWidth="1"
        />
        <path
          d={restLine(54, 306, 450, 6)}
          stroke="var(--signal)"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="square"
        />
      </svg>
    </>
  );
}
