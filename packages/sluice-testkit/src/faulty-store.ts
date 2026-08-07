/**
 * FaultyStore — store outage simulator (F11): kill chosen methods so they
 * throw a driver-flavoured plain Error (never a SluiceError — sluice must
 * wrap it, not surface it), then revive them. Promoted from the core's
 * test helper as shipping testkit code; consumers use it to write their own
 * F11 tests against any SluiceStore.
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
import type { StoreMethodName } from "./crash-controller.js";

export class FaultyStore implements SluiceStore {
  private readonly dead = new Set<StoreMethodName>();
  /** When set, heartbeatEffect reports the lease as lost instead of writing. */
  denyHeartbeats = false;

  constructor(private readonly inner: SluiceStore) {}

  kill(...methods: StoreMethodName[]): void {
    for (const m of methods) this.dead.add(m);
  }

  revive(...methods: StoreMethodName[]): void {
    for (const m of methods) this.dead.delete(m);
  }

  private check(method: StoreMethodName): void {
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

  openGate(candidate: GateRecord): Promise<{ created: boolean; record: GateRecord }> {
    this.check("openGate");
    return this.inner.openGate(candidate);
  }

  readGate(id: string): Promise<GateRecord | null> {
    this.check("readGate");
    return this.inner.readGate(id);
  }

  decideGate(
    input: Parameters<SluiceStore["decideGate"]>[0]
  ): Promise<{ applied: boolean; record: GateRecord | null }> {
    this.check("decideGate");
    return this.inner.decideGate(input);
  }

  listGates(q: {
    namespace?: string;
    status?: GateStatus;
    limit?: number;
  }): Promise<GateRecord[]> {
    this.check("listGates");
    return this.inner.listGates(q);
  }

  claimDecidedGates(
    input: Parameters<SluiceStore["claimDecidedGates"]>[0]
  ): Promise<GateRecord[]> {
    this.check("claimDecidedGates");
    return this.inner.claimDecidedGates(input);
  }

  ackGate(input: Parameters<SluiceStore["ackGate"]>[0]): Promise<boolean> {
    this.check("ackGate");
    return this.inner.ackGate(input);
  }

  expireGates(now: number): Promise<GateRecord[]> {
    this.check("expireGates");
    return this.inner.expireGates(now);
  }

  readCircuit(key: string): Promise<CircuitRecord | null> {
    this.check("readCircuit");
    return this.inner.readCircuit(key);
  }

  writeCircuit(
    record: Omit<CircuitRecord, "version">,
    expectedVersion: number | null
  ): Promise<{ ok: boolean; record: CircuitRecord | null }> {
    this.check("writeCircuit");
    return this.inner.writeCircuit(record, expectedVersion);
  }

  appendEvents(
    events: Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash">[]
  ): Promise<AuditEvent[]> {
    this.check("appendEvents");
    return this.inner.appendEvents(events);
  }

  readEvents(namespace: string, sinceSeq: number, limit: number): Promise<AuditEvent[]> {
    this.check("readEvents");
    return this.inner.readEvents(namespace, sinceSeq, limit);
  }

  sweep(now: number): Promise<{ effects: number; gates: number; events: number }> {
    this.check("sweep");
    return this.inner.sweep(now);
  }
}
