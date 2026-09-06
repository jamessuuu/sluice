// SPEC §9: the landing page's chaos table is read from chaos/results/latest.json
// AT BUILD TIME — never hand-written. This import is resolved once, when
// Next statically renders `/`, so the numbers on the site are exactly the
// numbers `pnpm chaos` last generated (the same source chaos-report.mjs
// injects into README.md — one source of truth, two renderings).
import latest from "../../../chaos/results/latest.json" with { type: "json" };

interface ChaosResults {
  gitSha: string;
  harness: {
    scenarios: number;
    seedsPerScenario: number;
    totalIntents: number;
    totalDeliveries: number;
    invariantViolations: number;
  };
  baseline: {
    workload: {
      intents: number;
      seeds: number;
      deliveries: [number, number];
      injectedFailureRate: number;
      errorRate: number;
      timeoutRate: number;
    };
    naive: { successRate: number; duplicateEffects: number };
    sluice: { successRate: number; duplicateEffects: number; failClosedRate: number };
  };
  amplification: { factor: number; gate: number; injectedFailureRate: number };
  latency: { p50: number; p99: number };
  golden: { total: number; passed: number };
  fuzz: { seeds: number; violations: number };
}

const results = latest as unknown as ChaosResults;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (n: number) => n.toLocaleString("en-US");

export function ChaosTable() {
  const r = results;
  return (
    <div className="raised border border-edge-lo">
      <div className="t-micro border-b border-edge-lo bg-sub-3 px-4 py-3 text-ink-3">
        golden {r.golden.passed}/{r.golden.total} · fuzz {r.fuzz.seeds} seeds · {r.harness.invariantViolations}{" "}
        invariant violations · git {r.gitSha.slice(0, 7)}
      </div>
      {/* This table was not named in the audit's F1-F12 finding, but it sits
          on the same page and its widest row (the parenthetical fail-closed
          explanation) was the actual remaining cause of sluice-home-320.png
          still measuring wider than its 320px viewport after the F1-F12 fix
          below — same defect, same fix pattern (ui-audit.md 3.4): short
          numeric/prose tables get their own overflow-x-auto wrapper. */}
      <div className="overflow-x-auto">
        <table className="t-data-s w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-edge-lo">
              <th className="t-label px-4 py-3 text-ink-3">metric</th>
              <th className="t-label px-4 py-3 text-ink-3">naive retry (no sluice)</th>
              <th className="t-label px-4 py-3 text-ink-3">with sluice</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-edge-lo">
              <td className="px-4 py-2 text-ink-2">intent success rate</td>
              <td className="px-4 py-2">{pct(r.baseline.naive.successRate)}</td>
              <td className="px-4 py-2">
                {pct(r.baseline.sluice.successRate)}{" "}
                <span className="text-ink-3">
                  ({pct(r.baseline.sluice.failClosedRate)} fail closed — parked{" "}
                  <code className="font-mono">indeterminate</code>, never silent)
                </span>
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2 text-ink-2">duplicate side effects</td>
              <td className="px-4 py-2 text-fail-ink">{fmt(r.baseline.naive.duplicateEffects)}</td>
              <td className="px-4 py-2 text-signal-ink">{fmt(r.baseline.sluice.duplicateEffects)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="t-body-s space-y-2 border-t border-edge-lo px-4 py-4 text-ink-3">
        <p>
          Baseline workload: {fmt(r.baseline.workload.intents * r.baseline.workload.seeds)} intents delivered{" "}
          {r.baseline.workload.deliveries[0]}–{r.baseline.workload.deliveries[1]}× each under{" "}
          {pct(r.baseline.workload.injectedFailureRate)} injected failure.
        </p>
        <p>
          Retry amplification under {pct(r.amplification.injectedFailureRate)} injected failure:{" "}
          <strong className="text-ink">{r.amplification.factor.toFixed(2)}×</strong> downstream attempts per
          intent (CI gate ≤ {r.amplification.gate}).
        </p>
        <p>
          <code className="font-mono">run()</code> latency under fault injection: p50 {fmt(r.latency.p50)} ms · p99{" "}
          {fmt(r.latency.p99)} ms — virtual clock time, not wall clock.
        </p>
        <p>
          Run shape: {r.harness.scenarios} scenarios × {r.harness.seedsPerScenario} seeds ·{" "}
          {fmt(r.harness.totalIntents)} intents · {fmt(r.harness.totalDeliveries)} deliveries. Regenerate with{" "}
          <code className="font-mono">pnpm chaos</code> — full tables in{" "}
          <a
            className="link-signal"
            href="https://github.com/jamessuuu/sluice/blob/main/chaos/RESULTS.md"
          >
            chaos/RESULTS.md
          </a>
          .
        </p>
      </div>
    </div>
  );
}
