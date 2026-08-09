/**
 * runStoreConformance — the SluiceStore contract suite (SPEC §5): the same
 * cases run against MemoryStore today and the Postgres store at M6, and they
 * are THE contract for any future adapter. Framework-free by design: cases
 * assert with plain throws and the runner returns a report, so the suite
 * works under Vitest, node:test, or a bare script without importing any
 * test framework into shipping code.
 *
 * Isomorphic-pure: no node builtins.
 */

import { SluiceError, type GateRecord, type SluiceStore } from "@jamessuuu/sluice";

export interface ConformanceFailure {
  name: string;
  message: string;
}

export interface ConformanceReport {
  passed: number;
  failed: ConformanceFailure[];
  total: number;
}

function ensure(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  // (JSON.stringify of an undefined input yields runtime undefined; template
  // interpolation renders it as "undefined", which is exactly the message we
  // want in that case.)
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

/**
 * Like `eq`, but for a field the `SluiceStore` interface declares `number`:
 * asserts `actual` is actually typeof "number" BEFORE falling through to
 * `eq`'s value check. `eq` alone happens to catch a store that returns a
 * numeric-looking string too — `JSON.stringify("30100") !== JSON.stringify
 * (30100)` — but only as an incidental side effect of the message being
 * comparable, and only on the exact field/case pairs a case bothers to
 * check with `eq`. This is the real assertion for that failure mode: it
 * names the mismatch as a TYPE error, not a value diff, and (paired with
 * `assertNumericFields`/`assertNullableNumericFields` below) is meant to be
 * used everywhere a `SluiceStore` implementation hands back one of its
 * `number`-typed fields — on every backend this suite runs against
 * (MemoryStore, pglite, and the real-Postgres path in store.real.test.ts).
 * This is exactly the gate that would have caught the Postgres adapter
 * returning `bigint` (int8) columns as strings from node-postgres.
 */
function eqNumber(actual: unknown, expected: number, msg: string): void {
  ensure(
    typeof actual === "number",
    `${msg}: expected a number (${String(expected)}), got ${typeof actual} (${JSON.stringify(actual)})`
  );
  eq(actual, expected, msg);
}

/** Every named field of `record` must be typeof "number" — see `eqNumber`. */
function assertNumericFields<T extends object>(
  record: T,
  fields: readonly (keyof T)[],
  msg: string
): void {
  for (const f of fields) {
    const v: unknown = record[f];
    ensure(
      typeof v === "number",
      `${msg}: ${String(f)} must be a number, got ${typeof v} (${JSON.stringify(v)})`
    );
  }
}

/** Every named field of `record` must be `null` or typeof "number" — see `eqNumber`. */
function assertNullableNumericFields<T extends object>(
  record: T,
  fields: readonly (keyof T)[],
  msg: string
): void {
  for (const f of fields) {
    const v: unknown = record[f];
    ensure(
      v === null || typeof v === "number",
      `${msg}: ${String(f)} must be a number or null, got ${typeof v} (${JSON.stringify(v)})`
    );
  }
}

function gateCandidate(o: {
  id: string;
  namespace?: string;
  key: string;
  now: number;
  timeoutMs?: number;
  onTimeout?: "reject" | "approve";
}): GateRecord {
  return {
    id: o.id,
    namespace: o.namespace ?? "conf",
    key: o.key,
    status: "pending",
    action: { kind: "conformance" },
    presentation: null,
    requester: { actor: "suite", runId: null },
    approvers: [],
    onTimeout: o.onTimeout ?? "reject",
    resumeContext: null,
    createdAt: o.now,
    expiresAt: o.now + (o.timeoutMs ?? 60_000),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    tokenHash: null,
    tokenNonce: null,
    claimOwner: null,
    claimExpiresAt: null,
    processedAt: null,
  };
}

const CLAIM = {
  namespace: "conf",
  key: "k1",
  fingerprint: "fp-1",
  leaseOwner: "w1",
  leaseMs: 30_000,
  retentionMs: 604_800_000,
};

interface Case {
  name: string;
  run: (store: SluiceStore) => Promise<void>;
}

const CASES: Case[] = [
  {
    name: "claimEffect: a new key is claimed as in_flight, attempt 1, fingerprint stored",
    run: async (s) => {
      const r = await s.claimEffect({ ...CLAIM, now: 100 });
      eq(r.outcome, "claimed", "outcome");
      eq(r.record.status, "in_flight", "status");
      eq(r.record.attempt, 1, "attempt");
      eq(r.record.fingerprint, "fp-1", "fingerprint");
      eq(r.record.leaseOwner, "w1", "leaseOwner");
      eqNumber(r.record.leaseExpiresAt, 30_100, "leaseExpiresAt");
    },
  },
  {
    name: "claimEffect: a live lease is not stolen — duplicate claim gets 'exists'",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      const r = await s.claimEffect({ ...CLAIM, leaseOwner: "w2", now: 200 });
      eq(r.outcome, "exists", "outcome");
      eq(r.record.status, "in_flight", "status");
      eq(r.record.leaseOwner, "w1", "the original owner keeps the lease");
    },
  },
  {
    name: "claimEffect: an expired in_flight lease transitions to indeterminate (never a silent re-claim)",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      const r = await s.claimEffect({ ...CLAIM, leaseOwner: "w2", now: 40_000 });
      eq(r.outcome, "exists", "outcome");
      eq(r.record.status, "indeterminate", "status");
      eq(r.expired, true, "expired flag (the discoverer emits the audit event)");
      eq(r.record.leaseOwner, null, "lease released");
    },
  },
  {
    name: "claimEffect: reclaimIndeterminate re-claims an indeterminate record with attempt+1",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      await s.claimEffect({ ...CLAIM, leaseOwner: "w2", now: 40_000 }); // expire -> indeterminate
      const r = await s.claimEffect({
        ...CLAIM,
        leaseOwner: "w2",
        now: 40_100,
        reclaimIndeterminate: true,
      });
      eq(r.outcome, "claimed", "outcome");
      eq(r.record.status, "in_flight", "status");
      eq(r.record.attempt, 2, "attempt counts claims, not retries");
      eq(r.record.leaseOwner, "w2", "new owner");
    },
  },
  {
    name: "completeEffect: persists the terminal state and releases the lease",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      const r = await s.completeEffect({
        namespace: "conf",
        key: "k1",
        leaseOwner: "w1",
        status: "succeeded",
        result: { receipt: "r-1" },
        now: 200,
      });
      eq(r.status, "succeeded", "status");
      eq(r.result, { receipt: "r-1" }, "result");
      eq(r.leaseOwner, null, "lease released");
      const read = await s.readEffect("conf", "k1");
      eq(read?.status, "succeeded", "readEffect sees the terminal record");
    },
  },
  {
    name: "completeEffect: a stale owner may not write — throws E_LEASE_LOST (I8)",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      await s.claimEffect({ ...CLAIM, leaseOwner: "w2", now: 40_000 }); // expired -> indeterminate
      let code = "none";
      try {
        await s.completeEffect({
          namespace: "conf",
          key: "k1",
          leaseOwner: "w1",
          status: "succeeded",
          result: null,
          now: 40_100,
        });
      } catch (err) {
        code = err instanceof SluiceError ? err.code : "not-a-sluice-error";
      }
      eq(code, "E_LEASE_LOST", "stale terminal write is refused");
      const read = await s.readEffect("conf", "k1");
      eq(read?.status, "indeterminate", "record unchanged");
    },
  },
  {
    name: "claimEffect: a terminal record is returned as 'exists' for replay",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      await s.completeEffect({
        namespace: "conf",
        key: "k1",
        leaseOwner: "w1",
        status: "succeeded",
        result: 42,
        now: 200,
      });
      const r = await s.claimEffect({ ...CLAIM, leaseOwner: "w3", now: 300 });
      eq(r.outcome, "exists", "outcome");
      eq(r.record.status, "succeeded", "status");
      eq(r.record.result, 42, "cached result replayable");
    },
  },
  {
    name: "heartbeatEffect: extends a held lease; reports ok:false once the lease is gone",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, now: 100 });
      const beat = await s.heartbeatEffect({
        namespace: "conf",
        key: "k1",
        leaseOwner: "w1",
        leaseMs: 30_000,
        now: 10_000,
      });
      eq(beat.ok, true, "held lease extends");
      const read = await s.readEffect("conf", "k1");
      eqNumber(read?.leaseExpiresAt, 40_000, "lease horizon moved");
      const stale = await s.heartbeatEffect({
        namespace: "conf",
        key: "k1",
        leaseOwner: "w9",
        leaseMs: 30_000,
        now: 10_050,
      });
      eq(stale.ok, false, "a non-owner cannot heartbeat");
    },
  },
  {
    name: "readEffect: null for a missing record",
    run: async (s) => {
      eq(await s.readEffect("conf", "missing"), null, "missing record");
    },
  },
  {
    name: "openGate: idempotent on (namespace, key) — the second open returns the first row",
    run: async (s) => {
      const a = await s.openGate(gateCandidate({ id: "g-1", key: "gk", now: 100 }));
      eq(a.created, true, "first open creates");
      const b = await s.openGate(gateCandidate({ id: "g-2", key: "gk", now: 200 }));
      eq(b.created, false, "second open does not create");
      eq(b.record.id, "g-1", "the existing gate is returned");
    },
  },
  {
    name: "decideGate: first writer wins; the second decide returns the recorded decision (F6)",
    run: async (s) => {
      await s.openGate(gateCandidate({ id: "g-1", key: "gk", now: 100 }));
      const first = await s.decideGate({
        id: "g-1",
        status: "approved",
        decidedBy: "h1",
        reason: null,
        tokenHash: null,
        tokenNonce: null,
        now: 200,
      });
      eq(first.applied, true, "first decide applies");
      const second = await s.decideGate({
        id: "g-1",
        status: "rejected",
        decidedBy: "h2",
        reason: null,
        tokenHash: null,
        tokenNonce: null,
        now: 300,
      });
      eq(second.applied, false, "second decide does not apply");
      eq(second.record?.status, "approved", "the recorded decision is returned, not an error");
      eq(second.record?.decidedBy, "h1", "first writer's identity is kept");
    },
  },
  {
    name: "expireGates: pending gates past expiry resolve per onTimeout (F12)",
    run: async (s) => {
      await s.openGate(gateCandidate({ id: "g-r", key: "gr", now: 100, timeoutMs: 1_000 }));
      await s.openGate(
        gateCandidate({ id: "g-a", key: "ga", now: 100, timeoutMs: 1_000, onTimeout: "approve" })
      );
      const transitioned = await s.expireGates(2_000);
      eq(transitioned.length, 2, "both expired gates transition");
      const reject = await s.readGate("g-r");
      const approve = await s.readGate("g-a");
      eq(reject?.status, "timed_out", "default reject resolves to timed_out (fail closed)");
      eq(approve?.status, "approved", "explicit onTimeout approve auto-approves");
      eqNumber(reject?.decidedAt, 1_100, "decidedAt is the timeout horizon");
    },
  },
  {
    name: "claimDecidedGates + ackGate: leased resume, crash-safe re-lease, conditional ack (F5)",
    run: async (s) => {
      await s.openGate(gateCandidate({ id: "g-1", key: "gk", now: 100 }));
      await s.decideGate({
        id: "g-1",
        status: "approved",
        decidedBy: "h1",
        reason: null,
        tokenHash: null,
        tokenNonce: null,
        now: 200,
      });
      const first = await s.claimDecidedGates({ owner: "r1", leaseMs: 10_000, limit: 10, now: 300 });
      eq(first.length, 1, "decided gate is claimable");
      const blocked = await s.claimDecidedGates({ owner: "r2", leaseMs: 10_000, limit: 10, now: 400 });
      eq(blocked.length, 0, "a live claim blocks other resumers");
      const staleAck = await s.ackGate({ id: "g-1", owner: "r2", now: 500 });
      eq(staleAck, false, "ack is conditional on holding the claim");
      const release = await s.claimDecidedGates({
        owner: "r2",
        leaseMs: 10_000,
        limit: 10,
        now: 11_000,
      });
      eq(release.length, 1, "an expired claim is re-leasable (dead resumer)");
      const ack = await s.ackGate({ id: "g-1", owner: "r2", now: 11_100 });
      eq(ack, true, "the claim holder acks");
      const done = await s.claimDecidedGates({ owner: "r3", leaseMs: 10_000, limit: 10, now: 30_000 });
      eq(done.length, 0, "a processed gate is never re-claimed");
    },
  },
  {
    name: "listGates: filters by namespace and status",
    run: async (s) => {
      await s.openGate(gateCandidate({ id: "g-1", key: "a", now: 100 }));
      await s.openGate(gateCandidate({ id: "g-2", key: "b", now: 200 }));
      await s.decideGate({
        id: "g-2",
        status: "approved",
        decidedBy: "h",
        reason: null,
        tokenHash: null,
        tokenNonce: null,
        now: 300,
      });
      const pending = await s.listGates({ namespace: "conf", status: "pending" });
      eq(pending.length, 1, "one pending gate");
      eq(pending[0]?.id, "g-1", "the pending one");
    },
  },
  {
    name: "writeCircuit: CAS create-iff-absent and version-checked update",
    run: async (s) => {
      const base = {
        key: "conf:down",
        state: "closed" as const,
        window: [1, 0],
        openedAt: null,
        openMs: null,
        consecutiveOpens: 0,
        halfOpenOwner: null,
        halfOpenExpiresAt: null,
        updatedAt: 100,
      };
      const created = await s.writeCircuit(base, null);
      eq(created.ok, true, "create when absent");
      const dupCreate = await s.writeCircuit(base, null);
      eq(dupCreate.ok, false, "create fails when present");
      const v = created.record?.version ?? -1;
      const updated = await s.writeCircuit({ ...base, updatedAt: 200 }, v);
      eq(updated.ok, true, "matching version updates");
      const stale = await s.writeCircuit({ ...base, updatedAt: 300 }, v);
      eq(stale.ok, false, "stale version is refused (single half-open probe depends on this)");
      eq(await s.readCircuit("conf:missing"), null, "missing circuit reads null");
    },
  },
  {
    name: "appendEvents/readEvents: monotonic per-namespace seq, since-cursor reads",
    run: async (s) => {
      const base = {
        namespace: "conf",
        ts: 100,
        subjectType: "effect" as const,
        subjectKey: "k1",
        type: "effect.claimed" as const,
        attempt: 1,
        actor: "w1",
        data: {},
      };
      const [a] = await s.appendEvents([base]);
      const [b] = await s.appendEvents([{ ...base, type: "effect.succeeded" }]);
      const [other] = await s.appendEvents([{ ...base, namespace: "conf2" }]);
      eqNumber(a?.seq, 1, "first event seq 1");
      eqNumber(b?.seq, 2, "second event seq 2");
      eqNumber(other?.seq, 1, "namespaces have independent cursors");
      const since = await s.readEvents("conf", 1, 100);
      eq(since.length, 1, "since-cursor returns later events only");
      eq(since[0]?.type, "effect.succeeded", "the later event");
    },
  },
  {
    name: "sweep: removes expired terminal effects, never an in_flight record",
    run: async (s) => {
      await s.claimEffect({ ...CLAIM, retentionMs: 1_000, now: 100 });
      await s.completeEffect({
        namespace: "conf",
        key: "k1",
        leaseOwner: "w1",
        status: "succeeded",
        result: null,
        now: 200,
      });
      await s.claimEffect({ ...CLAIM, key: "k2", retentionMs: 1_000, now: 100 });
      const swept = await s.sweep(5_000);
      eq(swept.effects, 1, "one expired terminal effect swept");
      eq(await s.readEffect("conf", "k1"), null, "terminal record gone");
      const inFlight = await s.readEffect("conf", "k2");
      eq(inFlight?.status, "in_flight", "in_flight survives the sweep");
    },
  },
  {
    // A dedicated sweep across every `number`-typed field the SPEC's schema
    // backs with a `bigint`/int8 column (SPEC §3, schema.ts) — not just the
    // handful individual cases above happen to check with `eq`/`eqNumber`.
    // An adapter that returns a numeric-looking STRING for any of these
    // (e.g. a node-postgres-backed store whose row mapping forgot to coerce
    // one bigint column) fails here even if no other case's literal value
    // happens to touch that exact field.
    name: "numeric-typed fields: every declared-number column is a JS number, never a string (bigint/int8 coercion gate)",
    run: async (s) => {
      const claim = await s.claimEffect({ ...CLAIM, now: 100 });
      assertNumericFields(claim.record, ["attempt", "createdAt", "updatedAt", "expiresAt"], "claimEffect record");
      assertNullableNumericFields(claim.record, ["leaseExpiresAt"], "claimEffect record");

      const completed = await s.completeEffect({
        namespace: "conf",
        key: "k1",
        leaseOwner: "w1",
        status: "succeeded",
        result: null,
        now: 200,
      });
      assertNumericFields(completed, ["createdAt", "updatedAt", "expiresAt"], "completeEffect record");
      assertNullableNumericFields(completed, ["leaseExpiresAt"], "completeEffect record");

      const opened = await s.openGate(gateCandidate({ id: "g-num", key: "gk-num", now: 100 }));
      assertNumericFields(opened.record, ["createdAt", "expiresAt"], "openGate record");
      assertNullableNumericFields(
        opened.record,
        ["decidedAt", "claimExpiresAt", "processedAt"],
        "openGate record"
      );

      const decided = await s.decideGate({
        id: "g-num",
        status: "approved",
        decidedBy: "h",
        reason: null,
        tokenHash: null,
        tokenNonce: null,
        now: 200,
      });
      ensure(decided.record !== null, "decideGate: expected a record back");
      if (decided.record !== null) {
        assertNullableNumericFields(decided.record, ["decidedAt"], "decideGate record");
      }

      const claimed = await s.claimDecidedGates({ owner: "r1", leaseMs: 10_000, limit: 10, now: 300 });
      ensure(claimed[0] !== undefined, "claimDecidedGates: expected the decided gate to be claimable");
      const claimedGate = claimed[0];
      if (claimedGate !== undefined) {
        assertNumericFields(claimedGate, ["claimExpiresAt"], "claimDecidedGates record");
      }

      const circuit = await s.writeCircuit(
        {
          key: "conf:numeric-gate",
          state: "closed",
          window: [],
          openedAt: null,
          openMs: null,
          consecutiveOpens: 0,
          halfOpenOwner: null,
          halfOpenExpiresAt: null,
          updatedAt: 100,
        },
        null
      );
      ensure(circuit.record !== null, "writeCircuit: expected a record back");
      if (circuit.record !== null) {
        assertNumericFields(circuit.record, ["version", "updatedAt"], "writeCircuit record");
        assertNullableNumericFields(
          circuit.record,
          ["openedAt", "openMs", "halfOpenExpiresAt"],
          "writeCircuit record"
        );
      }

      const [evt] = await s.appendEvents([
        {
          namespace: "conf",
          ts: 100,
          subjectType: "effect",
          subjectKey: "k1",
          type: "effect.claimed",
          attempt: 1,
          actor: "w1",
          data: {},
        },
      ]);
      ensure(evt !== undefined, "appendEvents: expected an event back");
      if (evt !== undefined) {
        assertNumericFields(evt, ["seq", "ts"], "appendEvents record");
      }
    },
  },
];

/**
 * Run the contract suite against a fresh store per case. Returns a report;
 * callers assert `report.failed` is empty.
 */
export async function runStoreConformance(
  makeStore: () => SluiceStore | Promise<SluiceStore>
): Promise<ConformanceReport> {
  ensure(typeof makeStore === "function", "runStoreConformance requires a store factory");
  const failed: ConformanceFailure[] = [];
  let passed = 0;
  for (const c of CASES) {
    const store = await makeStore();
    try {
      await c.run(store);
      passed++;
    } catch (err) {
      failed.push({ name: c.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { passed, failed, total: CASES.length };
}
