/**
 * The 200-seed fuzz gate + auto-minimizer (SPEC §8). Each seed derives a
 * randomized scenario + fault plan (pure function of the seed); the run must
 * produce zero I1–I8 violations. A failing seed is greedily minimized —
 * shrink intents, zero fault dimensions, drop duplicates/crashes — while it
 * still fails, and the survivor is printed as a pinnable golden (#25).
 *
 * Isomorphic-pure: no node builtins.
 */

import { mulberry32, type FaultPlanSpec } from "./fault-plan.js";
import type { GoldenCase } from "./golden.js";
import { replayGolden } from "./golden.js";
import {
  runScenario,
  SCENARIO_NAMES,
  type ScenarioConfig,
  type ScenarioName,
  type ScenarioResult,
} from "./scenarios.js";

export interface FuzzCase {
  scenario: ScenarioName;
  seed: number;
  plan: FaultPlanSpec;
  config: ScenarioConfig;
}

function pick<T>(r: () => number, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("pick: empty list");
  return item;
}

/** Derive a randomized case from a fuzz seed — deterministic and replayable. */
export function fuzzCase(seed: number): FuzzCase {
  const r = mulberry32((seed ^ 0x5f356495) >>> 0);
  const scenario = pick(r, SCENARIO_NAMES);
  const plan: FaultPlanSpec = {};
  const config: ScenarioConfig = {};

  config.intents = scenario === "retry-storm" ? 10 + Math.floor(r() * 30) : 1 + Math.floor(r() * 4);

  if (scenario === "duplicate-delivery" || scenario === "clock-skew") {
    plan.deliveries = [1 + Math.floor(r() * 2), 2 + Math.floor(r() * 3)];
  }
  if (scenario === "retry-storm") {
    plan.errorRate = 0.3; // the published I6 gate condition
  } else if (r() < 0.5) {
    plan.errorRate = pick(r, [0, 0.1, 0.2]);
  }
  if (scenario !== "retry-storm" && r() < 0.4) {
    plan.timeoutRate = pick(r, [0.1, 0.2]);
  }
  if (scenario === "slow-downstream") {
    plan.latencyMs = [1_000 + Math.floor(r() * 10_000), 30_000 + Math.floor(r() * 70_000)];
  } else if (r() < 0.4) {
    plan.latencyMs = Math.floor(r() * 500);
  }
  if (scenario === "crash-mid-gate") {
    plan.crashes = 1 + Math.floor(r() * 2);
  }
  if (scenario === "timeout-then-success") {
    plan.attemptOverrides = ["timeout"];
  }
  if (scenario === "clock-skew") {
    config.variant = pick(r, ["within", "beyond", "mixed"]);
  }
  if (scenario === "out-of-order-decision") {
    config.variant = pick(r, ["approve-first", "reject-first", "late", "mixed"]);
  }
  if (scenario === "crash-before-effect") {
    config.variant = pick(r, ["fail", "reclaim", "gate"]);
  }
  return { scenario, seed, plan, config };
}

export async function runFuzzCase(c: FuzzCase): Promise<ScenarioResult> {
  return runScenario({ scenario: c.scenario, seed: c.seed, plan: c.plan, config: c.config });
}

export interface FuzzReport {
  seeds: number;
  violations: number;
  failures: { seed: number; case: FuzzCase; violations: string[] }[];
}

/** Run seeds 1..n; every seed must be violation-free. */
export async function runFuzz(n: number): Promise<FuzzReport> {
  const failures: FuzzReport["failures"] = [];
  let violations = 0;
  for (let seed = 1; seed <= n; seed++) {
    const c = fuzzCase(seed);
    const result = await runFuzzCase(c);
    if (result.violations.length > 0) {
      violations += result.violations.length;
      failures.push({ seed, case: c, violations: result.violations });
    }
  }
  return { seeds: n, violations, failures };
}

function omitPlanKey(plan: FaultPlanSpec, key: keyof FaultPlanSpec): FaultPlanSpec {
  return Object.fromEntries(Object.entries(plan).filter(([k]) => k !== key));
}

/** All one-step simplifications of a case, most aggressive first. */
function simplifications(c: FuzzCase): FuzzCase[] {
  const out: FuzzCase[] = [];
  const push = (plan: FaultPlanSpec, config: ScenarioConfig) => {
    out.push({ scenario: c.scenario, seed: c.seed, plan, config });
  };
  const intents = c.config.intents;
  if (intents !== undefined && intents > 1) {
    push(c.plan, { ...c.config, intents: 1 });
    push(c.plan, { ...c.config, intents: Math.max(1, Math.floor(intents / 2)) });
  }
  if (c.plan.deliveries !== undefined) {
    const rest = { ...c.plan };
    delete rest.deliveries;
    push(rest, c.config);
    push({ ...c.plan, deliveries: 2 }, c.config);
  }
  for (const dim of ["errorRate", "timeoutRate", "latencyMs", "attemptOverrides"] as const) {
    if (c.plan[dim] !== undefined) {
      push(omitPlanKey(c.plan, dim), c.config);
    }
  }
  if (c.plan.crashes !== undefined && c.plan.crashes > 1) {
    push({ ...c.plan, crashes: 1 }, c.config);
  }
  if (c.config.variant !== undefined) {
    const rest = { ...c.config };
    delete rest.variant;
    push(c.plan, rest);
  }
  return out;
}

/**
 * Greedy shrink against an arbitrary failure predicate: keep applying the
 * first simplification that still fails until none does. Bounded by the
 * (finite, strictly-shrinking) search space.
 */
export async function minimizeCase(
  c: FuzzCase,
  stillFails: (candidate: FuzzCase) => Promise<boolean>
): Promise<FuzzCase> {
  let best = c;
  for (;;) {
    let shrunk = false;
    for (const candidate of simplifications(best)) {
      if (await stillFails(candidate)) {
        best = candidate;
        shrunk = true;
        break;
      }
    }
    if (!shrunk) return best;
  }
}

/** Shrink a fuzz failure while it keeps violating I1–I8. */
export async function minimizeFuzzCase(c: FuzzCase): Promise<FuzzCase> {
  return minimizeCase(c, async (candidate) => (await runFuzzCase(candidate)).violations.length > 0);
}

/**
 * Render the minimized failure as a pinnable golden fixture (golden #25):
 * the expected trace is the CURRENT (violating) behaviour, so pinning it
 * makes the bug a permanent regression test once fixed and regenerated.
 */
export async function pinnableGolden(c: FuzzCase): Promise<string> {
  const golden: GoldenCase = {
    id: `fuzz-${String(c.seed)}-minimized`,
    scenario: c.scenario,
    seed: c.seed,
    plan: c.plan,
    config: c.config,
  };
  const trace = await replayGolden(golden);
  return JSON.stringify({ ...golden, expected: trace }, null, 2);
}
