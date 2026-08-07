import type {
  AuditEvent,
  CircuitRecord,
  ClaimResult,
  CompleteEffectInput,
  EffectRecord,
  SluiceStore,
} from "./types.js";
import { SluiceError } from "./types.js";

/**
 * In-memory SluiceStore. Used by tests, the browser playground, and the CLI's
 * ephemeral mode. Same conformance suite as the Postgres store (M5/M6).
 *
 * Atomicity note: every method body is synchronous (no awaits inside the
 * critical section), which on a single JS thread gives the same guarantee the
 * Postgres store gets from single-statement operations.
 */
export class MemoryStore implements SluiceStore {
  private readonly effects = new Map<string, EffectRecord>();
  private readonly circuits = new Map<string, CircuitRecord>();
  private readonly events: AuditEvent[] = [];
  private readonly seqs = new Map<string, number>();

  /**
   * Composite map key. NUL as separator (it cannot appear in SQL text
   * columns, and — the M2 lesson — an invisible literal in a template string
   * once cost a debugging session; keep it as an explicit escape here, once).
   */
  private effectId(namespace: string, key: string): string {
    return `${namespace}\u0000${key}`;
  }

  claimEffect(input: {
    namespace: string;
    key: string;
    fingerprint: string | null;
    leaseOwner: string;
    leaseMs: number;
    retentionMs: number;
    now: number;
    reclaimIndeterminate?: boolean;
  }): Promise<ClaimResult> {
    const id = this.effectId(input.namespace, input.key);
    const existing = this.effects.get(id);

    if (existing === undefined) {
      const record: EffectRecord = {
        namespace: input.namespace,
        key: input.key,
        fingerprint: input.fingerprint,
        status: "in_flight",
        attempt: 1,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.now + input.leaseMs,
        result: null,
        resultOmitted: false,
        error: null,
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.now + input.retentionMs,
      };
      this.effects.set(id, record);
      return Promise.resolve({ outcome: "claimed", record: { ...record } });
    }

    // Expired lease on an in_flight record: transition to indeterminate
    // rather than silently re-claiming (SPEC F3/F4). The caller decides policy.
    if (
      existing.status === "in_flight" &&
      existing.leaseExpiresAt !== null &&
      existing.leaseExpiresAt < input.now
    ) {
      const updated: EffectRecord = {
        ...existing,
        status: "indeterminate",
        leaseOwner: null,
        leaseExpiresAt: null,
        error: {
          code: "E_LEASE_LOST",
          message: "lease expired before a terminal state was recorded",
          retryable: false,
          indeterminate: true,
        },
        updatedAt: input.now,
      };
      this.effects.set(id, updated);
      return Promise.resolve({ outcome: "exists", record: { ...updated }, expired: true });
    }

    // Explicit reclaim of an indeterminate record (SPEC F2/F3 'reclaim'
    // policy): back to in_flight under a fresh lease, attempt+1. Conditional
    // on the status still being indeterminate — first reclaimer wins.
    if (input.reclaimIndeterminate === true && existing.status === "indeterminate") {
      const updated: EffectRecord = {
        ...existing,
        status: "in_flight",
        attempt: existing.attempt + 1,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.now + input.leaseMs,
        error: null,
        updatedAt: input.now,
      };
      this.effects.set(id, updated);
      return Promise.resolve({ outcome: "claimed", record: { ...updated } });
    }

    return Promise.resolve({ outcome: "exists", record: { ...existing } });
  }

  completeEffect(input: CompleteEffectInput & { now: number }): Promise<EffectRecord> {
    const id = this.effectId(input.namespace, input.key);
    const existing = this.effects.get(id);
    if (existing === undefined) {
      throw new SluiceError("E_STORE", "completeEffect: record not found", {
        context: { namespace: input.namespace, key: input.key },
      });
    }
    if (existing.status !== "in_flight" || existing.leaseOwner !== input.leaseOwner) {
      // Lease was lost (expired + transitioned, or taken over). SPEC F8/I8:
      // terminal states are monotonic; a stale owner may not write.
      throw new SluiceError("E_LEASE_LOST", "completeEffect: lease not held", {
        indeterminate: true,
        context: {
          namespace: input.namespace,
          key: input.key,
          status: existing.status,
        },
      });
    }
    const updated: EffectRecord = {
      ...existing,
      status: input.status,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: input.result ?? null,
      resultOmitted: input.resultOmitted ?? false,
      error: input.error ?? null,
      updatedAt: input.now,
    };
    this.effects.set(id, updated);
    return Promise.resolve({ ...updated });
  }

  heartbeatEffect(input: {
    namespace: string;
    key: string;
    leaseOwner: string;
    leaseMs: number;
    now: number;
  }): Promise<{ ok: boolean }> {
    const id = this.effectId(input.namespace, input.key);
    const existing = this.effects.get(id);
    if (existing?.status !== "in_flight" || existing.leaseOwner !== input.leaseOwner) {
      return Promise.resolve({ ok: false });
    }
    this.effects.set(id, {
      ...existing,
      leaseExpiresAt: input.now + input.leaseMs,
      updatedAt: input.now,
    });
    return Promise.resolve({ ok: true });
  }

  readEffect(namespace: string, key: string): Promise<EffectRecord | null> {
    const record = this.effects.get(this.effectId(namespace, key));
    return Promise.resolve(record === undefined ? null : { ...record });
  }

  readCircuit(key: string): Promise<CircuitRecord | null> {
    const record = this.circuits.get(key);
    return Promise.resolve(record === undefined ? null : cloneCircuit(record));
  }

  writeCircuit(
    record: Omit<CircuitRecord, "version">,
    expectedVersion: number | null
  ): Promise<{ ok: boolean; record: CircuitRecord | null }> {
    const existing = this.circuits.get(record.key);
    if (expectedVersion === null) {
      if (existing !== undefined) {
        return Promise.resolve({ ok: false, record: cloneCircuit(existing) });
      }
      const created: CircuitRecord = { ...record, window: [...record.window], version: 1 };
      this.circuits.set(record.key, created);
      return Promise.resolve({ ok: true, record: cloneCircuit(created) });
    }
    if (existing?.version !== expectedVersion) {
      return Promise.resolve({
        ok: false,
        record: existing === undefined ? null : cloneCircuit(existing),
      });
    }
    const updated: CircuitRecord = {
      ...record,
      window: [...record.window],
      version: expectedVersion + 1,
    };
    this.circuits.set(record.key, updated);
    return Promise.resolve({ ok: true, record: cloneCircuit(updated) });
  }

  appendEvents(
    events: Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash">[]
  ): Promise<AuditEvent[]> {
    const appended: AuditEvent[] = [];
    for (const e of events) {
      const seq = (this.seqs.get(e.namespace) ?? 0) + 1;
      this.seqs.set(e.namespace, seq);
      const full: AuditEvent = {
        ...e,
        id: `evt_${e.namespace}_${String(seq)}`,
        seq,
        prevHash: null, // hash chain lands in M9
        hash: null,
      };
      this.events.push(full);
      appended.push(full);
    }
    return Promise.resolve(appended.map((e) => ({ ...e })));
  }

  readEvents(namespace: string, sinceSeq: number, limit: number): Promise<AuditEvent[]> {
    const out = this.events
      .filter((e) => e.namespace === namespace && e.seq > sinceSeq)
      .slice(0, limit)
      .map((e) => ({ ...e }));
    return Promise.resolve(out);
  }

  sweep(now: number): Promise<{ effects: number; gates: number; events: number }> {
    let effects = 0;
    for (const [id, record] of this.effects) {
      if (record.expiresAt <= now && record.status !== "in_flight") {
        this.effects.delete(id);
        effects++;
      }
    }
    return Promise.resolve({ effects, gates: 0, events: 0 });
  }
}

function cloneCircuit(record: CircuitRecord): CircuitRecord {
  return { ...record, window: [...record.window] };
}
