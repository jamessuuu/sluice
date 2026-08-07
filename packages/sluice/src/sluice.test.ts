import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";
import { createSluice, idempotencyKey } from "./sluice.js";
import { Indeterminate, SluiceError } from "./types.js";

function setup() {
  const store = new MemoryStore();
  const sluice = createSluice({ store, namespace: "test", owner: "worker-1" });
  /** The observable side-effect ledger — what exactly-once is measured against. */
  const ledger: string[] = [];
  return { store, sluice, ledger };
}

describe("run() — the walking skeleton (M1)", () => {
  it("F1: five concurrent duplicate deliveries produce exactly ONE side effect", async () => {
    const { sluice, ledger } = setup();
    const spec = { key: idempotencyKey({ tool: "send_email", to: "a@b.c" }) };

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        sluice.run(spec, async () => {
          ledger.push("email sent");
          // Hold the effect open long enough that the other four arrive
          // while it is in_flight and must take the wait-then-replay path.
          await new Promise((r) => setTimeout(r, 50));
          return { messageId: "m-1" };
        })
      )
    );

    expect(ledger).toHaveLength(1); // the invariant that matters (I1)
    const executed = outcomes.filter((o) => o.status === "executed");
    const replayed = outcomes.filter((o) => o.status === "replayed");
    expect(executed).toHaveLength(1);
    expect(replayed).toHaveLength(4);
    for (const o of outcomes) {
      expect(o.status === "executed" || !("resultOmitted" in o) ? o.value : null).toEqual({
        messageId: "m-1",
      });
    }
  });

  it("replays a succeeded effect on later delivery (no second execution)", async () => {
    const { sluice, ledger } = setup();
    const spec = { key: "k1" };
    const first = await sluice.run(spec, () => {
      ledger.push("charge");
      return Promise.resolve({ chargeId: "c-1" });
    });
    const second = await sluice.run(spec, () => {
      ledger.push("charge");
      return Promise.resolve({ chargeId: "c-2" });
    });
    expect(ledger).toEqual(["charge"]);
    expect(first.status).toBe("executed");
    expect(second.status).toBe("replayed");
    if (second.status === "replayed" && !("resultOmitted" in second)) {
      expect(second.value).toEqual({ chargeId: "c-1" });
    }
  });

  it("replays a FAILED effect as the recorded typed error — never re-executes", async () => {
    const { sluice, ledger } = setup();
    const spec = { key: "k-fail" };
    await expect(
      sluice.run(spec, () => {
        ledger.push("attempt");
        return Promise.reject(new Error("card declined"));
      })
    ).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });

    await expect(
      sluice.run(spec, () => {
        ledger.push("attempt");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_EFFECT_FAILED" });
    expect(ledger).toHaveLength(1);
  });

  it("F2/F3 fail-closed: Indeterminate is never success and never re-executed", async () => {
    const { sluice, ledger } = setup();
    const spec = { key: "k-indet" };
    await expect(
      sluice.run(spec, () => {
        ledger.push("maybe-sent");
        return Promise.reject(new Indeterminate(new Error("socket closed after send")));
      })
    ).rejects.toMatchObject({ code: "E_INDETERMINATE", indeterminate: true });

    // Default policy: a later delivery must NOT re-execute (that is how a
    // charge gets made twice); it must surface E_INDETERMINATE again.
    await expect(
      sluice.run(spec, () => {
        ledger.push("maybe-sent");
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: "E_INDETERMINATE" });
    expect(ledger).toHaveLength(1);
  });

  it("F9: same key + different fingerprint is a loud conflict, not a silent replay", async () => {
    const { sluice } = setup();
    await sluice.run({ key: "k9", fingerprint: { amount: 100 } }, () =>
      Promise.resolve({ ok: true })
    );
    await expect(
      sluice.run({ key: "k9", fingerprint: { amount: 900 } }, () =>
        Promise.resolve({ ok: true })
      )
    ).rejects.toMatchObject({ code: "E_KEY_CONFLICT" });
  });

  it("F10: oversized results replay as resultOmitted, and the type forces handling", async () => {
    const { store } = setup();
    const sluice = createSluice({
      store,
      namespace: "test",
      owner: "worker-1",
      maxResultBytes: 32,
    });
    const spec = { key: "k10" };
    const first = await sluice.run(spec, () =>
      Promise.resolve({ blob: "x".repeat(200) })
    );
    expect(first.status).toBe("executed"); // executor still gets the live value
    const replay = await sluice.run(spec, () => Promise.resolve({ blob: "nope" }));
    expect(replay.status).toBe("replayed");
    expect("resultOmitted" in replay && replay.resultOmitted).toBe(true);
  });

  it("emits an audit trail: claimed → succeeded → replayed", async () => {
    const { sluice } = setup();
    await sluice.run({ key: "k-audit" }, () => Promise.resolve({ ok: true }));
    await sluice.run({ key: "k-audit" }, () => Promise.resolve({ ok: true }));
    const events = await sluice.audit.since({ namespace: "test", seq: 0 });
    const types = events.map((e) => e.type);
    expect(types).toEqual(["effect.claimed", "effect.succeeded", "effect.replayed"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("validates the key (E_CONFIG)", async () => {
    const { sluice } = setup();
    await expect(
      sluice.run({ key: "" }, () => Promise.resolve(null))
    ).rejects.toMatchObject({ code: "E_CONFIG" });
    await expect(
      sluice.run({ key: "x".repeat(201) }, () => Promise.resolve(null))
    ).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});

describe("idempotencyKey", () => {
  it("derives from intent, deterministically, order-independent", () => {
    const a = idempotencyKey({ tool: "send", args: { to: "x" }, runId: "r1" });
    const b = idempotencyKey({ runId: "r1", args: { to: "x" }, tool: "send" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the intent changes", () => {
    expect(idempotencyKey({ tool: "send", to: "x" })).not.toBe(
      idempotencyKey({ tool: "send", to: "y" })
    );
  });
});

describe("SluiceError hygiene", () => {
  it("never carries a stack into stored errors (replay path)", async () => {
    const store = new MemoryStore();
    const sluice = createSluice({ store, namespace: "test" });
    await expect(
      sluice.run({ key: "kh" }, () => Promise.reject(new Error("boom")))
    ).rejects.toBeInstanceOf(SluiceError);
    const record = await sluice.inspect("kh");
    expect(record?.error).toEqual({
      code: "E_EFFECT_FAILED",
      message: "boom",
      retryable: false,
      indeterminate: false,
    });
    // Stored shape is exactly the four fields — no stack, no driver payload.
    expect(Object.keys(record?.error ?? {})).toHaveLength(4);
  });
});
