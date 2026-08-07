/**
 * CrashController — abort a store write or a whole simulated "process" at a
 * chosen point (SPEC §7). A crash is modelled the way a real process death
 * looks to the survivors: writes scheduled BEFORE the crash landed in the
 * store, everything after simply never happens, and no promise held by the
 * dead process ever settles (the scenario abandons them). This is what makes
 * F3/F4/F5 reproducible in a single JS thread.
 *
 * Wrap the shared store once per simulated process; a controller belongs to
 * exactly one process.
 *
 * Isomorphic-pure: no node builtins.
 */

import type {
  AuditEvent,
  CircuitRecord,
  ClaimResult,
  CompleteEffectInput,
  EffectRecord,
  GateRecord,
  GateStatus,
  SluiceStore,
} from "@jamessuuu/sluice";

export type StoreMethodName =
  | "claimEffect"
  | "completeEffect"
  | "heartbeatEffect"
  | "readEffect"
  | "openGate"
  | "readGate"
  | "decideGate"
  | "listGates"
  | "claimDecidedGates"
  | "ackGate"
  | "expireGates"
  | "readCircuit"
  | "writeCircuit"
  | "appendEvents"
  | "readEvents"
  | "sweep";

export interface StoreCrashPoint {
  method: StoreMethodName;
  /** Which call to that method triggers the crash (1-based). Default 1. */
  call?: number;
  /**
   * "before": the process dies BEFORE the write reaches the store (it never
   * lands). "after": the write LANDS but the process dies before observing
   * the response — the F3 shape. Default "before".
   */
  mode?: "before" | "after";
}

/** A promise that never settles — what a dead process's callers are left holding. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* the process is dead */
  });
}

export class CrashController {
  private dead = false;
  private point: Required<StoreCrashPoint> | null = null;
  private readonly counts = new Map<string, number>();
  private notifyCrashed: (() => void) | null = null;
  /** Resolves the moment the process dies — settle() on this to sequence scenarios. */
  readonly whenCrashed: Promise<void>;

  constructor() {
    this.whenCrashed = new Promise((resolve) => {
      this.notifyCrashed = resolve;
    });
  }

  get crashed(): boolean {
    return this.dead;
  }

  /** Schedule the crash at a store call. Replaces any previous schedule. */
  crashAt(point: StoreCrashPoint): void {
    this.point = { method: point.method, call: point.call ?? 1, mode: point.mode ?? "before" };
  }

  /** Kill the process immediately: every store call from now on hangs forever. */
  crashNow(): void {
    this.die();
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    this.notifyCrashed?.();
  }

  /** Read through a method: die() mutates from another async flow, which TS
   * property narrowing cannot see across the await below. */
  private isDead(): boolean {
    return this.dead;
  }

  private async guard<T>(method: StoreMethodName, invoke: () => Promise<T>): Promise<T> {
    if (this.isDead()) return neverSettles<T>();
    const n = (this.counts.get(method) ?? 0) + 1;
    this.counts.set(method, n);
    const p = this.point;
    const hit = p !== null && p.method === method && p.call === n;
    if (hit && p.mode === "before") {
      this.die();
      return neverSettles<T>();
    }
    const result = await invoke();
    if (this.isDead()) return neverSettles<T>(); // died while the call was in flight
    if (hit && p.mode === "after") {
      this.die();
      return neverSettles<T>();
    }
    return result;
  }

  /** The dead-process view over `store` for one simulated process. */
  wrap(store: SluiceStore): SluiceStore {
    const g = <T>(m: StoreMethodName, invoke: () => Promise<T>): Promise<T> =>
      this.guard(m, invoke);
    return {
      claimEffect: (input): Promise<ClaimResult> =>
        g("claimEffect", () => store.claimEffect(input)),
      completeEffect: (input: CompleteEffectInput & { now: number }): Promise<EffectRecord> =>
        g("completeEffect", () => store.completeEffect(input)),
      heartbeatEffect: (input): Promise<{ ok: boolean }> =>
        g("heartbeatEffect", () => store.heartbeatEffect(input)),
      readEffect: (namespace: string, key: string): Promise<EffectRecord | null> =>
        g("readEffect", () => store.readEffect(namespace, key)),
      openGate: (candidate: GateRecord): Promise<{ created: boolean; record: GateRecord }> =>
        g("openGate", () => store.openGate(candidate)),
      readGate: (id: string): Promise<GateRecord | null> => g("readGate", () => store.readGate(id)),
      decideGate: (input): Promise<{ applied: boolean; record: GateRecord | null }> =>
        g("decideGate", () => store.decideGate(input)),
      listGates: (q: {
        namespace?: string;
        status?: GateStatus;
        limit?: number;
      }): Promise<GateRecord[]> => g("listGates", () => store.listGates(q)),
      claimDecidedGates: (input): Promise<GateRecord[]> =>
        g("claimDecidedGates", () => store.claimDecidedGates(input)),
      ackGate: (input): Promise<boolean> => g("ackGate", () => store.ackGate(input)),
      expireGates: (now: number): Promise<GateRecord[]> =>
        g("expireGates", () => store.expireGates(now)),
      readCircuit: (key: string): Promise<CircuitRecord | null> =>
        g("readCircuit", () => store.readCircuit(key)),
      writeCircuit: (
        record: Omit<CircuitRecord, "version">,
        expectedVersion: number | null
      ): Promise<{ ok: boolean; record: CircuitRecord | null }> =>
        g("writeCircuit", () => store.writeCircuit(record, expectedVersion)),
      appendEvents: (
        events: Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash">[]
      ): Promise<AuditEvent[]> => g("appendEvents", () => store.appendEvents(events)),
      readEvents: (namespace: string, sinceSeq: number, limit: number): Promise<AuditEvent[]> =>
        g("readEvents", () => store.readEvents(namespace, sinceSeq, limit)),
      sweep: (now: number): Promise<{ effects: number; gates: number; events: number }> =>
        g("sweep", () => store.sweep(now)),
    };
  }
}
