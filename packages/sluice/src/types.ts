import type { Json } from "./json.js";

// ── errors ────────────────────────────────────────────────────────────────────

export type SluiceErrorCode =
  | "E_KEY_CONFLICT"
  | "E_INDETERMINATE"
  | "E_EFFECT_FAILED"
  | "E_CIRCUIT_OPEN"
  | "E_RETRY_BUDGET"
  | "E_DEADLINE"
  | "E_LEASE_LOST"
  | "E_GATE_REJECTED"
  | "E_GATE_TIMEOUT"
  | "E_WAIT_TIMEOUT"
  | "E_BAD_TOKEN"
  | "E_STORE"
  | "E_RESULT_TOO_LARGE"
  | "E_CONFIG";

/**
 * Every error sluice throws. `retryable` and `indeterminate` are the two bits
 * callers branch on; `context` carries structured facts (never a stack, never
 * a driver string — SPEC §6).
 */
export class SluiceError extends Error {
  readonly code: SluiceErrorCode;
  readonly retryable: boolean;
  readonly indeterminate: boolean;
  readonly context: Record<string, Json>;

  constructor(
    code: SluiceErrorCode,
    message: string,
    opts?: {
      retryable?: boolean;
      indeterminate?: boolean;
      context?: Record<string, Json>;
      cause?: unknown;
    }
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "SluiceError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.indeterminate = opts?.indeterminate ?? false;
    this.context = opts?.context ?? {};
  }
}

/** Thrown by user effect functions to force `indeterminate` classification. */
export class Indeterminate extends Error {
  constructor(cause?: unknown) {
    super("effect outcome is indeterminate", cause === undefined ? undefined : { cause });
    this.name = "Indeterminate";
  }
}

// ── effects ───────────────────────────────────────────────────────────────────

export type EffectStatus = "in_flight" | "succeeded" | "failed" | "indeterminate";

export interface StoredError {
  code: string;
  message: string;
  retryable: boolean;
  indeterminate: boolean;
}

export interface EffectRecord {
  namespace: string;
  key: string;
  fingerprint: string | null;
  status: EffectStatus;
  /** Claims, not retries (SPEC §3). */
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  result: Json | null;
  resultOmitted: boolean;
  error: StoredError | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface EffectContext {
  effectId: string;
  key: string;
  namespace: string;
  attempt: number;
  signal: AbortSignal;
  now: () => number;
  /** Attach a structured note to the audit stream for this attempt. */
  note: (data: Record<string, Json>) => void;
}

export interface EffectSpec {
  key: string;
  namespace?: string;
  /** Hashed canonically; mismatch on the same key ⇒ E_KEY_CONFLICT (SPEC F9). */
  fingerprint?: Json;
  /** Default 30_000. Heartbeat at leaseMs/3 (lands in M2). */
  leaseMs?: number;
  /** Whole-run deadline incl. retries. Default 60_000. */
  deadlineMs?: number;
  onIndeterminate?: "fail" | "reclaim" | "gate";
  retentionMs?: number;
}

export type EffectOutcome<T extends Json> =
  | { status: "executed"; value: T; attempts: number; effectId: string }
  | { status: "replayed"; value: T; effectId: string; firstSeenAt: number }
  | {
      status: "replayed";
      value: undefined;
      resultOmitted: true;
      effectId: string;
      firstSeenAt: number;
    };

// ── audit ─────────────────────────────────────────────────────────────────────

export type AuditEventType =
  | "effect.claimed"
  | "effect.attempt_failed"
  | "effect.succeeded"
  | "effect.failed"
  | "effect.indeterminate"
  | "effect.replayed"
  | "effect.key_conflict"
  | "gate.opened"
  | "gate.decided"
  | "gate.timed_out"
  | "gate.claimed"
  | "gate.resumed"
  | "circuit.opened"
  | "circuit.half_open"
  | "circuit.closed"
  | "retry.budget_exhausted"
  | "note";

export interface AuditEvent {
  id: string;
  namespace: string;
  seq: number;
  ts: number;
  subjectType: "effect" | "gate" | "circuit" | "custom";
  subjectKey: string;
  type: AuditEventType;
  attempt: number | null;
  actor: string;
  data: Record<string, Json>;
  prevHash: string | null;
  hash: string | null;
}

export interface AuditInput {
  namespace?: string;
  subjectType: AuditEvent["subjectType"];
  subjectKey: string;
  type: AuditEventType;
  attempt?: number;
  actor?: string;
  data?: Record<string, Json>;
}

// ── clock ─────────────────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const t = setTimeout(done, ms);
      function done() {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        reject(abortError(signal));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}

// ── store contract ────────────────────────────────────────────────────────────

export interface ClaimResult {
  /** "claimed" — caller owns the lease and must execute. */
  outcome: "claimed" | "exists";
  record: EffectRecord;
}

export interface CompleteEffectInput {
  namespace: string;
  key: string;
  leaseOwner: string;
  status: Exclude<EffectStatus, "in_flight">;
  result?: Json;
  resultOmitted?: boolean;
  error?: StoredError;
}

/**
 * SluiceStore — one logical statement per method, no cross-method transaction
 * assumed (SPEC §3). M1 ships the effect + event subset; gates and circuits
 * extend this interface in M4/M3.
 */
export interface SluiceStore {
  /**
   * Atomically claim (namespace, key): insert as in_flight, or take over an
   * expired lease. Returns "exists" with the current record when the claim is
   * not granted (terminal record ⇒ replay path; live lease ⇒ wait path).
   */
  claimEffect(input: {
    namespace: string;
    key: string;
    fingerprint: string | null;
    leaseOwner: string;
    leaseMs: number;
    retentionMs: number;
    now: number;
  }): Promise<ClaimResult>;

  /** Persist the terminal state. Conditional on still owning the lease. */
  completeEffect(input: CompleteEffectInput & { now: number }): Promise<EffectRecord>;

  readEffect(namespace: string, key: string): Promise<EffectRecord | null>;

  appendEvents(
    events: Omit<AuditEvent, "id" | "seq" | "prevHash" | "hash">[]
  ): Promise<AuditEvent[]>;

  readEvents(namespace: string, sinceSeq: number, limit: number): Promise<AuditEvent[]>;

  sweep(now: number): Promise<{ effects: number; gates: number; events: number }>;
}
