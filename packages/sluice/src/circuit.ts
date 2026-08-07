/**
 * Circuit breaker per circuitKey (SPEC §5): rolling window of 20 outcomes,
 * opens at ≥50% failures with ≥5 samples, jittered open interval doubling to
 * a ceiling, half-open admitting EXACTLY ONE probe via a CAS write to the
 * store, and a 1s in-process read-through cache (breaker sharing is
 * eventually consistent within that second — documented limitation).
 *
 * All state lives in the store; this class holds only the cache and the
 * in-process probe flag. Policy lives here, never in the store (SPEC §4).
 */

import type {
  AuditEvent,
  AuditInput,
  CircuitPolicy,
  CircuitRecord,
  Clock,
  SluiceStore,
} from "./types.js";

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  windowSize: 20,
  failureThreshold: 0.5,
  minSamples: 5,
  openMs: 30_000,
  maxOpenMs: 300_000,
  probeTtlMs: 30_000,
  cacheTtlMs: 1_000,
};

export type Admission =
  | { admitted: true; probe: boolean }
  | { admitted: false; record: CircuitRecord };

interface CacheEntry {
  at: number;
  record: CircuitRecord | null;
}

export class CircuitBreakers {
  private readonly cache = new Map<string, CacheEntry>();
  /** Store keys with a probe currently in flight FROM THIS INSTANCE. */
  private readonly probing = new Set<string>();

  constructor(
    private readonly store: SluiceStore,
    private readonly policy: CircuitPolicy,
    private readonly clock: Clock,
    private readonly random: () => number,
    private readonly owner: string,
    private readonly emit: (e: AuditInput) => Promise<AuditEvent>
  ) {}

  static storeKey(namespace: string, circuitKey: string): string {
    return `${namespace}:${circuitKey}`;
  }

  /** ±20% jitter on a (possibly doubled) open interval. */
  private jitteredOpenMs(consecutiveOpens: number): number {
    const base = Math.min(
      this.policy.maxOpenMs,
      this.policy.openMs * 2 ** Math.max(0, consecutiveOpens - 1)
    );
    return Math.round(base * (0.8 + 0.4 * this.random()));
  }

  private async readFresh(key: string): Promise<CircuitRecord | null> {
    const record = await this.store.readCircuit(key);
    this.cache.set(key, { at: this.clock.now(), record });
    return record;
  }

  private async readCached(key: string): Promise<CircuitRecord | null> {
    const hit = this.cache.get(key);
    if (hit !== undefined && this.clock.now() - hit.at < this.policy.cacheTtlMs) {
      return hit.record;
    }
    return this.readFresh(key);
  }

  /**
   * May this call execute? Closed (or unknown) circuits admit on the cached
   * read — the healthy path never pays a per-call query once warm. Open
   * circuits whose interval elapsed race a CAS for the single half-open
   * probe; exactly one instance wins it.
   */
  async admit(namespace: string, circuitKey: string): Promise<Admission> {
    const key = CircuitBreakers.storeKey(namespace, circuitKey);
    const cached = await this.readCached(key);
    if (cached === null || cached.state === "closed") {
      return { admitted: true, probe: false };
    }

    const now = this.clock.now();
    if (cached.state === "open" && now < (cached.openedAt ?? 0) + (cached.openMs ?? 0)) {
      return { admitted: false, record: cached };
    }
    if (
      cached.state === "half_open" &&
      (cached.halfOpenExpiresAt ?? 0) >= now
    ) {
      // A live probe is out (possibly ours). One probe means one.
      return { admitted: false, record: cached };
    }

    // Transition is plausible — decide against FRESH state, then CAS.
    const fresh = await this.readFresh(key);
    if (fresh === null || fresh.state === "closed") {
      return { admitted: true, probe: false };
    }
    const freshNow = this.clock.now();
    const openElapsed =
      fresh.state === "open" && freshNow >= (fresh.openedAt ?? 0) + (fresh.openMs ?? 0);
    const probeExpired =
      fresh.state === "half_open" && (fresh.halfOpenExpiresAt ?? 0) < freshNow;
    if (!openElapsed && !probeExpired) {
      return { admitted: false, record: fresh };
    }

    const won = await this.store.writeCircuit(
      {
        key,
        state: "half_open",
        window: fresh.window,
        openedAt: fresh.openedAt,
        openMs: fresh.openMs,
        consecutiveOpens: fresh.consecutiveOpens,
        halfOpenOwner: this.owner,
        halfOpenExpiresAt: freshNow + this.policy.probeTtlMs,
        updatedAt: freshNow,
      },
      fresh.version
    );
    this.cache.set(key, { at: this.clock.now(), record: won.record });
    if (!won.ok || won.record === null) {
      // Lost the CAS — someone else owns the probe.
      return won.record === null
        ? { admitted: true, probe: false }
        : { admitted: false, record: won.record };
    }
    this.probing.add(key);
    await this.emit({
      namespace,
      subjectType: "circuit",
      subjectKey: circuitKey,
      type: "circuit.half_open",
      data: { probeOwner: this.owner },
    });
    return { admitted: true, probe: true };
  }

  /**
   * Record one downstream attempt outcome. Probe outcomes settle the
   * half-open state (close, or re-open with a doubled interval); normal
   * outcomes maintain the rolling window and may open the circuit. Advisory:
   * unresolvable CAS races are dropped after a few tries rather than failing
   * the caller's effect.
   */
  async recordOutcome(
    namespace: string,
    circuitKey: string,
    ok: boolean,
    probe: boolean
  ): Promise<void> {
    const key = CircuitBreakers.storeKey(namespace, circuitKey);
    if (probe) {
      this.probing.delete(key);
      const fresh = await this.readFresh(key);
      if (fresh?.state !== "half_open" || fresh.halfOpenOwner !== this.owner) {
        return; // our probe was presumed dead and superseded — nothing to settle
      }
      const now = this.clock.now();
      if (ok) {
        const res = await this.store.writeCircuit(
          {
            key,
            state: "closed",
            window: [],
            openedAt: null,
            openMs: null,
            consecutiveOpens: 0,
            halfOpenOwner: null,
            halfOpenExpiresAt: null,
            updatedAt: now,
          },
          fresh.version
        );
        this.cache.set(key, { at: now, record: res.record });
        if (res.ok) {
          await this.emit({
            namespace,
            subjectType: "circuit",
            subjectKey: circuitKey,
            type: "circuit.closed",
            data: {},
          });
        }
        return;
      }
      const consecutiveOpens = fresh.consecutiveOpens + 1;
      const openMs = this.jitteredOpenMs(consecutiveOpens);
      const res = await this.store.writeCircuit(
        {
          key,
          state: "open",
          window: [],
          openedAt: now,
          openMs,
          consecutiveOpens,
          halfOpenOwner: null,
          halfOpenExpiresAt: null,
          updatedAt: now,
        },
        fresh.version
      );
      this.cache.set(key, { at: now, record: res.record });
      if (res.ok) {
        await this.emit({
          namespace,
          subjectType: "circuit",
          subjectKey: circuitKey,
          type: "circuit.opened",
          data: { openMs, consecutiveOpens, reason: "probe_failed" },
        });
      }
      return;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.clock.now();
      const fresh = await this.readFresh(key);
      if (fresh === null) {
        const res = await this.store.writeCircuit(
          {
            key,
            state: "closed",
            window: [ok ? 0 : 1],
            openedAt: null,
            openMs: null,
            consecutiveOpens: 0,
            halfOpenOwner: null,
            halfOpenExpiresAt: null,
            updatedAt: now,
          },
          null
        );
        if (res.ok) {
          this.cache.set(key, { at: now, record: res.record });
          return;
        }
        continue; // lost the create race — retry against the created record
      }
      if (fresh.state !== "closed") return; // stale admission — never touch open/half_open
      const window = [...fresh.window, ok ? 0 : 1].slice(-this.policy.windowSize);
      const failures = window.reduce((a, b) => a + b, 0);
      const opens =
        window.length >= this.policy.minSamples &&
        failures / window.length >= this.policy.failureThreshold;
      const consecutiveOpens = opens ? fresh.consecutiveOpens + 1 : fresh.consecutiveOpens;
      const openMs = opens ? this.jitteredOpenMs(consecutiveOpens) : null;
      const res = await this.store.writeCircuit(
        opens
          ? {
              key,
              state: "open",
              window: [],
              openedAt: now,
              openMs,
              consecutiveOpens,
              halfOpenOwner: null,
              halfOpenExpiresAt: null,
              updatedAt: now,
            }
          : { ...fresh, window, updatedAt: now },
        fresh.version
      );
      if (res.ok) {
        this.cache.set(key, { at: now, record: res.record });
        if (opens) {
          await this.emit({
            namespace,
            subjectType: "circuit",
            subjectKey: circuitKey,
            type: "circuit.opened",
            data: { openMs, consecutiveOpens, failures, samples: window.length },
          });
        }
        return;
      }
    }
  }
}
