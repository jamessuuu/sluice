/**
 * StoreMonitor — the I8 instrument. Wraps the SHARED base store (beneath
 * every simulated process's crash wrapper) and observes every record that
 * passes through, tracking effect and gate status transitions:
 *
 * - effects: `in_flight` may go anywhere; `succeeded`/`failed` are terminal
 *   forever; `indeterminate` may only return to `in_flight` via an explicit
 *   `reclaimIndeterminate` claim (the F2/F3 opt-in). Anything else is an I8
 *   violation.
 * - gates: `pending` may reach any decided status; decided statuses are
 *   terminal forever (F6/F12).
 *
 * It also remembers every effect key and gate id it saw (the invariant
 * checker's enumeration source) and when each effect was parked
 * indeterminate (the I3 "no execution after parking" check).
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

const TERMINAL_EFFECT = new Set(["succeeded", "failed"]);

/** NUL separator, constructed (never a literal — the M2 invisible-char lesson). */
const SEP = String.fromCharCode(0);

function effectId(namespace: string, key: string): string {
  return `${namespace}${SEP}${key}`;
}

export class StoreMonitor implements SluiceStore {
  readonly violations: string[] = [];
  /** Every effect (namespace NUL key) ever observed. */
  readonly effectKeys = new Set<string>();
  /** Every gate id ever observed. */
  readonly gateIds = new Set<string>();
  /** Effect key -> virtual time it was first observed `indeterminate`. */
  readonly indeterminateAt = new Map<string, number>();
  /** Effect keys that were explicitly reclaimed (the legal indeterminate exit). */
  readonly reclaimedKeys = new Set<string>();

  private readonly effectStatus = new Map<string, string>();
  private readonly gateStatus = new Map<string, string>();

  constructor(private readonly inner: SluiceStore) {}

  static splitEffectId(id: string): { namespace: string; key: string } {
    const sep = id.indexOf(SEP);
    return { namespace: id.slice(0, sep), key: id.slice(sep + 1) };
  }

  private observeEffect(record: EffectRecord, via: string, reclaimed = false): void {
    const id = effectId(record.namespace, record.key);
    this.effectKeys.add(id);
    const prev = this.effectStatus.get(id);
    if (prev !== undefined && prev !== record.status) {
      const legal =
        prev === "in_flight" ||
        (prev === "indeterminate" && record.status === "in_flight" && reclaimed);
      if (!legal) {
        this.violations.push(
          `I8: effect ${record.key} left ${TERMINAL_EFFECT.has(prev) ? "terminal" : "parked"} state ${prev} -> ${record.status} (via ${via})`
        );
      }
    }
    this.effectStatus.set(id, record.status);
    if (record.status === "indeterminate" && !this.indeterminateAt.has(id)) {
      this.indeterminateAt.set(id, record.updatedAt);
    }
    if (reclaimed && record.status === "in_flight") this.reclaimedKeys.add(id);
  }

  private observeGate(record: GateRecord, via: string): void {
    this.gateIds.add(record.id);
    const prev = this.gateStatus.get(record.id);
    if (prev !== undefined && prev !== record.status && prev !== "pending") {
      this.violations.push(
        `I8: gate ${record.key} left terminal state ${prev} -> ${record.status} (via ${via})`
      );
    }
    this.gateStatus.set(record.id, record.status);
  }

  async claimEffect(input: Parameters<SluiceStore["claimEffect"]>[0]): Promise<ClaimResult> {
    const result = await this.inner.claimEffect(input);
    this.observeEffect(
      result.record,
      "claimEffect",
      input.reclaimIndeterminate === true && result.outcome === "claimed"
    );
    return result;
  }

  async completeEffect(input: CompleteEffectInput & { now: number }): Promise<EffectRecord> {
    const record = await this.inner.completeEffect(input);
    this.observeEffect(record, "completeEffect");
    return record;
  }

  heartbeatEffect(
    input: Parameters<SluiceStore["heartbeatEffect"]>[0]
  ): Promise<{ ok: boolean }> {
    return this.inner.heartbeatEffect(input);
  }

  async readEffect(namespace: string, key: string): Promise<EffectRecord | null> {
    const record = await this.inner.readEffect(namespace, key);
    if (record !== null) this.observeEffect(record, "readEffect");
    return record;
  }

  async openGate(candidate: GateRecord): Promise<{ created: boolean; record: GateRecord }> {
    const result = await this.inner.openGate(candidate);
    this.observeGate(result.record, "openGate");
    return result;
  }

  async readGate(id: string): Promise<GateRecord | null> {
    const record = await this.inner.readGate(id);
    if (record !== null) this.observeGate(record, "readGate");
    return record;
  }

  async decideGate(
    input: Parameters<SluiceStore["decideGate"]>[0]
  ): Promise<{ applied: boolean; record: GateRecord | null }> {
    const result = await this.inner.decideGate(input);
    if (result.record !== null) this.observeGate(result.record, "decideGate");
    return result;
  }

  async listGates(q: {
    namespace?: string;
    status?: GateStatus;
    limit?: number;
  }): Promise<GateRecord[]> {
    const records = await this.inner.listGates(q);
    for (const r of records) this.observeGate(r, "listGates");
    return records;
  }

  async claimDecidedGates(
    input: Parameters<SluiceStore["claimDecidedGates"]>[0]
  ): Promise<GateRecord[]> {
    const records = await this.inner.claimDecidedGates(input);
    for (const r of records) this.observeGate(r, "claimDecidedGates");
    return records;
  }

  ackGate(input: Parameters<SluiceStore["ackGate"]>[0]): Promise<boolean> {
    return this.inner.ackGate(input);
  }

  async expireGates(now: number): Promise<GateRecord[]> {
    const records = await this.inner.expireGates(now);
    for (const r of records) this.observeGate(r, "expireGates");
    return records;
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
