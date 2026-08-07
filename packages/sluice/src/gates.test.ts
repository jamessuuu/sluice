/**
 * M4 — gates (SPEC §3 sluice_gate, §5 gates API, §6 F5/F6/F12 + F2 'gate').
 * Contracts asserted: side-effect counts, gate states, error codes, audit
 * events — never implementation details.
 */
import { describe, expect, it } from "vitest";
import { FaultyStore, TestClock, mulberry32 } from "./harness.test-helper.js";
import { MemoryStore } from "./memory-store.js";
import { sha256Hex } from "./sha256.js";
import { createSluice, type SluiceOptions } from "./sluice.js";
import { SluiceError, type GateSpec } from "./types.js";

function setup(opts?: Partial<SluiceOptions>) {
  const clock = new TestClock();
  const store = new FaultyStore(new MemoryStore());
  let seed = 100;
  const mk = (owner: string, extra?: Partial<SluiceOptions>) =>
    createSluice({
      store,
      namespace: "t",
      owner,
      clock,
      random: mulberry32(seed++),
      approvalSecret: "hold-the-door",
      ...opts,
      ...extra,
    });
  const s1 = mk("w1");
  const ledger: string[] = [];
  return { clock, store, mk, s1, ledger };
}

function gateSpec(key: string, over?: Partial<GateSpec>): GateSpec {
  return {
    key,
    action: { kind: "publish", tool: "publish_post", args: { draftId: "d1" } },
    requester: { actor: "agent:dogwatch", runId: "run-1" },
    timeoutMs: 60_000,
    ...over,
  };
}

function hush(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}

describe("gates.open — idempotent on (namespace, key)", () => {
  it("a second open returns the SAME gate; gate.opened is recorded once", async () => {
    const { s1 } = setup();
    const a = await s1.gates.open(gateSpec("g1", { resumeContext: { step: 3 } }));
    const b = await s1.gates.open(gateSpec("g1"));
    expect(a.status).toBe("pending");
    expect(b.id).toBe(a.id);
    expect(b.resumeContext).toEqual({ step: 3 }); // the original row, verbatim
    const events = await s1.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(events.filter((e) => e.type === "gate.opened")).toHaveLength(1);
  });

  it("timeoutMs is REQUIRED — there is no unbounded gate", async () => {
    const { s1 } = setup();
    await expect(s1.gates.open(gateSpec("g2", { timeoutMs: 0 }))).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    await expect(s1.gates.open(gateSpec("g3", { timeoutMs: Number.NaN }))).rejects.toMatchObject({
      code: "E_CONFIG",
    });
  });

  it("resumeContext beyond 32 KiB is E_RESULT_TOO_LARGE", async () => {
    const { s1 } = setup();
    await expect(
      s1.gates.open(gateSpec("g4", { resumeContext: { blob: "x".repeat(33_000) } }))
    ).rejects.toMatchObject({ code: "E_RESULT_TOO_LARGE" });
  });
});

describe("F6 — double decision / approve-reject race", () => {
  it("first writer wins; the second call gets the RECORDED decision, not an error", async () => {
    const { s1 } = setup();
    const g = await s1.gates.open(gateSpec("g6"));
    const first = await s1.gates.decide({ id: g.id, decision: "approve", decidedBy: "alice" });
    expect(first.status).toBe("approved");

    const second = await s1.gates.decide({
      id: g.id,
      decision: "reject",
      decidedBy: "bob",
      reason: "too risky",
    });
    expect(second.status).toBe("approved"); // the recorded decision
    expect(second.decidedBy).toBe("alice"); // bob did not overwrite anything

    // Audit records BOTH attempts (F6).
    const events = await s1.audit.since({ namespace: "t", seq: 0 }, 500);
    const decided = events.filter((e) => e.type === "gate.decided");
    expect(decided).toHaveLength(2);
    expect(decided.map((e) => e.data.applied)).toEqual([true, false]);
  });

  it("a concurrent approve/reject race applies exactly one decision", async () => {
    const { s1, mk } = setup();
    const s2 = mk("w2");
    const g = await s1.gates.open(gateSpec("g6r"));
    const [a, b] = await Promise.all([
      s1.gates.decide({ id: g.id, decision: "approve", decidedBy: "alice" }),
      s2.gates.decide({ id: g.id, decision: "reject", decidedBy: "bob" }),
    ]);
    expect(a.status).toBe(b.status); // both callers converge on ONE recorded decision
    const events = await s1.audit.since({ namespace: "t", seq: 0 }, 500);
    const applied = events.filter((e) => e.type === "gate.decided" && e.data.applied === true);
    expect(applied).toHaveLength(1);
  });
});

describe("F5 — crash mid-gate, resume in a NEW process, exactly once", () => {
  it("gate + resumeContext survive; leased claims survive a claimant crash; post-decision work runs once", async () => {
    const { clock, mk, ledger } = setup();
    const s1 = mk("proc-1");

    // Process 1 opens the gate and dies.
    const g = await s1.gates.open(
      gateSpec("publish-42", { resumeContext: { draftId: "d42", step: "publish" } })
    );
    // An approver decides — from anywhere; the row is durable.
    await s1.gates.decide({ id: g.id, decision: "approve", decidedBy: "james" });

    // Process 2 (fresh) claims the decided gate...
    const s2 = mk("proc-2");
    const claims2 = await s2.gates.claimDecided();
    expect(claims2).toHaveLength(1);
    expect(claims2[0]?.gate.resumeContext).toEqual({ draftId: "d42", step: "publish" });
    // ...and crashes mid-processing (no ack). The claim lease expires:
    await clock.advance(30_001);

    // Process 3 claims it again — a dead claimant never strands a gate.
    const s3 = mk("proc-3");
    const claims3 = await s3.gates.claimDecided();
    expect(claims3).toHaveLength(1);
    const claim = claims3[0];
    if (claim === undefined) throw new Error("unreachable");

    // Post-decision work goes through run(), so resumption is exactly-once
    // even if BOTH processes end up doing it (I5).
    const doPublish = (s: ReturnType<typeof mk>) =>
      s.run({ key: `post:${claim.gate.id}` }, () => {
        ledger.push("published");
        return Promise.resolve({ ok: true });
      });
    await expect(doPublish(s3)).resolves.toMatchObject({ status: "executed" });
    await expect(doPublish(s2)).resolves.toMatchObject({ status: "replayed" }); // zombie retries
    expect(ledger).toHaveLength(1);

    await claim.ack();
    expect(await s3.gates.claimDecided()).toHaveLength(0); // processed — never re-delivered

    // The zombie's stale ack is refused: it no longer holds the claim.
    await expect(claims2[0]?.ack()).rejects.toMatchObject({ code: "E_LEASE_LOST" });

    const events = await s3.audit.since({ namespace: "t", seq: 0 }, 500);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "gate.claimed")).toHaveLength(2);
    expect(types.filter((t) => t === "gate.resumed")).toHaveLength(1);
  });
});

describe("F12 — gate timeout (fail closed by default)", () => {
  it("an expired gate resolves to timed_out on ANY read, and a late decision loses", async () => {
    const { clock, s1 } = setup();
    const g = await s1.gates.open(gateSpec("slow", { timeoutMs: 500 }));
    await clock.advance(501);

    const read = await s1.gates.get(g.id);
    expect(read?.status).toBe("timed_out"); // lazy resolution on read
    expect(read?.decidedBy).toBe("sluice:timeout");

    const late = await s1.gates.decide({ id: g.id, decision: "approve", decidedBy: "alice" });
    expect(late.status).toBe("timed_out"); // the timeout already won

    const events = await s1.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(events.some((e) => e.type === "gate.timed_out")).toBe(true);
  });

  it("sweepTimeouts resolves every expired pending gate", async () => {
    const { clock, s1 } = setup();
    await s1.gates.open(gateSpec("t1", { timeoutMs: 300 }));
    await s1.gates.open(gateSpec("t2", { timeoutMs: 400 }));
    await s1.gates.open(gateSpec("t3", { timeoutMs: 99_000 })); // not expired
    await clock.advance(500);
    expect(await s1.gates.sweepTimeouts()).toBe(2);
    expect(await s1.gates.pending()).toHaveLength(1);
  });

  it("onTimeout:'approve' is the explicit opt-in: auto-approves and becomes claimable", async () => {
    const { clock, s1 } = setup();
    const g = await s1.gates.open(gateSpec("auto", { timeoutMs: 300, onTimeout: "approve" }));
    await clock.advance(301);
    const read = await s1.gates.get(g.id);
    expect(read?.status).toBe("approved");
    expect(read?.decidedBy).toBe("sluice:timeout");
    const claims = await s1.gates.claimDecided();
    expect(claims.map((c) => c.gate.id)).toContain(g.id);
  });

  it("sluice.gate() sugar throws E_GATE_TIMEOUT", async () => {
    const { clock, s1 } = setup();
    const p = s1.gate(gateSpec("sugar-t", { timeoutMs: 1_000 }));
    hush(p);
    await clock.advance(1_000);
    await expect(p).rejects.toMatchObject({ code: "E_GATE_TIMEOUT" });
  });
});

describe("sluice.gate() sugar — open + waitFor", () => {
  it("resolves once approved, with the poll loop on the injected clock", async () => {
    const { clock, s1, mk } = setup();
    const approver = mk("approver");
    const p = s1.gate(gateSpec("sugar-a", { timeoutMs: 600_000 }));
    hush(p);
    await clock.advance(2_500); // a couple of poll cycles pass while pending
    const pending = await approver.gates.pending();
    expect(pending.map((g) => g.key)).toContain("sugar-a");
    await approver.gates.decide({
      id: pending.find((g) => g.key === "sugar-a")?.id ?? "",
      decision: "approve",
      decidedBy: "james",
    });
    await clock.advance(5_000); // next poll observes the decision
    const record = await p;
    expect(record.status).toBe("approved");
    expect(record.decidedBy).toBe("james");
  });

  it("throws E_GATE_REJECTED on rejection", async () => {
    const { clock, s1 } = setup();
    const p = s1.gate(gateSpec("sugar-r", { timeoutMs: 600_000 }));
    hush(p);
    await clock.advance(100);
    const opened = await s1.gates.pending();
    await s1.gates.decide({
      id: opened.find((g) => g.key === "sugar-r")?.id ?? "",
      decision: "reject",
      decidedBy: "james",
      reason: "not today",
    });
    await clock.advance(2_000);
    await expect(p).rejects.toMatchObject({ code: "E_GATE_REJECTED" });
  });

  it("waitFor with maxWaitMs surfaces E_WAIT_TIMEOUT while the gate stays pending", async () => {
    const { clock, s1 } = setup();
    const g = await s1.gates.open(gateSpec("waity", { timeoutMs: 600_000 }));
    const p = s1.gates.waitFor(g.id, { maxWaitMs: 3_000 });
    hush(p);
    await clock.advance(4_000);
    await expect(p).rejects.toMatchObject({ code: "E_WAIT_TIMEOUT" });
    expect((await s1.gates.get(g.id))?.status).toBe("pending"); // the gate itself is untouched
  });
});

describe("approval tokens — single-use HMAC-SHA256 (SPEC §5 auth model)", () => {
  it("a minted token decides without a session; the nonce is burned with the decision", async () => {
    const { s1 } = setup();
    const g = await s1.gates.open(gateSpec("tok"));
    const token = s1.gates.mintToken(g.id);
    const decided = await s1.gates.decide({
      id: g.id,
      decision: "approve",
      decidedBy: "email:james",
      token,
    });
    expect(decided.status).toBe("approved");
    expect(decided.tokenHash).toBe(sha256Hex(token));
    expect(decided.tokenNonce).not.toBeNull(); // burned by the SAME conditional update

    // Replaying the link is idempotent — the recorded decision, no second write.
    const replay = await s1.gates.decide({
      id: g.id,
      decision: "reject",
      decidedBy: "email:mallory",
      token,
    });
    expect(replay.status).toBe("approved");
    const events = await s1.audit.since({ namespace: "t", seq: 0 }, 500);
    expect(
      events.filter((e) => e.type === "gate.decided" && e.data.applied === true)
    ).toHaveLength(1);
  });

  it("E_BAD_TOKEN on tampering, expiry, wrong gate, and garbage — never which check failed", async () => {
    const { clock, s1 } = setup();
    const g1 = await s1.gates.open(gateSpec("tok-1"));
    const g2 = await s1.gates.open(gateSpec("tok-2"));

    const tampered = `${s1.gates.mintToken(g1.id).slice(0, -2)}zz`;
    await expect(
      s1.gates.decide({ id: g1.id, decision: "approve", decidedBy: "x", token: tampered })
    ).rejects.toMatchObject({ code: "E_BAD_TOKEN" });

    const short = s1.gates.mintToken(g1.id, { ttlMs: 1_000 });
    await clock.advance(1_001);
    await expect(
      s1.gates.decide({ id: g1.id, decision: "approve", decidedBy: "x", token: short })
    ).rejects.toMatchObject({ code: "E_BAD_TOKEN" });

    const wrongGate = s1.gates.mintToken(g1.id);
    await expect(
      s1.gates.decide({ id: g2.id, decision: "approve", decidedBy: "x", token: wrongGate })
    ).rejects.toMatchObject({ code: "E_BAD_TOKEN" });

    await expect(
      s1.gates.decide({ id: g1.id, decision: "approve", decidedBy: "x", token: "garbage" })
    ).rejects.toMatchObject({ code: "E_BAD_TOKEN" });

    // A failed token never decides anything.
    expect((await s1.gates.get(g1.id))?.status).toBe("pending");
  });

  it("minting without approvalSecret is E_CONFIG", async () => {
    const { store, clock } = setup();
    const bare = createSluice({
      store,
      namespace: "t",
      owner: "w9",
      clock,
      random: mulberry32(500),
    });
    const g = await bare.gates.open(gateSpec("tok-3"));
    expect(() => bare.gates.mintToken(g.id)).toThrow(SluiceError);
    expect(() => bare.gates.mintToken(g.id)).toThrow(/approvalSecret/);
  });
});

describe("F2 — onIndeterminate:'gate' wires the \"did this land?\" gate", () => {
  it("requires the gate spec at config time", async () => {
    const { s1 } = setup();
    await expect(
      s1.run({ key: "k", onIndeterminate: "gate" }, () => Promise.resolve(null))
    ).rejects.toMatchObject({ code: "E_CONFIG" });
  });

  it("opens the gate idempotently and STILL fails closed with the gate id surfaced", async () => {
    const { clock, store, mk, ledger } = setup();
    // A worker claimed and died: the record goes indeterminate on next claim.
    await store.claimEffect({
      namespace: "t",
      key: "charge-9",
      fingerprint: null,
      leaseOwner: "dead-worker",
      leaseMs: 300,
      retentionMs: 60_000,
      now: clock.now(),
    });
    await clock.advance(301);

    const s2 = mk("proc-2");
    const spec = {
      key: "charge-9",
      onIndeterminate: "gate" as const,
      gate: gateSpec("gate:charge-9", {
        action: { kind: "confirm-landed", args: { key: "charge-9" } },
      }),
    };
    const attempt = () =>
      s2.run(spec, () => {
        ledger.push("charged");
        return Promise.resolve({ ok: true });
      });

    const err1: unknown = await attempt().catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(SluiceError);
    expect(err1).toMatchObject({ code: "E_INDETERMINATE", indeterminate: true });
    const gateId = (err1 as SluiceError).context.gateId;
    expect(typeof gateId).toBe("string");
    expect(ledger).toHaveLength(0); // fail closed — nothing executed

    // Re-delivery: the SAME gate (idempotent open), still failing closed.
    const err2: unknown = await attempt().catch((e: unknown) => e);
    expect((err2 as SluiceError).context.gateId).toBe(gateId);
    expect(await s2.gates.pending()).toHaveLength(1);
    expect(ledger).toHaveLength(0);

    // The human answers; a resumer picks the decision up out-of-band.
    await s2.gates.decide({ id: gateId as string, decision: "approve", decidedBy: "james" });
    const claims = await s2.gates.claimDecided();
    expect(claims.map((c) => c.gate.key)).toContain("gate:charge-9");
  });
});
