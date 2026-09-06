import { BASELINE, fmt } from "./instrument";
import { Icon } from "./substrate-sprite";

/**
 * THE READOUT — PORTFOLIO-DESIGN-DNA.md §10, the one element the whole body of work
 * owns and the reason it is the same component on twenty-eight sites while being a
 * different reading on each.
 *
 *   "the project's single headline measurement as a physical readout: an oversized
 *    tabular Commit Mono numeral on a hairline baseline with tick marks, unit in
 *    Archivo micro-caps beside it. And beneath it, in --ink-3 micro-mono, the
 *    artifact path the number came from, printed like a serial number on the back of
 *    an instrument."
 *
 * sluice's headline measurement is a delta, not a level: 666 duplicate side effects
 * become 0 under an identical fault schedule. Both figures are read from
 * chaos/results/latest.json at build time — neither is typed anywhere in this repo's
 * markup, which is what makes the serial line underneath a claim and not a caption.
 *
 * `read` is the date the page read the artifact, i.e. build time; the artifact's own
 * generation date and git sha are printed in the EVIDENCE band, where they belong.
 */
export function Readout() {
  const readOn = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <p
        className="t-readout flex items-baseline gap-[0.12em] text-ink"
        // Not a count-up: DNA §5 forbids animating a number that is a claim.
        aria-label={`${fmt(BASELINE.naiveDuplicates)} duplicate charges become ${fmt(
          BASELINE.sluiceDuplicates
        )}`}
      >
        <span className="text-fail-ink" aria-hidden="true">
          {fmt(BASELINE.naiveDuplicates)}
        </span>
        <span className="text-ink-3" aria-hidden="true">
          &rarr;
        </span>
        <span className="text-signal-ink" aria-hidden="true">
          {fmt(BASELINE.sluiceDuplicates)}
        </span>
      </p>

      {/* The hairline baseline with tick marks — the readout sits ON an instrument
          scale, not on nothing. Every fourth tick is long, as a ruler's is. */}
      <div className="mt-3 flex h-2 w-full border-t border-edge-lo" aria-hidden="true">
        {Array.from({ length: 24 }, (_, i) => (
          <span
            key={i}
            className="flex-1 border-l border-edge-lo"
            style={{ height: i % 4 === 0 ? "8px" : "4px" }}
          />
        ))}
      </div>

      <p className="t-label mt-3 text-ink-2">
        Duplicate charges &middot; identical fault schedule
      </p>

      {/* The serial number on the back of the instrument. */}
      <p className="t-micro mt-4 flex items-center gap-2 text-ink-3">
        <Icon name="file" size={14} className="shrink-0" />
        <span>
          chaos/results/latest.json &middot; pnpm chaos &middot; read {readOn}
        </span>
      </p>
    </div>
  );
}
