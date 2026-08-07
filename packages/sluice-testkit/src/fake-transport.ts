/**
 * FakeTransport — the observable downstream and the exactly-once measurement
 * instrument (SPEC §7). Every call is one downstream ATTEMPT; every attempt
 * that COMMITS appends to the LEDGER. The ledger is what the invariants are
 * measured against: I1 (exactly-once) is "ledger entries per intent ≤ 1",
 * never an assertion about sluice's internals.
 *
 * Fault semantics per attempt (drawn from the FaultPlan):
 * - "ok"      — the effect lands; the caller gets the result. If the caller
 *               aborts mid-flight (deadline), the request was already sent —
 *               it LANDS ANYWAY and the abort reason is rethrown (F2's shape).
 * - "error"   — the downstream rejects BEFORE committing: nothing landed,
 *               retryable.
 * - "timeout" — the downstream COMMITS but the response is lost: the ledger
 *               gains an entry and the caller sees a timeout. This is the
 *               fault that makes naive retry double-charge.
 *
 * Isomorphic-pure: no node builtins.
 */

import type { Clock, Json } from "@jamessuuu/sluice";
import type { AttemptFault, FaultPlan } from "./fault-plan.js";

/** Thrown for "error" faults — safe to retry (nothing landed downstream). */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** Thrown for "timeout" faults — the outcome is unknown to the caller. */
export class TransportTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportTimeoutError";
  }
}

/**
 * The classify function scenarios hand to createSluice: transport timeouts
 * are indeterminate (the effect may have landed), transport errors are
 * retryable (provably nothing landed), anything else failed.
 */
export function chaosClassify(err: unknown): "retryable" | "failed" | "indeterminate" {
  if (err instanceof TransportTimeoutError) return "indeterminate";
  if (err instanceof TransportError) return "retryable";
  return "failed";
}

/** One committed downstream side effect — a LEDGER entry. */
export interface LedgerEntry {
  intent: string;
  /** Virtual time the effect landed. */
  at: number;
  /** Which downstream attempt (1-based, per intent) landed it. */
  attempt: number;
}

/** One downstream call, landed or not — the I6 amplification unit. */
export interface AttemptEntry {
  intent: string;
  attempt: number;
  at: number;
  fault: AttemptFault;
  /** True when the caller aborted mid-flight on an "ok" attempt. */
  aborted?: boolean;
}

export class FakeTransport {
  /** Committed side effects — the exactly-once ledger (SPEC §7). */
  readonly ledger: LedgerEntry[] = [];
  /** Every downstream call — the amplification denominator's counterpart. */
  readonly attempts: AttemptEntry[] = [];
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly plan: FaultPlan
  ) {}

  /** Perform the downstream side effect for `intent`. */
  async call(intent: string, o?: { signal?: AbortSignal; value?: Json }): Promise<Json> {
    const attempt = (this.counters.get(intent) ?? 0) + 1;
    this.counters.set(intent, attempt);
    const fault = this.plan.attemptFault(intent, attempt);
    const latency = this.plan.latencyFor(intent, attempt);
    const at = this.clock.now();

    if (fault === "error") {
      // Rejected before commit: nothing landed, retry is safe.
      this.attempts.push({ intent, attempt, at, fault });
      if (latency > 0) await this.clock.sleep(latency, o?.signal);
      throw new TransportError(
        `injected transport error (intent=${intent}, attempt=${String(attempt)})`
      );
    }

    if (fault === "timeout") {
      // Committed downstream, response lost: the ledger gains an entry and
      // the caller learns nothing — the F2 fault.
      this.attempts.push({ intent, attempt, at, fault });
      this.ledger.push({ intent, at, attempt });
      if (latency > 0) {
        try {
          await this.clock.sleep(latency, o?.signal);
        } catch {
          // Aborted while waiting for a response that was never coming.
        }
      }
      throw new TransportTimeoutError(
        `injected downstream timeout (intent=${intent}, attempt=${String(attempt)}) — the effect landed`
      );
    }

    // "ok" — but a slow response can still be abandoned by the caller.
    if (latency > 0) {
      try {
        await this.clock.sleep(latency, o?.signal);
      } catch (abortReason) {
        // The request departed before the abort: it lands anyway (F2).
        this.attempts.push({ intent, attempt, at, fault, aborted: true });
        this.ledger.push({ intent, at: this.clock.now(), attempt });
        throw abortReason;
      }
    }
    this.attempts.push({ intent, attempt, at, fault });
    this.ledger.push({ intent, at: this.clock.now(), attempt });
    return o?.value ?? { ok: true, intent, attempt };
  }

  /** Committed side effects for one intent — the I1 measurement. */
  ledgerCount(intent: string): number {
    let n = 0;
    for (const e of this.ledger) if (e.intent === intent) n++;
    return n;
  }

  /** Total duplicate side effects: Σ max(0, ledgerCount(intent) − 1). */
  duplicateCount(): number {
    const perIntent = new Map<string, number>();
    for (const e of this.ledger) perIntent.set(e.intent, (perIntent.get(e.intent) ?? 0) + 1);
    let dup = 0;
    for (const n of perIntent.values()) dup += Math.max(0, n - 1);
    return dup;
  }
}
