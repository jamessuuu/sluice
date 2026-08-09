// DESIGN-DIRECTION.md: "one piece of evidence rendered at size... sluice's
// is the 666->0 comparison." Read from the same build-time chaos JSON as
// ChaosTable (chaos-table.tsx) — one source, two renderings, so this number
// can never say something the detailed table below it doesn't back up.
import latest from "../../../chaos/results/latest.json" with { type: "json" };

interface ChaosResults {
  baseline: {
    naive: { duplicateEffects: number };
    sluice: { duplicateEffects: number };
  };
}

const results = latest as unknown as ChaosResults;
const fmt = (n: number) => n.toLocaleString("en-US");

export function EvidenceHero() {
  const r = results;
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border border-rule px-6 py-8">
      <div>
        <div className="font-mono text-6xl font-bold leading-none text-ink sm:text-7xl">
          {fmt(r.baseline.naive.duplicateEffects)}
        </div>
        <div className="mt-2 text-xs uppercase tracking-wide text-ink/50">duplicate charges, naive retry</div>
      </div>
      <div className="font-mono text-4xl text-ink/30 sm:text-5xl" aria-hidden="true">
        →
      </div>
      <div>
        <div className="font-mono text-6xl font-bold leading-none text-amber sm:text-7xl">
          {fmt(r.baseline.sluice.duplicateEffects)}
        </div>
        <div className="mt-2 text-xs uppercase tracking-wide text-ink/50">with sluice, same workload</div>
      </div>
    </div>
  );
}
