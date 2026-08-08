import { describe, expect, it } from "vitest";
import { chainHash, eventPayload, verifyEvents } from "./hash-chain.js";
import { MemoryStore } from "./memory-store.js";
import type { AuditEvent } from "./types.js";

function evt(over: Partial<AuditEvent> = {}): Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash"> {
  return {
    namespace: "ns",
    ts: 1000,
    subjectType: "effect",
    subjectKey: "k1",
    type: "effect.succeeded",
    attempt: 1,
    actor: "tester",
    data: {},
    ...over,
  };
}

describe("chainHash / eventPayload (M9)", () => {
  it("excludes seq from the hashed payload", () => {
    const e = evt();
    const payload = eventPayload(e);
    expect(payload).not.toContain('"seq"');
  });

  it("is a pure function of (prevHash, event content)", () => {
    const e = evt();
    expect(chainHash(null, e)).toBe(chainHash(null, e));
    expect(chainHash("abc", e)).not.toBe(chainHash(null, e));
  });

  it("changes when any field of the event changes", () => {
    const base = chainHash(null, evt());
    expect(chainHash(null, evt({ data: { changed: true } }))).not.toBe(base);
    expect(chainHash(null, evt({ actor: "someone-else" }))).not.toBe(base);
  });
});

describe("MemoryStore.appendEvents — hash chain (M9)", () => {
  it("chains N events with a null genesis prevHash", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) {
      await store.appendEvents([evt({ subjectKey: `k${String(i)}`, data: { i } })]);
    }
    const events = await store.readEvents("ns", 0, 100);
    expect(events).toHaveLength(10);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(events[0]?.prevHash).toBeNull();
    expect(verifyEvents(events, null)).toEqual({ ok: true, checked: 10 });
  });

  it("keeps independent chains per namespace", async () => {
    const store = new MemoryStore();
    for (const ns of ["a", "b"]) {
      for (let i = 0; i < 3; i++) {
        await store.appendEvents([evt({ namespace: ns, subjectKey: `k${String(i)}` })]);
      }
    }
    const a = await store.readEvents("a", 0, 100);
    const b = await store.readEvents("b", 0, 100);
    expect(a[0]?.prevHash).toBeNull();
    expect(b[0]?.prevHash).toBeNull();
    expect(verifyEvents(a)).toEqual({ ok: true, checked: 3 });
    expect(verifyEvents(b)).toEqual({ ok: true, checked: 3 });
  });
});

describe("verifyEvents — pure, store-free (M9 dogwatch addendum)", () => {
  async function chain(n: number): Promise<AuditEvent[]> {
    const store = new MemoryStore();
    for (let i = 0; i < n; i++) {
      await store.appendEvents([evt({ subjectKey: `k${String(i)}`, data: { i } })]);
    }
    return store.readEvents("ns", 0, 100);
  }

  it("verifies an untampered exported slice clean", async () => {
    const events = await chain(8);
    expect(verifyEvents(events)).toEqual({ ok: true, checked: 8 });
  });

  it("detects a tampered event at exactly its index", async () => {
    const events = await chain(8);
    const tamperedIndex = 4;
    const target = events[tamperedIndex];
    if (target === undefined) throw new Error("fixture too short");
    events[tamperedIndex] = { ...target, data: { tampered: true } };
    const result = verifyEvents(events);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(tamperedIndex);
    // Everything strictly before the break still verifies clean on its own.
    expect(verifyEvents(events.slice(0, tamperedIndex))).toEqual({
      ok: true,
      checked: tamperedIndex,
    });
  });

  it("detects a flipped hash byte directly", async () => {
    const events = await chain(5);
    const target = events[2];
    if (target?.hash === undefined || target.hash === null) throw new Error("fixture too short");
    const flippedLastChar = target.hash.endsWith("0") ? "1" : "0";
    events[2] = { ...target, hash: target.hash.slice(0, -1) + flippedLastChar };
    const result = verifyEvents(events);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("empty slice verifies trivially true", () => {
    expect(verifyEvents([])).toEqual({ ok: true, checked: 0 });
  });

  it("without an explicit prevHead, trusts the first event's own prevHash as the anchor", async () => {
    // Simulate a PARTIAL export: events 5..8 of a longer chain (a page).
    const full = await chain(8);
    const page = full.slice(4);
    expect(verifyEvents(page)).toEqual({ ok: true, checked: 4 });
  });

  it("with an explicit prevHead, requires the first event to chain from it", async () => {
    const full = await chain(8);
    const page = full.slice(4);
    const trueAnchor = full[3]?.hash ?? null;
    expect(verifyEvents(page, trueAnchor)).toEqual({ ok: true, checked: 4 });
    // A wrong anchor breaks at index 0, not silently passing.
    const result = verifyEvents(page, "not-the-real-anchor");
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it("explicit prevHead:null demands genesis — rejects a non-genesis slice", async () => {
    const full = await chain(3);
    const page = full.slice(1);
    const result = verifyEvents(page, null);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(0);
  });
});
