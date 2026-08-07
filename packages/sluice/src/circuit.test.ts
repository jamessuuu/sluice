/**
 * M3 — circuit breaker (SPEC §5): opens at ≥50% failures with ≥5 samples in a
 * rolling window of 20, jittered open interval doubling on consecutive opens,
 * half-open admits EXACTLY ONE probe (CAS on half_open_owner), and breaker
 * state is read-through cached 1s (eventual consistency stated in the docs).
 */
import { describe, expect, it } from "vitest";
import { TestClock, mulberry32 } from "./harness.test-helper.js";
import { MemoryStore } from "./memory-store.js";
import { createSluice, type Sluice } from "./sluice.js";

function setup(seed = 7) {
  const clock = new TestClock();
  const store = new MemoryStore();
  const mk = (owner: string, s = seed) =>
    createSluice({ store, namespace: "t", owner, clock, random: mulberry32(s) });
  const ledger: string[] = [];
  return { clock, store, mk, ledger };
}

async function failOnce(s: Sluice, key: string, circuitKey: string, ledger: string[]) {
  await expect(
    s.run({ key, circuitKey }, () => {
      ledger.push(key);
      return Promise.reject(new Error("downstream 500"));
    })
  ).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });
}

describe("circuit breaker — opening", () => {
  it("opens at ≥50% failures with ≥5 samples, then fails fast WITHOUT executing", async () => {
    const { store, mk, ledger } = setup();
    const s = mk("w1");

    const ok = await s.run({ key: "ok-1", circuitKey: "pay" }, () => {
      ledger.push("ok-1");
      return Promise.resolve({ receipt: "r1" });
    });
    expect(ok.status).toBe("executed");
    for (let i = 1; i <= 4; i++) await failOnce(s, `f-${String(i)}`, "pay", ledger);
    // window now [ok, f, f, f, f]: 5 samples, 80% failures ⇒ open.
    expect((await store.readCircuit("t:pay"))?.state).toBe("open");

    await expect(
      s.run({ key: "f-5", circuitKey: "pay" }, () => {
        ledger.push("f-5");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_CIRCUIT_OPEN", retryable: true });
    expect(ledger).toHaveLength(5); // f-5 never executed — that is the contract

    const events = await s.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(events.some((e) => e.type === "circuit.opened")).toBe(true);
  });

  it("an open circuit still replays a recorded success (protects downstream, not the ledger)", async () => {
    const { mk, ledger } = setup();
    const s = mk("w1");
    await s.run({ key: "ok-1", circuitKey: "pay" }, () => {
      ledger.push("ok-1");
      return Promise.resolve({ receipt: "r1" });
    });
    for (let i = 1; i <= 4; i++) await failOnce(s, `f-${String(i)}`, "pay", ledger);

    const replay = await s.run({ key: "ok-1", circuitKey: "pay" }, () => {
      ledger.push("must not run");
      return Promise.resolve({ receipt: "other" });
    });
    expect(replay.status).toBe("replayed");
    if (replay.status === "replayed" && !("resultOmitted" in replay)) {
      expect(replay.value).toEqual({ receipt: "r1" });
    }
    expect(ledger).toHaveLength(5);
  });
});

describe("circuit breaker — half-open", () => {
  it("admits EXACTLY ONE probe; a successful probe closes the circuit", async () => {
    const { clock, store, mk, ledger } = setup();
    const s = mk("w1");
    for (let i = 1; i <= 5; i++) await failOnce(s, `f-${String(i)}`, "pay", ledger);
    const opened = await store.readCircuit("t:pay");
    expect(opened?.state).toBe("open");
    const openMs = opened?.openMs ?? 0;
    // ±20% jitter around the 30s base.
    expect(openMs).toBeGreaterThanOrEqual(24_000);
    expect(openMs).toBeLessThanOrEqual(36_000);

    await clock.advance(openMs + 1);

    // Two concurrent calls race for the single probe slot.
    const results = await Promise.allSettled([
      s.run({ key: "p-1", circuitKey: "pay" }, () => {
        ledger.push("p-1");
        return Promise.resolve({ ok: true });
      }),
      s.run({ key: "p-2", circuitKey: "pay" }, () => {
        ledger.push("p-2");
        return Promise.resolve({ ok: true });
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // exactly one probe executed
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "E_CIRCUIT_OPEN" });
    expect(ledger).toHaveLength(6); // 5 failures + 1 probe

    const closed = await store.readCircuit("t:pay");
    expect(closed?.state).toBe("closed");
    const events = await s.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(events.some((e) => e.type === "circuit.half_open")).toBe(true);
    expect(events.some((e) => e.type === "circuit.closed")).toBe(true);
  });

  it("a failed probe re-opens with a DOUBLED (jittered) interval", async () => {
    const { clock, store, mk, ledger } = setup();
    const s = mk("w1");
    for (let i = 1; i <= 5; i++) await failOnce(s, `f-${String(i)}`, "pay", ledger);
    const first = await store.readCircuit("t:pay");
    await clock.advance((first?.openMs ?? 0) + 1);

    await failOnce(s, "probe-1", "pay", ledger); // the probe itself fails

    const reopened = await store.readCircuit("t:pay");
    expect(reopened?.state).toBe("open");
    expect(reopened?.consecutiveOpens).toBe(2);
    // Doubled base 60s, ±20% jitter.
    expect(reopened?.openMs ?? 0).toBeGreaterThanOrEqual(48_000);
    expect(reopened?.openMs ?? 0).toBeLessThanOrEqual(72_000);
    const events = await s.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(
      events.some((e) => e.type === "circuit.opened" && e.data.reason === "probe_failed")
    ).toBe(true);
  });
});

describe("circuit breaker — cross-instance sharing", () => {
  it("is eventually consistent within the 1s read-through cache (documented ceiling)", async () => {
    const { clock, mk, ledger } = setup();
    const a = mk("worker-a", 3);
    const b = mk("worker-b", 4);

    // A warms its cache on a healthy circuit.
    await a.run({ key: "warm", circuitKey: "pay" }, () => {
      ledger.push("warm");
      return Promise.resolve({ ok: true });
    });
    // B trips the breaker (A's success + 4 failures = 5 samples at 80%).
    for (let i = 1; i <= 4; i++) await failOnce(b, `f-${String(i)}`, "pay", ledger);

    // Within the cache TTL, A's stale CLOSED view still admits (≤1s staleness).
    await clock.advance(500);
    const stale = await a.run({ key: "stale-admit", circuitKey: "pay" }, () => {
      ledger.push("stale-admit");
      return Promise.resolve({ ok: true });
    });
    expect(stale.status).toBe("executed");

    // Once the cache expires, A converges and fails fast.
    await clock.advance(600);
    await expect(
      a.run({ key: "blocked", circuitKey: "pay" }, () => {
        ledger.push("blocked");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_CIRCUIT_OPEN" });
    expect(ledger).not.toContain("blocked");
  });
});
