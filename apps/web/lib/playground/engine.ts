/**
 * The playground's simulation core (SPEC §9): the REAL @jamessuuu/sluice
 * core + MemoryStore, running against the testkit's FakeTransport /
 * FaultPlan / VirtualClock / CrashController — the same primitives the
 * chaos harness itself uses (packages/sluice-testkit/src/scenarios.ts). This
 * module is isomorphic-pure (no DOM, no node builtins) so it runs unchanged
 * inside the Web Worker (worker.ts) and would run identically in a Vitest
 * test if one were needed.
 *
 * Side by side, per intent: a "naive" delivery (direct transport calls,
 * retry-on-any-failure up to 3x — the anti-pattern, mirroring
 * sluice-testkit's naive.ts) and a "sluice" delivery (through
 * `sluice.run()`), sharing the same seeded FaultPlan so both sides see an
 * identical fault schedule — the only variable is whether sluice is in the
 * loop.
 */
import {
  createSluice,
  MemoryStore,
  SluiceError,
  type EffectContext,
  type Json,
  type Sluice,
} from "@jamessuuu/sluice";
import {
  chaosClassify,
  CrashController,
  FakeTransport,
  FaultPlan,
  VirtualClock,
} from "@jamessuuu/sluice-testkit";
import type {
  IntentResult,
  LedgerRow,
  PlaygroundParams,
  PlaygroundTotals,
  WorkerResponse,
} from "./protocol";

const NAMESPACE = "playground";
const NAIVE_MAX_ATTEMPTS = 3;
const NAIVE_BACKOFF_MS = 100;
const LEASE_MS = 30_000;
/** Crash roughly one delivery in four when the crash toggle is on. */
const CRASH_EVERY = 4;

async function naiveDeliver(
  transport: FakeTransport,
  clock: VirtualClock,
  intent: string
): Promise<void> {
  for (let attempt = 1; attempt <= NAIVE_MAX_ATTEMPTS; attempt++) {
    try {
      await transport.call(intent);
      return;
    } catch {
      // The naive bug in one line (mirrors sluice-testkit/naive.ts): a
      // timeout and an error look the same, so an effect that landed gets
      // fired again.
      if (attempt < NAIVE_MAX_ATTEMPTS) await clock.sleep(NAIVE_BACKOFF_MS);
    }
  }
}

async function attemptRun(
  sluice: Sluice,
  key: string,
  fn: (ctx: EffectContext) => Promise<Json>
): Promise<string> {
  try {
    const r = await sluice.run({ key, fingerprint: { intent: key } }, fn);
    return r.status;
  } catch (err) {
    return err instanceof SluiceError ? err.code : "error";
  }
}

function deliverySpecFor(duplicateRate: number): number | [number, number] {
  if (duplicateRate <= 0) return 1;
  const spread = Math.max(1, Math.round(duplicateRate * 4));
  return [1, 1 + spread];
}

export async function runPlayground(
  params: PlaygroundParams,
  onEvent: (e: WorkerResponse) => void
): Promise<void> {
  try {
    const { seed, intents, duplicateRate, timeoutRate, errorRate, crashEnabled } = params;
    const planSpec = { deliveries: deliverySpecFor(duplicateRate), errorRate, timeoutRate };

    const naiveClock = new VirtualClock();
    const naivePlan = new FaultPlan(seed, planSpec);
    const naiveTransport = new FakeTransport(naiveClock, naivePlan);

    const sluiceClock = new VirtualClock();
    // Same seed + spec as naivePlan: FaultPlan draws are a pure function of
    // (seed, label), so both sides see an identical fault schedule per
    // (intent, attempt) — a fair side-by-side, not a coincidence.
    const sluicePlan = new FaultPlan(seed, planSpec);
    const sluiceTransport = new FakeTransport(sluiceClock, sluicePlan);
    const store = new MemoryStore();
    const sluice = createSluice({
      store,
      namespace: NAMESPACE,
      owner: "w1",
      clock: sluiceClock,
      random: sluicePlan.stream("jitter"),
      classify: chaosClassify,
    });

    const totals: PlaygroundTotals = {
      intents,
      naiveDuplicates: 0,
      sluiceDuplicates: 0,
      naiveAttempts: 0,
      sluiceAttempts: 0,
    };
    let auditSeq = 0;

    for (let i = 0; i < intents; i++) {
      const intent = `intent-${String(i)}`;
      const deliveries = sluicePlan.deliveriesFor(intent);
      const willCrash = crashEnabled && i % CRASH_EVERY === CRASH_EVERY - 1;

      const naiveAttemptsBefore = naiveTransport.attempts.length;
      const naiveLedgerBefore = naiveTransport.ledger.length;
      await naiveClock.settle(
        Promise.all(
          Array.from({ length: deliveries }, () => naiveDeliver(naiveTransport, naiveClock, intent))
        )
      );

      const sluiceAttemptsBefore = sluiceTransport.attempts.length;
      const sluiceLedgerBefore = sluiceTransport.ledger.length;
      let sluiceOutcome: string;

      if (willCrash) {
        // crash-mid-effect flavor (mirrors scenarios.ts): the side effect
        // lands, the process dies before the terminal write, the lease
        // expires, and a second worker recovers — parked `indeterminate`
        // once, then a fresh claim executes cleanly.
        const crash = new CrashController();
        crash.crashAt({ method: "completeEffect", call: 1, mode: "before" });
        const doomed = createSluice({
          store: crash.wrap(store),
          namespace: NAMESPACE,
          owner: `crashed-${String(i)}`,
          clock: sluiceClock,
          random: sluicePlan.stream(`jitter:${intent}`),
          classify: chaosClassify,
        });
        const abandoned = doomed.run({ key: intent, fingerprint: { intent } }, (ctx) =>
          sluiceTransport.call(intent, { signal: ctx.signal })
        );
        abandoned.catch(() => undefined); // the process died; nothing observes this
        await sluiceClock.settle(crash.whenCrashed);
        await sluiceClock.advance(LEASE_MS + 1);
        sluiceOutcome = await sluiceClock.settle(
          attemptRun(sluice, intent, (ctx) => sluiceTransport.call(intent, { signal: ctx.signal }))
        );
      } else {
        const results = await sluiceClock.settle(
          Promise.all(
            Array.from({ length: deliveries }, () =>
              attemptRun(sluice, intent, (ctx) => sluiceTransport.call(intent, { signal: ctx.signal }))
            )
          )
        );
        sluiceOutcome =
          results.find((s) => s === "executed" || s === "replayed") ?? results[0] ?? "error";
      }

      const naiveLedgerRows: LedgerRow[] = naiveTransport.ledger
        .slice(naiveLedgerBefore)
        .map((e) => ({ side: "naive", intent: e.intent, attempt: e.attempt }));
      const sluiceLedgerRows: LedgerRow[] = sluiceTransport.ledger
        .slice(sluiceLedgerBefore)
        .map((e) => ({ side: "sluice", intent: e.intent, attempt: e.attempt }));

      const naiveLanded = naiveLedgerRows.length;
      const sluiceLanded = sluiceLedgerRows.length;
      totals.naiveDuplicates += Math.max(0, naiveLanded - 1);
      totals.sluiceDuplicates += Math.max(0, sluiceLanded - 1);
      totals.naiveAttempts += naiveTransport.attempts.length - naiveAttemptsBefore;
      totals.sluiceAttempts += sluiceTransport.attempts.length - sluiceAttemptsBefore;

      const events = await store.readEvents(NAMESPACE, auditSeq, 1000);
      const last = events[events.length - 1];
      if (last !== undefined) auditSeq = last.seq;

      const result: IntentResult = {
        intent,
        deliveries,
        naiveLedgerCount: naiveLanded,
        sluiceLedgerCount: sluiceLanded,
        sluiceOutcome,
        crashed: willCrash,
      };

      onEvent({
        kind: "intent",
        result,
        naiveLedger: naiveLedgerRows,
        sluiceLedger: sluiceLedgerRows,
        auditBatch: events.map((e) => ({
          seq: e.seq,
          type: e.type,
          subjectKey: e.subjectKey,
          attempt: e.attempt,
        })),
      });
    }

    onEvent({ kind: "done", totals });
  } catch (err) {
    onEvent({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
