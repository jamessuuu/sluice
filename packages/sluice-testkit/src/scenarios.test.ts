/**
 * The 9-scenario taxonomy under unit CI: every scenario × seeds 1–3 must be
 * violation-free (I1–I8 are asserted inside runScenario on every run), plus
 * pointed assertions on each scenario's defining behaviour. The full
 * 10-seed matrix runs in `pnpm chaos` and the eval stage.
 */
import { describe, expect, it } from "vitest";
import { runScenario, SCENARIO_NAMES } from "./scenarios.js";

const SEEDS = [1, 2, 3];

describe("I1-I8 hold for every scenario at every seed", () => {
  for (const scenario of SCENARIO_NAMES) {
    it(`${scenario}: zero invariant violations across seeds ${SEEDS.join(",")}`, { timeout: 60_000 }, async () => {
      for (const seed of SEEDS) {
        const r = await runScenario({ scenario, seed });
        expect(r.violations, `${scenario} seed ${String(seed)}:\n${r.violations.join("\n")}`).toEqual(
          []
        );
      }
    });
  }
});

describe("duplicate-delivery (F1)", () => {
  it("collapses 2-5 concurrent deliveries to one side effect each, replaying the rest", async () => {
    const r = await runScenario({ scenario: "duplicate-delivery", seed: 1 });
    expect(r.ledgerCount).toBe(r.intents);
    expect(r.duplicateEffects).toBe(0);
    expect(r.deliveries).toBeGreaterThan(r.intents);
    for (const report of r.reports) {
      expect(["executed", "replayed"]).toContain(report.outcome);
    }
  });

  it("replays an oversized result as resultOmitted (F10) — still exactly once", async () => {
    const r = await runScenario({
      scenario: "duplicate-delivery",
      seed: 4,
      plan: { deliveries: 3 },
      config: { intents: 1, resultBytes: 2048, maxResultBytes: 1024 },
    });
    expect(r.violations).toEqual([]);
    expect(r.ledgerCount).toBe(1);
    expect(r.reports.some((rep) => rep.outcome === "replayed" && rep.resultOmitted)).toBe(true);
  });
});

describe("timeout-then-success (F2)", () => {
  it("parks landed-but-timed-out effects indeterminate; never success, never re-executed", async () => {
    const r = await runScenario({ scenario: "timeout-then-success", seed: 1 });
    expect(r.ledgerCount).toBe(r.intents); // each landed exactly once downstream
    for (const report of r.reports) {
      expect(report.outcome).toBe("error");
      expect(report.code).toBe("E_INDETERMINATE");
    }
    for (const [key, status] of Object.entries(r.finalStatuses)) {
      if (key.startsWith("effect:")) expect(status).toBe("indeterminate");
    }
  });
});

describe("crash-mid-effect (F3)", () => {
  it("expired lease resolves to indeterminate — ledger stays at 1, fail closed", async () => {
    const r = await runScenario({ scenario: "crash-mid-effect", seed: 1, config: { intents: 2 } });
    expect(r.ledgerCount).toBe(2); // the effect DID land before each crash
    expect(r.reports.every((rep) => rep.code === "E_INDETERMINATE")).toBe(true);
  });
});

describe("crash-before-effect (F4)", () => {
  it("default policy: nothing landed, still fails closed (F3 and F4 are indistinguishable)", async () => {
    const r = await runScenario({ scenario: "crash-before-effect", seed: 1, config: { intents: 2 } });
    expect(r.ledgerCount).toBe(0);
    expect(r.reports.every((rep) => rep.code === "E_INDETERMINATE")).toBe(true);
  });

  it("explicit reclaim re-executes exactly once", async () => {
    const r = await runScenario({
      scenario: "crash-before-effect",
      seed: 2,
      config: { intents: 1, variant: "reclaim" },
    });
    expect(r.violations).toEqual([]);
    expect(r.ledgerCount).toBe(1);
    expect(r.finalStatuses["effect:intent-0"]).toBe("succeeded");
  });

  it("'gate' opens the did-this-land gate and resumes via claimDecided", async () => {
    const r = await runScenario({
      scenario: "crash-before-effect",
      seed: 3,
      config: { intents: 1, variant: "gate" },
    });
    expect(r.violations).toEqual([]);
    expect(r.finalStatuses["gate:did-land-intent-0"]).toBe("approved");
    expect(r.finalStatuses["effect:intent-0"]).toBe("indeterminate"); // the human answered; sluice never re-fired
    expect(r.ledgerCount).toBe(0);
  });
});

describe("crash-mid-gate (F5 / I5)", () => {
  it("post-decision work lands exactly once across crashed resumers", async () => {
    const r = await runScenario({
      scenario: "crash-mid-gate",
      seed: 1,
      plan: { crashes: 2 },
      config: { intents: 1 },
    });
    expect(r.violations).toEqual([]);
    expect(r.ledgerCount).toBe(1);
    expect(r.finalStatuses["gate:gate-intent-0"]).toBe("approved");
    expect(r.finalStatuses["effect:resume-intent-0"]).toBe("succeeded");
    const outcomes = r.reports.map((rep) => rep.outcome);
    expect(outcomes).toContain("executed"); // the crashed resumer's work...
    expect(outcomes).toContain("replayed"); // ...replayed, not repeated, by the survivor
  });
});

describe("retry-storm (F7 / I6)", () => {
  it("caps amplification at ≤1.5 under 30% injected failure", { timeout: 60_000 }, async () => {
    let sawRetries = false;
    let sawFastFail = false;
    for (const seed of SEEDS) {
      const r = await runScenario({ scenario: "retry-storm", seed });
      expect(r.amplification).toBeLessThanOrEqual(1.5);
      // Seeds where the breaker trips shed load (attempts < intents); seeds
      // where it stays closed retry within budget (attempts > intents).
      if (r.attempts > r.intents) sawRetries = true;
      if (r.reports.some((rep) => rep.code === "E_RETRY_BUDGET" || rep.code === "E_CIRCUIT_OPEN")) {
        sawFastFail = true;
      }
    }
    expect(sawRetries).toBe(true); // the budget does grant retries...
    expect(sawFastFail).toBe(true); // ...and the storm defence does fast-fail
  });
});

describe("clock-skew (F8)", () => {
  it("within the ceiling (≤ leaseMs/2): duplicates replay, no double execution", async () => {
    const r = await runScenario({
      scenario: "clock-skew",
      seed: 1,
      config: { intents: 2, variant: "within" },
    });
    expect(r.violations).toEqual([]);
    expect(r.ledgerCount).toBe(2);
    expect(r.reports.filter((rep) => rep.outcome === "replayed")).toHaveLength(2);
  });

  it("beyond the ceiling: fails CLOSED — one execution, zero reported successes", async () => {
    const r = await runScenario({
      scenario: "clock-skew",
      seed: 1,
      config: { intents: 1, variant: "beyond" },
    });
    expect(r.violations).toEqual([]);
    expect(r.ledgerCount).toBe(1); // never a double execution
    expect(r.reports.every((rep) => rep.outcome === "error")).toBe(true);
  });
});

describe("slow-downstream", () => {
  it("deadline-crossing latencies land anyway and are parked indeterminate", async () => {
    const r = await runScenario({ scenario: "slow-downstream", seed: 1 });
    expect(r.violations).toEqual([]);
    expect(r.ledgerCount).toBe(r.intents); // every request eventually landed
    const statuses = Object.entries(r.finalStatuses)
      .filter(([k]) => k.startsWith("effect:"))
      .map(([, v]) => v);
    for (const s of statuses) expect(["succeeded", "indeterminate"]).toContain(s);
  });
});

describe("out-of-order-decision (F6 / F12)", () => {
  it("first writer wins the race; the loser gets the recorded decision", async () => {
    const r = await runScenario({
      scenario: "out-of-order-decision",
      seed: 1,
      config: { intents: 1, variant: "reject-first" },
    });
    expect(r.violations).toEqual([]);
    expect(r.finalStatuses["gate:gate-intent-0"]).toBe("rejected");
    // Both attempts are audited (F6): the applied one and the loser.
    expect(r.eventTypes.filter((t) => t === "gate.decided")).toHaveLength(2);
  });

  it("a decision after the timeout loses to the recorded timeout (F12)", async () => {
    const r = await runScenario({
      scenario: "out-of-order-decision",
      seed: 1,
      config: { intents: 1, variant: "late" },
    });
    expect(r.violations).toEqual([]);
    expect(r.finalStatuses["gate:gate-intent-0"]).toBe("timed_out");
    expect(r.eventTypes).toContain("gate.timed_out");
  });
});
