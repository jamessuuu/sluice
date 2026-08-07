/**
 * The full chaos suite (SPEC §7): 9 scenarios × 10 seeds with I1–I8 asserted
 * on every run, the naive-vs-sluice baseline workload, the golden set and
 * the 200-seed fuzz gate — aggregated into the published-numbers object that
 * `pnpm chaos` writes to chaos/results/latest.json and the eval stage
 * re-runs to prove the committed numbers have not drifted.
 *
 * Node-only (file I/O for golden fixtures) — lives under src/chaos/ by the
 * package's isomorphic-purity rule.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runFuzz } from "../fuzz.js";
import { verifyGolden, type GoldenFixture } from "../golden.js";
import { runNaiveBaseline } from "../naive.js";
import type { FaultPlanSpec } from "../fault-plan.js";
import { runScenario, SCENARIO_NAMES, type ScenarioName } from "../scenarios.js";

export const SEEDS_PER_SCENARIO = 10;
export const FUZZ_SEEDS = 200;
export const AMPLIFICATION_GATE = 1.5;

const BASELINE_WORKLOAD: { intents: number; seeds: number; plan: FaultPlanSpec } = {
  intents: 20,
  seeds: 10,
  plan: { deliveries: [2, 5], errorRate: 0.15, timeoutRate: 0.15 },
};

export interface ScenarioRollup {
  name: ScenarioName;
  seeds: number;
  intents: number;
  deliveries: number;
  ledger: number;
  attempts: number;
  duplicateEffects: number;
  violations: number;
}

export interface ChaosResults {
  generatedAt: string;
  gitSha: string;
  harness: {
    scenarios: number;
    seedsPerScenario: number;
    totalRuns: number;
    totalIntents: number;
    totalDeliveries: number;
    totalLedger: number;
    invariantsChecked: string[];
    invariantViolations: number;
    violationDetails: string[];
  };
  scenarios: ScenarioRollup[];
  baseline: {
    workload: {
      intents: number;
      seeds: number;
      deliveries: [number, number];
      errorRate: number;
      timeoutRate: number;
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
  amplification: { injectedFailureRate: number; factor: number; gate: number };
  latency: { unit: string; p50: number; p99: number; samples: number };
  golden: { total: number; passed: number; failures: string[] };
  fuzz: { seeds: number; violations: number };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function loadGoldenFixtures(goldenDir: string): GoldenFixture[] {
  const files = readdirSync(goldenDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => JSON.parse(readFileSync(join(goldenDir, f), "utf8")) as GoldenFixture);
}

/**
 * Run everything and aggregate. `generatedAt`/`gitSha` are filled by the
 * caller (they are the only volatile fields — the drift check strips them).
 */
export async function runChaosSuite(o: { goldenDir: string }): Promise<ChaosResults> {
  // ── 9 scenarios × 10 seeds, invariants on every run ─────────────────────
  const rollups: ScenarioRollup[] = [];
  const violationDetails: string[] = [];
  const durations: number[] = [];
  let stormAttempts = 0;
  let stormIntents = 0;

  for (const name of SCENARIO_NAMES) {
    const rollup: ScenarioRollup = {
      name,
      seeds: SEEDS_PER_SCENARIO,
      intents: 0,
      deliveries: 0,
      ledger: 0,
      attempts: 0,
      duplicateEffects: 0,
      violations: 0,
    };
    for (let seed = 1; seed <= SEEDS_PER_SCENARIO; seed++) {
      const r = await runScenario({ scenario: name, seed });
      rollup.intents += r.intents;
      rollup.deliveries += r.deliveries;
      rollup.ledger += r.ledgerCount;
      rollup.attempts += r.attempts;
      rollup.duplicateEffects += r.duplicateEffects;
      rollup.violations += r.violations.length;
      for (const v of r.violations) violationDetails.push(`${name} seed ${String(seed)}: ${v}`);
      durations.push(...r.durationsVirtualMs);
      if (name === "retry-storm") {
        stormAttempts += r.attempts;
        stormIntents += r.intents;
      }
    }
    rollups.push(rollup);
  }

  // ── naive vs sluice baseline workload (the headline table) ──────────────
  let naiveSucceeded = 0;
  let naiveDuplicates = 0;
  let naiveAttempts = 0;
  let naiveDeliveries = 0;
  let sluiceSucceeded = 0;
  let sluiceDuplicates = 0;
  let sluiceAttempts = 0;
  let sluiceFailClosed = 0;
  const baseIntents = BASELINE_WORKLOAD.intents;
  for (let seed = 1; seed <= BASELINE_WORKLOAD.seeds; seed++) {
    const naive = await runNaiveBaseline({
      seed,
      intents: baseIntents,
      plan: BASELINE_WORKLOAD.plan,
    });
    naiveSucceeded += naive.intentsSucceeded;
    naiveDuplicates += naive.duplicateEffects;
    naiveAttempts += naive.attempts;
    naiveDeliveries += naive.deliveries;

    const viaSluice = await runScenario({
      scenario: "duplicate-delivery",
      seed,
      plan: BASELINE_WORKLOAD.plan,
      config: { intents: baseIntents },
    });
    for (const v of viaSluice.violations) {
      violationDetails.push(`baseline-sluice seed ${String(seed)}: ${v}`);
    }
    const succeeded = new Set<string>();
    for (const rep of viaSluice.reports) {
      if (rep.outcome === "executed" || rep.outcome === "replayed") succeeded.add(rep.intent);
    }
    sluiceSucceeded += succeeded.size;
    sluiceDuplicates += viaSluice.duplicateEffects;
    sluiceAttempts += viaSluice.attempts;
    for (const [key, status] of Object.entries(viaSluice.finalStatuses)) {
      if (key.startsWith("effect:") && status === "indeterminate") sluiceFailClosed++;
    }
  }
  const baselineTotal = baseIntents * BASELINE_WORKLOAD.seeds;

  // ── aggregates ──────────────────────────────────────────────────────────
  const totalViolations = violationDetails.length;
  durations.sort((a, b) => a - b);
  const goldenFixtures = loadGoldenFixtures(o.goldenDir);
  const goldenFailures: string[] = [];
  for (const fixture of goldenFixtures) {
    const check = await verifyGolden(fixture);
    if (!check.ok) goldenFailures.push(`${fixture.id}: ${check.diff.join("; ")}`);
  }
  const fuzz = await runFuzz(FUZZ_SEEDS);
  const [dMin, dMax] = Array.isArray(BASELINE_WORKLOAD.plan.deliveries)
    ? BASELINE_WORKLOAD.plan.deliveries
    : [1, 1];

  return {
    generatedAt: "",
    gitSha: "",
    harness: {
      scenarios: SCENARIO_NAMES.length,
      seedsPerScenario: SEEDS_PER_SCENARIO,
      totalRuns: SCENARIO_NAMES.length * SEEDS_PER_SCENARIO,
      totalIntents: rollups.reduce((a, r) => a + r.intents, 0),
      totalDeliveries: rollups.reduce((a, r) => a + r.deliveries, 0),
      totalLedger: rollups.reduce((a, r) => a + r.ledger, 0),
      invariantsChecked: ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"],
      invariantViolations: totalViolations,
      violationDetails,
    },
    scenarios: rollups,
    baseline: {
      workload: {
        intents: baseIntents,
        seeds: BASELINE_WORKLOAD.seeds,
        deliveries: [dMin, dMax],
        errorRate: BASELINE_WORKLOAD.plan.errorRate ?? 0,
        timeoutRate: BASELINE_WORKLOAD.plan.timeoutRate ?? 0,
        injectedFailureRate: round4(
          (BASELINE_WORKLOAD.plan.errorRate ?? 0) + (BASELINE_WORKLOAD.plan.timeoutRate ?? 0)
        ),
      },
      naive: {
        successRate: round4(naiveSucceeded / baselineTotal),
        duplicateEffects: naiveDuplicates,
        attempts: naiveAttempts,
        deliveries: naiveDeliveries,
      },
      sluice: {
        successRate: round4(sluiceSucceeded / baselineTotal),
        duplicateEffects: sluiceDuplicates,
        attempts: sluiceAttempts,
        failClosedRate: round4(sluiceFailClosed / baselineTotal),
      },
    },
    amplification: {
      injectedFailureRate: 0.3,
      factor: round4(stormIntents === 0 ? 0 : stormAttempts / stormIntents),
      gate: AMPLIFICATION_GATE,
    },
    latency: {
      unit: "virtual clock ms (not wall clock)",
      p50: percentile(durations, 50),
      p99: percentile(durations, 99),
      samples: durations.length,
    },
    golden: {
      total: goldenFixtures.length,
      passed: goldenFixtures.length - goldenFailures.length,
      failures: goldenFailures,
    },
    fuzz: { seeds: fuzz.seeds, violations: fuzz.violations },
  };
}
