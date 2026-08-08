import { describe, expect, it } from "vitest";
import { verifyEvents } from "./hash-chain.js";
import { MemoryStore } from "./memory-store.js";
import { createSluice } from "./sluice.js";

describe("MemoryStore — state snapshot / restore (M9)", () => {
  it("exportState() -> JSON round-trip -> new MemoryStore(state) resumes identically", async () => {
    const store = new MemoryStore();
    const sluice = createSluice({ store, namespace: "resume-test", owner: "w1" });
    await sluice.run({ key: "k1" }, () => Promise.resolve({ ok: true }));
    await sluice.gates.open({
      key: "g1",
      action: { kind: "publish" },
      requester: { actor: "agent" },
      timeoutMs: 60_000,
      resumeContext: { postId: "p1" },
    });

    // The exact hop the /gate demo makes: serialize through JSON (as
    // sessionStorage would), construct a brand-new store from it, and
    // confirm every read matches the pre-serialization store.
    const serialized = JSON.stringify(store.exportState());
    const restored = new MemoryStore(JSON.parse(serialized) as ReturnType<MemoryStore["exportState"]>);

    const effectBefore = await store.readEffect("resume-test", "k1");
    const effectAfter = await restored.readEffect("resume-test", "k1");
    expect(effectAfter).toEqual(effectBefore);

    const gates = await restored.listGates({ namespace: "resume-test" });
    expect(gates).toHaveLength(1);
    expect(gates[0]?.key).toBe("g1");
    expect(gates[0]?.resumeContext).toEqual({ postId: "p1" });

    const events = await restored.readEvents("resume-test", 0, 100);
    expect(events.length).toBeGreaterThan(0);
    expect(verifyEvents(events)).toEqual({ ok: true, checked: events.length });
  });

  it("a restored store continues the hash chain correctly — no genesis reset", async () => {
    const store = new MemoryStore();
    const sluiceA = createSluice({ store, namespace: "chain-resume", owner: "w1" });
    await sluiceA.run({ key: "k1" }, () => Promise.resolve({ ok: true }));

    const restored = new MemoryStore(store.exportState());
    const sluiceB = createSluice({ store: restored, namespace: "chain-resume", owner: "w2" });
    await sluiceB.run({ key: "k2" }, () => Promise.resolve({ ok: true }));

    const events = await restored.readEvents("chain-resume", 0, 100);
    // k1's two events (claimed, succeeded) carried over; k2's two events
    // continue the SAME chain, not a fresh one — genesis prevHash appears
    // exactly once, on event #1.
    expect(events).toHaveLength(4);
    expect(events[0]?.prevHash).toBeNull();
    expect(events.slice(1).every((e) => e.prevHash !== null)).toBe(true);
    expect(verifyEvents(events)).toEqual({ ok: true, checked: 4 });
  });

  it("a fresh MemoryStore() with no state behaves exactly as before (backward compatible)", async () => {
    const store = new MemoryStore();
    expect(await store.readEffect("ns", "missing")).toBeNull();
    expect(store.exportState()).toEqual({
      effects: [],
      circuits: [],
      gates: [],
      gateIds: [],
      events: [],
      seqs: [],
      heads: [],
    });
  });
});
