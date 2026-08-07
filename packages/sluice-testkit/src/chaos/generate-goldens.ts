/**
 * Golden fixture generator (SPEC §8) — dev tool, run manually:
 *
 *   node --import tsx packages/sluice-testkit/src/chaos/generate-goldens.ts
 *
 * Replays each of the 24 pinned cases and writes golden/<id>.json with the
 * CURRENT normalized trace as `expected`. Regenerating goldens is an
 * intentional behaviour change and must land in the same PR as a CHANGELOG
 * entry (SPEC §8) — the eval stage diffs against what is committed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { replayGolden, type GoldenCase } from "../golden.js";
import type { FaultPlanSpec } from "../fault-plan.js";
import type { ScenarioConfig, ScenarioName } from "../scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(HERE, "..", "..", "golden");

function g(
  id: string,
  scenario: ScenarioName,
  seed: number,
  plan: FaultPlanSpec,
  config: ScenarioConfig
): GoldenCase {
  return { id, scenario, seed, plan, config };
}

/**
 * The 24 pinned cases: every scenario in the taxonomy is represented, and
 * the awkward paths (F10 result-omitted replay, reclaim, the did-this-land
 * gate, budget exhaustion, beyond-ceiling skew, late decisions) each get a
 * fixture of their own. Single-digit intent counts keep traces reviewable.
 */
const CASES: GoldenCase[] = [
  // F1 — duplicate delivery
  g("01-duplicate-delivery-2x", "duplicate-delivery", 1, { deliveries: 2 }, { intents: 1 }),
  g("02-duplicate-delivery-5x", "duplicate-delivery", 2, { deliveries: 5 }, { intents: 1 }),
  g(
    "03-duplicate-delivery-slow-winner",
    "duplicate-delivery",
    3,
    { deliveries: 3, latencyMs: 250 },
    { intents: 1 }
  ),
  g(
    "04-duplicate-delivery-result-omitted",
    "duplicate-delivery",
    4,
    { deliveries: 3 },
    { intents: 1, resultBytes: 2048, maxResultBytes: 1024 }
  ),
  // F2 — timeout, effect landed anyway
  g("05-timeout-fail-closed", "timeout-then-success", 1, {}, { intents: 1 }),
  g(
    "06-timeout-fail-closed-latency",
    "timeout-then-success",
    2,
    { latencyMs: 500 },
    { intents: 1 }
  ),
  g("07-timeout-two-intents", "timeout-then-success", 3, {}, { intents: 2 }),
  // F3 — crash after the effect, before the terminal write
  g("08-crash-mid-effect", "crash-mid-effect", 1, {}, { intents: 1 }),
  g("09-crash-mid-effect-two-intents", "crash-mid-effect", 2, {}, { intents: 2 }),
  // F4 — crash before the effect
  g("10-crash-before-effect-fail", "crash-before-effect", 1, {}, { intents: 1, variant: "fail" }),
  g(
    "11-crash-before-effect-reclaim",
    "crash-before-effect",
    2,
    {},
    { intents: 1, variant: "reclaim" }
  ),
  g("12-crash-before-effect-gate", "crash-before-effect", 3, {}, { intents: 1, variant: "gate" }),
  // F5 — crash mid-gate, resume exactly-once
  g("13-crash-mid-gate", "crash-mid-gate", 1, { crashes: 1 }, { intents: 1 }),
  g("14-crash-mid-gate-two-crashes", "crash-mid-gate", 2, { crashes: 2 }, { intents: 1 }),
  // F7 — retry mechanics and the storm defence
  g(
    "15-retry-then-success",
    "retry-storm",
    1,
    { errorRate: 0, attemptOverrides: ["error", "ok"] },
    { intents: 1 }
  ),
  g(
    "16-retries-exhausted",
    "retry-storm",
    2,
    { errorRate: 0, attemptOverrides: ["error", "error", "error"] },
    { intents: 1 }
  ),
  g(
    "17-retry-budget-exhausted",
    "retry-storm",
    3,
    { errorRate: 0, attemptOverrides: ["error", "error", "error", "error", "error", "error"] },
    { intents: 1, maxAttempts: 6 }
  ),
  // F8 — clock skew
  g("18-clock-skew-within-ceiling", "clock-skew", 1, {}, { intents: 1, variant: "within" }),
  g("19-clock-skew-beyond-ceiling", "clock-skew", 1, {}, { intents: 1, variant: "beyond" }),
  // slow downstream vs the deadline
  g("20-slow-downstream-succeeds", "slow-downstream", 1, { latencyMs: 45_000 }, { intents: 1 }),
  g(
    "21-slow-downstream-deadline",
    "slow-downstream",
    1,
    { latencyMs: 90_000 },
    { intents: 1 }
  ),
  // F6/F12 — decision races and late decisions
  g(
    "22-decision-race-approve-first",
    "out-of-order-decision",
    1,
    {},
    { intents: 1, variant: "approve-first" }
  ),
  g(
    "23-decision-race-reject-first",
    "out-of-order-decision",
    1,
    {},
    { intents: 1, variant: "reject-first" }
  ),
  g("24-decision-after-timeout", "out-of-order-decision", 1, {}, { intents: 1, variant: "late" }),
];

async function main(): Promise<void> {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const c of CASES) {
    const expected = await replayGolden(c);
    const fixture = { ...c, expected };
    const path = join(GOLDEN_DIR, `${c.id}.json`);
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(
      `golden ${c.id}: ledger=${String(expected.ledgerCount)} attempts=${String(expected.attempts)} events=${String(expected.eventTypes.length)}`
    );
  }
  console.log(`generated ${String(CASES.length)} fixtures in ${GOLDEN_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
