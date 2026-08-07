/**
 * M3 — retries inside one lease (SPEC §5 retry policy + §6 F7).
 * Deterministic: injected TestClock + seeded mulberry32 ⇒ exact delay
 * sequences. Contracts asserted: side-effect counts, delays, states, codes.
 */
import { describe, expect, it } from "vitest";
import { FaultyStore, TestClock, mulberry32 } from "./harness.test-helper.js";
import { MemoryStore } from "./memory-store.js";
import { retryAfterHint } from "./retry.js";
import { createSluice, type SluiceOptions } from "./sluice.js";
import { SluiceError } from "./types.js";

function setup(opts?: Partial<SluiceOptions>) {
  const clock = new TestClock();
  const store = new FaultyStore(new MemoryStore());
  const sluice = createSluice({ store, namespace: "t", owner: "w1", clock, ...opts });
  const ledger: string[] = [];
  return { clock, store, sluice, ledger };
}

function hush(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}

describe("full-jitter exponential backoff — deterministic under a fixed seed", () => {
  it("fixed seed ⇒ the exact delay sequence random()·min(max, base·2^attempt)", async () => {
    const { clock, sluice, ledger } = setup({
      random: mulberry32(42),
      classify: () => "retryable",
    });
    // The same seed reproduces the exact expected delays.
    const expectedRng = mulberry32(42);
    const expected = [
      expectedRng() * Math.min(10_000, 200 * 2 ** 1),
      expectedRng() * Math.min(10_000, 200 * 2 ** 2),
    ];

    const p = sluice.run({ key: "kb" }, () => {
      ledger.push("attempt");
      if (ledger.length < 3) return Promise.reject(new Error("flaky"));
      return Promise.resolve({ ok: true });
    });
    hush(p);
    await clock.advance(1_300); // e1 < 400 and e2 < 800 — comfortably covered

    const outcome = await p;
    expect(outcome.status).toBe("executed");
    expect(ledger).toHaveLength(3); // 3 tries, ONE lease, one terminal record

    const events = await sluice.audit.since({ namespace: "t", seq: 0 });
    const delays = events
      .filter((e) => e.type === "effect.attempt_failed")
      .map((e) => e.data.delayMs);
    expect(delays).toEqual(expected);
    // Only the terminal outcome persisted (SPEC: retries stay inside the lease).
    expect((await sluice.inspect("kb"))?.status).toBe("succeeded");
    expect((await sluice.inspect("kb"))?.attempt).toBe(1); // claims, not retries
  });

  it("exhausted retries persist ONE failed record with the retryable bit stored", async () => {
    const { clock, sluice, ledger } = setup({
      random: mulberry32(1),
      classify: () => "retryable",
    });
    const p = sluice.run({ key: "kx" }, () => {
      ledger.push("attempt");
      return Promise.reject(new Error("always down"));
    });
    hush(p);
    await clock.advance(2_000);
    await expect(p).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });
    expect(ledger).toHaveLength(3); // maxAttempts default 3
    const record = await sluice.inspect("kx");
    expect(record?.status).toBe("failed");
    expect(record?.error?.retryable).toBe(true); // the last error WAS retryable

    // Replays as the recorded failure — no fourth attempt, ever.
    await expect(
      sluice.run({ key: "kx" }, () => {
        ledger.push("attempt");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });
    expect(ledger).toHaveLength(3);
  });
});

describe("Retry-After honouring (SPEC §5)", () => {
  it("a seconds value is honoured verbatim — no jitter", async () => {
    const { clock, sluice, ledger } = setup({ classify: () => "retryable" });
    const p = sluice.run({ key: "kra" }, () => {
      ledger.push("attempt");
      if (ledger.length === 1) {
        return Promise.reject(Object.assign(new Error("throttled"), { retryAfter: 2 }));
      }
      return Promise.resolve({ ok: true });
    });
    hush(p);
    await clock.advance(2_000);
    await expect(p).resolves.toMatchObject({ status: "executed" });
    const events = await sluice.audit.since({ namespace: "t", seq: 0 });
    const failed = events.find((e) => e.type === "effect.attempt_failed");
    expect(failed?.data.delayMs).toBe(2_000); // exactly, not jittered
    expect(failed?.data.retryAfter).toBe("2");
  });

  it("an HTTP-date header is parsed relative to the injected clock", async () => {
    const { clock, sluice, ledger } = setup({ classify: () => "retryable" });
    const p = sluice.run({ key: "krd" }, () => {
      ledger.push("attempt");
      if (ledger.length === 1) {
        return Promise.reject(
          Object.assign(new Error("throttled"), {
            headers: { "Retry-After": "Thu, 01 Jan 1970 00:00:05 GMT" }, // epoch+5s
          })
        );
      }
      return Promise.resolve({ ok: true });
    });
    hush(p);
    await clock.advance(5_000);
    await expect(p).resolves.toMatchObject({ status: "executed" });
    const events = await sluice.audit.since({ namespace: "t", seq: 0 });
    expect(events.find((e) => e.type === "effect.attempt_failed")?.data.delayMs).toBe(5_000);
  });

  it("beyond maxRetryAfterMs (60s) the call fails FAST with the header surfaced", async () => {
    const { sluice, ledger } = setup({ classify: () => "retryable" });
    const err: unknown = await sluice
      .run({ key: "krc" }, () => {
        ledger.push("attempt");
        return Promise.reject(Object.assign(new Error("throttled hard"), { retryAfter: 3_600 }));
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SluiceError);
    expect(err).toMatchObject({ code: "E_EFFECT_FAILED" });
    expect((err as SluiceError).context).toMatchObject({
      retryAfter: "3600",
      retryAfterMs: 3_600_000,
    });
    expect(ledger).toHaveLength(1); // no retry, no sleep
    expect((await sluice.inspect("krc"))?.status).toBe("failed");
  });
});

describe("deadline bounds the whole run including retries", () => {
  it("a retry that cannot fit before the deadline is E_DEADLINE on a failed record", async () => {
    const { sluice, ledger } = setup({ classify: () => "retryable" });
    await expect(
      sluice.run({ key: "kd", deadlineMs: 500 }, () => {
        ledger.push("attempt");
        return Promise.reject(Object.assign(new Error("slow down"), { retryAfter: 1 }));
      })
    ).rejects.toMatchObject({ code: "E_DEADLINE" });
    expect(ledger).toHaveLength(1);
    // Between attempts nothing was in flight: provably failed, NOT indeterminate.
    const record = await sluice.inspect("kd");
    expect(record?.status).toBe("failed");
    expect(record?.error?.code).toBe("E_DEADLINE");
  });
});

describe("F7 — retry budget caps amplification at ~10% of calls", () => {
  it("exhaustion is an immediate E_RETRY_BUDGET fast-fail, and amplification stays ≤ 1.5", async () => {
    const { sluice, ledger } = setup({
      classify: () => "retryable",
      circuit: false, // isolate the budget from the breaker
      retry: { maxAttempts: 2, baseDelayMs: 0 }, // zero delay ⇒ no clock choreography
    });

    const codes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const err: unknown = await sluice
        .run({ key: `call-${String(i)}`, circuitKey: "svc" }, () => {
          ledger.push("attempt");
          return Promise.reject(new Error("downstream down"));
        })
        .catch((e: unknown) => e);
      codes.push((err as { code: string }).code);
    }

    const budgetFails = codes.filter((c) => c === "E_RETRY_BUDGET").length;
    const exhaustedRetries = codes.filter((c) => c === "E_EFFECT_FAILED").length;
    expect(budgetFails).toBeGreaterThan(0); // the storm was actually throttled
    expect(budgetFails + exhaustedRetries).toBe(20); // every call failed fast, typed
    // THE published number: downstream attempts / logical calls ≤ 1.5 (I6).
    expect(ledger.length / 20).toBeLessThanOrEqual(1.5);
    // Deterministic exact shape: initial 3-token allowance + 10% deposits.
    expect(ledger).toHaveLength(25);
    expect(budgetFails).toBe(15);

    const events = await sluice.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(events.filter((e) => e.type === "retry.budget_exhausted")).toHaveLength(15);
  });
});

describe("retryAfterHint parsing", () => {
  it("recognizes numbers, numeric strings, HTTP-dates, and Headers-like bags", () => {
    expect(retryAfterHint({ retryAfter: 3 }, 0)).toEqual({ ms: 3_000, raw: "3" });
    expect(retryAfterHint({ retryAfter: "7" }, 0)).toEqual({ ms: 7_000, raw: "7" });
    expect(
      retryAfterHint({ headers: { "retry-after": "Thu, 01 Jan 1970 00:00:10 GMT" } }, 2_000)
    ).toEqual({ ms: 8_000, raw: "Thu, 01 Jan 1970 00:00:10 GMT" });
    const bag = new Map<string, string>([["retry-after", "4"]]);
    expect(retryAfterHint({ headers: bag }, 0)).toEqual({ ms: 4_000, raw: "4" });
    expect(retryAfterHint(new Error("plain"), 0)).toBeNull();
    expect(retryAfterHint({ retryAfter: "soonish" }, 0)).toBeNull();
    expect(retryAfterHint(null, 0)).toBeNull();
  });
});
