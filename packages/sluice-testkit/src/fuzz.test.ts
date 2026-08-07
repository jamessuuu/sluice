import { describe, expect, it } from "vitest";
import { fuzzCase, minimizeCase, type FuzzCase } from "./fuzz.js";

describe("fuzzCase", () => {
  it("derives the same case from the same seed (replayable)", () => {
    expect(fuzzCase(7)).toEqual(fuzzCase(7));
    expect(fuzzCase(7)).not.toEqual(fuzzCase(8));
  });

  it("covers multiple scenarios across the seed range", () => {
    const scenarios = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) scenarios.add(fuzzCase(seed).scenario);
    expect(scenarios.size).toBeGreaterThanOrEqual(6);
  });
});

describe("minimizeCase (the auto-minimizer)", () => {
  it("greedily shrinks a failing plan to the smallest still-failing case", async () => {
    const fat: FuzzCase = {
      scenario: "duplicate-delivery",
      seed: 99,
      plan: {
        deliveries: [2, 5],
        errorRate: 0.2,
        timeoutRate: 0.1,
        latencyMs: 400,
      },
      config: { intents: 4, variant: "anything" },
    };
    // Synthetic bug: fails whenever timeoutRate is injected — everything else
    // is noise the minimizer must strip.
    const minimized = await minimizeCase(fat, (c) => Promise.resolve(c.plan.timeoutRate !== undefined));
    expect(minimized.plan.timeoutRate).toBe(0.1); // the culprit survives
    expect(minimized.plan.errorRate).toBeUndefined(); // the noise does not
    expect(minimized.plan.latencyMs).toBeUndefined();
    expect(minimized.plan.deliveries).toBeUndefined();
    expect(minimized.config.intents).toBe(1);
    expect(minimized.config.variant).toBeUndefined();
  });

  it("returns the case unchanged when no simplification still fails", async () => {
    const c = fuzzCase(3);
    const minimized = await minimizeCase(c, (candidate) =>
      // Only the ORIGINAL fails — every simplification "passes".
      Promise.resolve(JSON.stringify(candidate) === JSON.stringify(c))
    );
    expect(minimized).toEqual(c);
  });
});
