import { describe, expect, it } from "vitest";
import { FaultPlan, mulberry32 } from "./fault-plan.js";

describe("FaultPlan", () => {
  it("draws are pure functions of (seed, label) — order-independent", () => {
    const a = new FaultPlan(42, { errorRate: 0.5 });
    const b = new FaultPlan(42, { errorRate: 0.5 });
    // Query b in a different order — answers must match a's exactly.
    const bFault2 = b.attemptFault("i", 2);
    const bFault1 = b.attemptFault("i", 1);
    expect(a.attemptFault("i", 1)).toBe(bFault1);
    expect(a.attemptFault("i", 2)).toBe(bFault2);
  });

  it("different seeds give different schedules", () => {
    const faults = (seed: number) => {
      const plan = new FaultPlan(seed, { errorRate: 0.4, timeoutRate: 0.3 });
      let s = "";
      for (let i = 1; i <= 20; i++) s += plan.attemptFault("k", i).charAt(0);
      return s;
    };
    expect(faults(1)).not.toBe(faults(2));
  });

  it("attemptOverrides force the scripted sequence regardless of rates", () => {
    const plan = new FaultPlan(7, { errorRate: 1, attemptOverrides: ["timeout", null, "ok"] });
    expect(plan.attemptFault("k", 1)).toBe("timeout");
    expect(plan.attemptFault("k", 2)).toBe("error"); // null falls through to the rate
    expect(plan.attemptFault("k", 3)).toBe("ok");
  });

  it("deliveriesFor respects exact values and inclusive ranges", () => {
    expect(new FaultPlan(1, { deliveries: 3 }).deliveriesFor("x")).toBe(3);
    const ranged = new FaultPlan(1, { deliveries: [2, 5] });
    for (let i = 0; i < 20; i++) {
      const d = ranged.deliveriesFor(`intent-${String(i)}`);
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThanOrEqual(5);
    }
  });

  it("mulberry32 streams are deterministic and in [0, 1)", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
