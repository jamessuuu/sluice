/**
 * The detectors must have teeth: a harness that always returns [] is worse
 * than no harness. Feed checkInvariants and StoreMonitor deliberately broken
 * observations and assert they fire.
 */
import { MemoryStore, type EffectRecord, type SluiceStore } from "@jamessuuu/sluice";
import { describe, expect, it } from "vitest";
import { FakeTransport } from "./fake-transport.js";
import { FaultPlan } from "./fault-plan.js";
import { checkInvariants, type DeliveryReport } from "./invariants.js";
import { StoreMonitor } from "./store-monitor.js";
import { VirtualClock } from "./virtual-clock.js";

function ctxFor(o: {
  transport: FakeTransport;
  monitor: StoreMonitor;
  reports: DeliveryReport[];
  intents: string[];
}) {
  return {
    namespace: "chaos",
    transport: o.transport,
    monitor: o.monitor,
    store: o.monitor,
    reports: o.reports,
    events: [],
    intents: o.intents,
    resumeIntents: [],
    amplificationGate: null,
    gateSlackMs: 1_000,
  };
}

function report(intent: string, outcome: DeliveryReport["outcome"]): DeliveryReport {
  return { intent, worker: "w1", outcome, code: null, resultOmitted: false, virtualMs: 0 };
}

function kit() {
  const clock = new VirtualClock();
  const transport = new FakeTransport(clock, new FaultPlan(1, {}));
  const monitor = new StoreMonitor(new MemoryStore());
  return { clock, transport, monitor };
}

describe("checkInvariants detects planted violations", () => {
  it("I1: two ledger entries for one intent", async () => {
    const { transport, monitor } = kit();
    transport.ledger.push({ intent: "i", at: 0, attempt: 1 }, { intent: "i", at: 5, attempt: 2 });
    const v = await checkInvariants(
      ctxFor({ transport, monitor, reports: [report("i", "executed")], intents: ["i"] })
    );
    expect(v.some((x) => x.startsWith("I1:"))).toBe(true);
  });

  it("I2: reported success with an empty ledger (phantom success)", async () => {
    const { transport, monitor } = kit();
    const v = await checkInvariants(
      ctxFor({ transport, monitor, reports: [report("i", "executed")], intents: ["i"] })
    );
    expect(v.some((x) => x.startsWith("I2:"))).toBe(true);
  });

  it("I3: a success report against an indeterminate-parked record", async () => {
    const { transport, monitor } = kit();
    await monitor.claimEffect({
      namespace: "chaos",
      key: "i",
      fingerprint: null,
      leaseOwner: "w1",
      leaseMs: 100,
      retentionMs: 60_000,
      now: 0,
    });
    await monitor.claimEffect({
      namespace: "chaos",
      key: "i",
      fingerprint: null,
      leaseOwner: "w2",
      leaseMs: 100,
      retentionMs: 60_000,
      now: 500, // lease expired -> parked indeterminate
    });
    transport.ledger.push({ intent: "i", at: 0, attempt: 1 });
    const v = await checkInvariants(
      ctxFor({ transport, monitor, reports: [report("i", "executed")], intents: ["i"] })
    );
    expect(v.some((x) => x.startsWith("I3:"))).toBe(true);
  });

  it("I7: a terminal record with no terminal audit event", async () => {
    const { transport, monitor } = kit();
    await monitor.claimEffect({
      namespace: "chaos",
      key: "i",
      fingerprint: null,
      leaseOwner: "w1",
      leaseMs: 30_000,
      retentionMs: 60_000,
      now: 0,
    });
    await monitor.completeEffect({
      namespace: "chaos",
      key: "i",
      leaseOwner: "w1",
      status: "succeeded",
      result: null,
      now: 1,
    });
    transport.ledger.push({ intent: "i", at: 0, attempt: 1 });
    const v = await checkInvariants(
      ctxFor({ transport, monitor, reports: [report("i", "executed")], intents: ["i"] })
    );
    expect(v.some((x) => x.startsWith("I7:"))).toBe(true);
  });
});

describe("StoreMonitor detects I8 breaches live", () => {
  it("flags an effect leaving a terminal state", async () => {
    // A misbehaving store that reports succeeded, then failed, for one key.
    const record = (status: EffectRecord["status"]): EffectRecord => ({
      namespace: "chaos",
      key: "k",
      fingerprint: null,
      status,
      attempt: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: null,
      resultOmitted: false,
      error: null,
      createdAt: 0,
      updatedAt: 0,
      expiresAt: 60_000,
    });
    let flip = false;
    const rogue: SluiceStore = new MemoryStore();
    const monitor = new StoreMonitor({
      ...rogue,
      readEffect: () => {
        flip = !flip;
        return Promise.resolve(record(flip ? "succeeded" : "failed"));
      },
    });
    await monitor.readEffect("chaos", "k");
    await monitor.readEffect("chaos", "k");
    expect(monitor.violations.some((v) => v.startsWith("I8:"))).toBe(true);
  });

  it("allows indeterminate -> in_flight only via an explicit reclaim", async () => {
    const monitor = new StoreMonitor(new MemoryStore());
    const claim = {
      namespace: "chaos",
      key: "k",
      fingerprint: null,
      leaseOwner: "w1",
      leaseMs: 100,
      retentionMs: 60_000,
    };
    await monitor.claimEffect({ ...claim, now: 0 });
    await monitor.claimEffect({ ...claim, leaseOwner: "w2", now: 500 }); // -> indeterminate
    await monitor.claimEffect({ ...claim, leaseOwner: "w2", now: 600, reclaimIndeterminate: true });
    expect(monitor.violations).toEqual([]); // the legal exit
    expect(monitor.reclaimedKeys.size).toBe(1);
  });
});
