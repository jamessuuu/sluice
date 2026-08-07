/**
 * M2 — failure semantics (SPEC §6: F2, F3, F4, F9, F11 + the error taxonomy).
 * Every test asserts the CONTRACT: side-effect counts, terminal states, error
 * codes — never implementation details.
 */
import { describe, expect, it } from "vitest";
import { FaultyStore, TestClock } from "./harness.test-helper.js";
import { MemoryStore } from "./memory-store.js";
import { createSluice, type SluiceOptions } from "./sluice.js";
import { Indeterminate } from "./types.js";

function setup(opts?: Partial<SluiceOptions>) {
  const clock = new TestClock();
  const store = new FaultyStore(new MemoryStore());
  const mk = (owner: string, extra?: Partial<SluiceOptions>) =>
    createSluice({ store, namespace: "t", owner, clock, ...opts, ...extra });
  const w1 = mk("w1");
  const w2 = mk("w2");
  /** The observable side-effect ledger — what the contracts are measured against. */
  const ledger: string[] = [];
  return { clock, store, mk, w1, w2, ledger };
}

/** Attach a rejection handler now so a mid-advance rejection is never unhandled. */
function hush(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}

describe("F3 — crash after the side effect, before the result persisted", () => {
  it("parks the effect as indeterminate; a later delivery fails closed and never re-executes", async () => {
    const { clock, store, w1, w2, ledger } = setup();
    store.kill("completeEffect"); // the terminal write never lands = the crash

    await expect(
      w1.run({ key: "k3", leaseMs: 300 }, () => {
        ledger.push("charge made");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_STORE", indeterminate: true, retryable: false });
    expect(ledger).toHaveLength(1); // the side effect DID happen

    store.revive("completeEffect");
    await clock.advance(301); // lease expires

    // Next delivery discovers the expired lease: indeterminate, NOT a re-claim.
    await expect(
      w2.run({ key: "k3" }, () => {
        ledger.push("charge made");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_INDETERMINATE", indeterminate: true });
    expect(ledger).toHaveLength(1); // never reported success, never re-executed

    const record = await w2.inspect("k3");
    expect(record?.status).toBe("indeterminate");
    expect(record?.error?.code).toBe("E_LEASE_LOST");

    // I7: the transition has a matching terminal audit event.
    const events = await w2.audit.since({ namespace: "t", seq: 0 });
    expect(
      events.some(
        (e) => e.type === "effect.indeterminate" && e.data.reason === "lease_expired"
      )
    ).toBe(true);
  });
});

describe("F4 — crash before the side effect", () => {
  it("is indistinguishable from F3: fail closed by default, re-execute only via explicit reclaim", async () => {
    const { clock, store, w2, ledger } = setup();
    // w1 claimed and the process died before running anything.
    await store.claimEffect({
      namespace: "t",
      key: "k4",
      fingerprint: null,
      leaseOwner: "w1",
      leaseMs: 300,
      retentionMs: 60_000,
      now: clock.now(),
    });
    await clock.advance(301);

    // Default policy: E_INDETERMINATE, no execution.
    await expect(
      w2.run({ key: "k4" }, () => {
        ledger.push("sent");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_INDETERMINATE" });
    expect(ledger).toHaveLength(0);

    // 'reclaim' is the explicit opt-in (caller declared downstream idempotent):
    // a NEW claim on the indeterminate record, and execution happens.
    const outcome = await w2.run({ key: "k4", onIndeterminate: "reclaim" }, () => {
      ledger.push("sent");
      return Promise.resolve({ receipt: "r-1" });
    });
    expect(outcome.status).toBe("executed");
    if (outcome.status === "executed") expect(outcome.attempts).toBe(2); // claims, not retries
    expect(ledger).toEqual(["sent"]);
    expect((await w2.inspect("k4"))?.status).toBe("succeeded");
  });

  it("onIndeterminate:'gate' is E_CONFIG until gates land (M4)", async () => {
    const { w1 } = setup();
    await expect(
      w1.run({ key: "kg", onIndeterminate: "gate" }, () => Promise.resolve(null))
    ).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});

describe("classify — caller-declared error semantics (F2)", () => {
  const classify = (err: unknown) =>
    err instanceof Error && err.message === "socket timeout" ? "indeterminate" : "failed";

  it("'indeterminate' classification parks the record and fails closed", async () => {
    const { w1, w2, ledger } = setup({ classify });
    await expect(
      w1.run({ key: "kc1" }, () => {
        ledger.push("maybe");
        return Promise.reject(new Error("socket timeout"));
      })
    ).rejects.toMatchObject({ code: "E_INDETERMINATE", indeterminate: true });
    expect((await w1.inspect("kc1"))?.status).toBe("indeterminate");

    // And it stays closed for the next delivery.
    await expect(
      w2.run({ key: "kc1" }, () => {
        ledger.push("maybe");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_INDETERMINATE" });
    expect(ledger).toHaveLength(1);
  });

  it("'failed' classification records a provable failure that replays as the typed error", async () => {
    const { w1, w2 } = setup({ classify });
    await expect(
      w1.run({ key: "kc2" }, () => Promise.reject(new Error("card declined")))
    ).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });
    expect((await w1.inspect("kc2"))?.status).toBe("failed");
    await expect(
      w2.run({ key: "kc2" }, () => Promise.resolve({ ok: true }))
    ).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });
  });

  it("Indeterminate always wins — classify cannot downgrade the explicit wrapper", async () => {
    const { w1 } = setup({ classify: () => "failed" });
    await expect(
      w1.run({ key: "kc3" }, () => Promise.reject(new Indeterminate(new Error("sent?"))))
    ).rejects.toMatchObject({ code: "E_INDETERMINATE" });
    expect((await w1.inspect("kc3"))?.status).toBe("indeterminate");
  });
});

describe("lease heartbeat — leaseMs/3 keeps a slow effect owned (SPEC §5)", () => {
  it("an effect outliving its lease still completes exactly once; a duplicate waits and replays", async () => {
    const { clock, w1, w2, ledger } = setup();

    const p1 = w1.run({ key: "kh", leaseMs: 300, deadlineMs: 5_000 }, async () => {
      ledger.push("slow effect");
      await clock.sleep(900); // 3× the lease — only heartbeats keep it alive
      return { ok: true };
    });
    hush(p1);

    await clock.advance(500); // past the original lease expiry (t=300)

    // The duplicate must find a LIVE lease (not an expired one): it waits.
    const p2 = w2.run({ key: "kh", leaseMs: 300, deadlineMs: 5_000 }, () => {
      ledger.push("duplicate");
      return Promise.resolve({ ok: true });
    });
    hush(p2);

    await clock.advance(600); // effect finishes at t=900; waiter observes it
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.status).toBe("executed");
    expect(o2.status).toBe("replayed");
    expect(ledger).toEqual(["slow effect"]); // exactly once (I1)
    expect((await w1.inspect("kh"))?.attempt).toBe(1); // never reclaimed
  });

  it("a lost lease aborts the effect's signal and the run fails closed", async () => {
    const { clock, store, w1 } = setup();
    store.denyHeartbeats = true; // the store says: you no longer own this

    const p = w1.run({ key: "kl", leaseMs: 300 }, async (ctx) => {
      await clock.sleep(1_000, ctx.signal);
      return { ok: true };
    });
    hush(p);

    await clock.advance(100); // first heartbeat → lease reported lost → abort
    await expect(p).rejects.toMatchObject({ code: "E_INDETERMINATE", indeterminate: true });
    const record = await w1.inspect("kl");
    expect(record?.status).toBe("indeterminate");
    expect(record?.error?.code).toBe("E_LEASE_LOST");
  });

  it("F8/I8 — a stale owner cannot overwrite a terminal state: E_LEASE_LOST, state is monotonic", async () => {
    const { clock, store, w1, w2, ledger } = setup();
    store.kill("heartbeatEffect"); // heartbeats silently fail: worker is partitioned

    const p1 = w1.run({ key: "ks", leaseMs: 300, deadlineMs: 5_000 }, async () => {
      ledger.push("partitioned effect");
      await clock.sleep(1_000); // ignores its signal, finishes late
      return { ok: true };
    });
    hush(p1);

    await clock.advance(400); // lease expired at t=300
    await expect(
      w2.run({ key: "ks" }, () => Promise.resolve({ ok: true }))
    ).rejects.toMatchObject({ code: "E_INDETERMINATE" });

    await clock.advance(700); // t=1100: the stale worker finally "succeeds"
    await expect(p1).rejects.toMatchObject({ code: "E_LEASE_LOST", indeterminate: true });
    expect(ledger).toHaveLength(1);
    // The stale success write did NOT land: terminal states are monotonic.
    expect((await w2.inspect("ks"))?.status).toBe("indeterminate");
  });
});

describe("F11 — store unavailable", () => {
  it("before the claim: E_STORE retryable, and fn is NEVER executed", async () => {
    const { store, w1, ledger } = setup();
    store.kill("claimEffect");
    await expect(
      w1.run({ key: "k11" }, () => {
        ledger.push("must not run");
        return Promise.resolve(null);
      })
    ).rejects.toMatchObject({ code: "E_STORE", retryable: true, indeterminate: false });
    expect(ledger).toHaveLength(0);
  });

  it("never surfaces the driver error itself — always the typed E_STORE", async () => {
    const { store, w1 } = setup();
    store.kill("claimEffect");
    const err = await w1.run({ key: "k11b" }, () => Promise.resolve(null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("ECONNRESET");
  });
});

describe("deadline during execution is a timeout, and a timeout is indeterminate (F2)", () => {
  it("aborts ctx.signal and parks the record as indeterminate — never 'failed'", async () => {
    const { clock, w1, ledger } = setup();
    const p = w1.run({ key: "kd", deadlineMs: 200 }, async (ctx) => {
      ledger.push("request sent");
      await clock.sleep(10_000, ctx.signal);
      return { ok: true };
    });
    hush(p);
    await clock.advance(200);
    await expect(p).rejects.toMatchObject({ code: "E_INDETERMINATE", indeterminate: true });
    const record = await w1.inspect("kd");
    expect(record?.status).toBe("indeterminate");
    expect(record?.error?.code).toBe("E_DEADLINE");
    expect(ledger).toHaveLength(1);
  });
});

describe("F1 under contention — waiting is bounded by the deadline", () => {
  it("a waiter that outlives its deadline gets E_WAIT_TIMEOUT (retryable), not a hang", async () => {
    const { clock, w1, w2 } = setup();
    const p1 = w1.run({ key: "kw", leaseMs: 10_000, deadlineMs: 10_000 }, async () => {
      await clock.sleep(5_000);
      return { ok: true };
    });
    hush(p1);
    const p2 = w2.run({ key: "kw", deadlineMs: 200 }, () => Promise.resolve({ ok: true }));
    hush(p2);
    await clock.advance(250);
    await expect(p2).rejects.toMatchObject({ code: "E_WAIT_TIMEOUT", retryable: true });
    await clock.advance(4_800);
    await expect(p1).resolves.toMatchObject({ status: "executed" });
  });
});
