/**
 * Shared test infrastructure for the unit suites (M2+). The `.test-helper.ts`
 * suffix keeps this out of the published build (tsconfig.build.json excludes
 * it) without Vitest treating it as a test file. The real chaos harness with
 * the same shape (VirtualClock, CrashController) lands in the testkit at M5.
 */

import type {
  AuditEvent,
  CircuitRecord,
  ClaimResult,
  Clock,
  CompleteEffectInput,
  EffectRecord,
  SluiceStore,
} from "./types.js";

interface Sleeper {
  at: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/**
 * Deterministic virtual clock. All sleeps resolve only when `advance()` moves
 * time past them; abortable sleeps reject with the signal's reason.
 */
export class TestClock implements Clock {
  private time = 0;
  private sleepers: Sleeper[] = [];

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(reasonOf(signal));
        return;
      }
      const entry: Sleeper = { at: this.time + ms, resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        entry.onAbort = () => {
          this.sleepers = this.sleepers.filter((s) => s !== entry);
          reject(reasonOf(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.sleepers.push(entry);
    });
  }

  /**
   * Advance virtual time by `ms`, waking due sleepers in time order and
   * letting their continuations schedule follow-up sleeps before moving on.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await drainTasks();
      const due = this.sleepers
        .filter((s) => s.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.time = Math.max(this.time, due.at);
      this.sleepers = this.sleepers.filter((s) => s !== due);
      if (due.signal !== undefined && due.onAbort !== undefined) {
        due.signal.removeEventListener("abort", due.onAbort);
      }
      due.resolve();
    }
    this.time = target;
    await drainTasks();
  }
}

function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}

/** Let every pending microtask AND timer-zero callback run (real macrotask). */
function drainTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type StoreMethod = "claimEffect" | "completeEffect" | "heartbeatEffect" | "readEffect";

/**
 * Store wrapper that simulates crashes/outages by killing chosen writes —
 * the F3/F4/F11 harness. A killed method throws a driver-flavoured plain
 * Error (never a SluiceError): sluice must wrap it, not surface it.
 */
export class FaultyStore implements SluiceStore {
  private readonly dead = new Set<StoreMethod>();
  /** When set, heartbeatEffect reports the lease as lost instead of writing. */
  denyHeartbeats = false;

  constructor(private readonly inner: SluiceStore) {}

  kill(...methods: StoreMethod[]): void {
    for (const m of methods) this.dead.add(m);
  }

  revive(...methods: StoreMethod[]): void {
    for (const m of methods) this.dead.delete(m);
  }

  private check(method: StoreMethod): void {
    if (this.dead.has(method)) {
      throw new Error(`ECONNRESET: simulated store outage in ${method}`);
    }
  }

  claimEffect(input: Parameters<SluiceStore["claimEffect"]>[0]): Promise<ClaimResult> {
    this.check("claimEffect");
    return this.inner.claimEffect(input);
  }

  completeEffect(input: CompleteEffectInput & { now: number }): Promise<EffectRecord> {
    this.check("completeEffect");
    return this.inner.completeEffect(input);
  }

  heartbeatEffect(
    input: Parameters<SluiceStore["heartbeatEffect"]>[0]
  ): Promise<{ ok: boolean }> {
    if (this.denyHeartbeats) return Promise.resolve({ ok: false });
    this.check("heartbeatEffect");
    return this.inner.heartbeatEffect(input);
  }

  readEffect(namespace: string, key: string): Promise<EffectRecord | null> {
    this.check("readEffect");
    return this.inner.readEffect(namespace, key);
  }

  readCircuit(key: string): Promise<CircuitRecord | null> {
    return this.inner.readCircuit(key);
  }

  writeCircuit(
    record: Omit<CircuitRecord, "version">,
    expectedVersion: number | null
  ): Promise<{ ok: boolean; record: CircuitRecord | null }> {
    return this.inner.writeCircuit(record, expectedVersion);
  }

  appendEvents(
    events: Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash">[]
  ): Promise<AuditEvent[]> {
    return this.inner.appendEvents(events);
  }

  readEvents(namespace: string, sinceSeq: number, limit: number): Promise<AuditEvent[]> {
    return this.inner.readEvents(namespace, sinceSeq, limit);
  }

  sweep(now: number): Promise<{ effects: number; gates: number; events: number }> {
    return this.inner.sweep(now);
  }
}

/** Seeded PRNG (mulberry32) — deterministic jitter for retry/backoff tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
