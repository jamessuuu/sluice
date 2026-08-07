import { CircuitBreakers, DEFAULT_CIRCUIT_POLICY, type Admission } from "./circuit.js";
import { createGates, type GatesApi } from "./gates.js";
import { canonicalJson, type Json } from "./json.js";
import {
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  retryAfterHint,
  RetryBudget,
  type RetryPolicy,
} from "./retry.js";
import { sha256Hex } from "./sha256.js";
import {
  Indeterminate,
  SluiceError,
  systemClock,
  type AuditEvent,
  type AuditInput,
  type CircuitPolicy,
  type CircuitRecord,
  type ClaimResult,
  type Classification,
  type ClassifyFn,
  type Clock,
  type EffectContext,
  type EffectOutcome,
  type EffectRecord,
  type EffectSpec,
  type GateRecord,
  type GateSpec,
  type SluiceErrorCode,
  type SluiceStore,
  type StoredError,
} from "./types.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESULT_BYTES = 65_536;
const MAX_KEY_LENGTH = 200;
/** Poll interval while waiting for another owner's in-flight effect (F1). */
const WAIT_POLL_MS = 25;

export interface SluiceOptions {
  store: SluiceStore;
  namespace?: string;
  owner?: string;
  clock?: Clock;
  random?: () => number;
  /** Classify errors thrown by effect functions (SPEC §5). Default: `failed`. */
  classify?: ClassifyFn;
  /** Instance-wide retry policy; per-effect `spec.retry` overrides fields. */
  retry?: Partial<RetryPolicy>;
  /** Circuit breaker policy, or `false` to disable the breaker entirely. */
  circuit?: Partial<CircuitPolicy> | false;
  retentionMs?: number;
  maxResultBytes?: number;
  audit?: { sink?: (e: AuditEvent) => void };
  /** Only needed to mint/verify approval tokens (SPEC §5 auth model). */
  approvalSecret?: string;
}

export interface Sluice {
  run<T extends Json>(
    spec: EffectSpec,
    fn: (ctx: EffectContext) => Promise<T>
  ): Promise<EffectOutcome<T>>;
  inspect(key: string, namespace?: string): Promise<EffectRecord | null>;
  sweep(now?: number): Promise<{ effects: number; gates: number; events: number }>;
  readonly gates: GatesApi;
  /**
   * open + waitFor sugar. Resolves only on approval; throws E_GATE_REJECTED
   * on reject/cancel and E_GATE_TIMEOUT on timeout (SPEC §5). Waits longer
   * than ~5 minutes should use gates.open() + claimDecided() instead.
   */
  gate(
    spec: GateSpec,
    o?: { maxWaitMs?: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<GateRecord & { status: "approved" }>;
  readonly audit: {
    append(e: AuditInput): Promise<AuditEvent>;
    since(cursor: { namespace: string; seq: number }, limit?: number): Promise<AuditEvent[]>;
  };
}

/** sha256 over canonical JSON — the documented key-derivation helper (SPEC §5). */
export function idempotencyKey(parts: Json): string {
  return sha256Hex(canonicalJson(parts));
}

export function createSluice(options: SluiceOptions): Sluice {
  const store = options.store;
  const namespace = options.namespace ?? "default";
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const owner =
    options.owner ?? `owner-${clock.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const userClassify = options.classify;
  const sink = options.audit?.sink;
  const baseRetryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const breakers =
    options.circuit === false
      ? null
      : new CircuitBreakers(
          store,
          { ...DEFAULT_CIRCUIT_POLICY, ...options.circuit },
          clock,
          random,
          owner,
          (e) => emit(e)
        );
  const budget = new RetryBudget();
  const gates = createGates({
    store,
    namespace,
    owner,
    clock,
    random,
    approvalSecret: options.approvalSecret,
    emit: (e) => emit(e),
  });

  async function emit(input: AuditInput): Promise<AuditEvent> {
    let events: AuditEvent[];
    try {
      events = await store.appendEvents([
        {
          namespace: input.namespace ?? namespace,
          ts: clock.now(),
          subjectType: input.subjectType,
          subjectKey: input.subjectKey,
          type: input.type,
          attempt: input.attempt ?? null,
          actor: input.actor ?? owner,
          data: input.data ?? {},
        },
      ]);
    } catch (cause) {
      throw wrapStoreError(cause, "appendEvents failed");
    }
    const [event] = events;
    if (event === undefined) {
      throw new SluiceError("E_STORE", "appendEvents returned no event");
    }
    sink?.(event);
    return event;
  }

  /** F11: never surface a driver error — wrap as E_STORE with honest bits. */
  function wrapStoreError(
    cause: unknown,
    message: string,
    opts?: { indeterminate?: boolean }
  ): SluiceError {
    if (cause instanceof SluiceError) return cause;
    return new SluiceError("E_STORE", message, {
      // Before anything executed: safe to retry. After the claim (an effect
      // may be in flight or completed): indeterminate, fail closed.
      retryable: opts?.indeterminate !== true,
      indeterminate: opts?.indeterminate === true,
      cause,
    });
  }

  function toReplayedOutcome<T extends Json>(record: EffectRecord): EffectOutcome<T> {
    if (record.resultOmitted) {
      return {
        status: "replayed",
        value: undefined,
        resultOmitted: true,
        effectId: `${record.namespace}:${record.key}`,
        firstSeenAt: record.createdAt,
      };
    }
    return {
      status: "replayed",
      // The store returns what completeEffect persisted for this key; the
      // caller's T is the same T that produced it (same key ⇒ same intent).
      value: record.result as T,
      effectId: `${record.namespace}:${record.key}`,
      firstSeenAt: record.createdAt,
    };
  }

  function throwTerminalFailure(record: EffectRecord): never {
    const stored = record.error;
    if (record.status === "indeterminate") {
      throw new SluiceError(
        "E_INDETERMINATE",
        "effect outcome is unknown (fail-closed): it may or may not have happened",
        {
          indeterminate: true,
          context: { namespace: record.namespace, key: record.key },
        }
      );
    }
    throw new SluiceError("E_EFFECT_FAILED", stored?.message ?? "effect failed", {
      retryable: false,
      context: {
        namespace: record.namespace,
        key: record.key,
        storedCode: stored?.code ?? null,
      },
    });
  }

  /**
   * Classification precedence (SPEC §5/§6):
   * 1. our own mid-flight abort reason (deadline, lease loss) — indeterminate
   *    by construction: the effect may have been in flight when we pulled the
   *    plug, and only the caller's classify may not overrule fail-closed;
   * 2. `Indeterminate` — the documented forcing wrapper;
   * 3. the caller's `classify`;
   * 4. default: a SluiceError's own bits, otherwise `failed`.
   */
  function classifyThrow(cause: unknown, abortReason: unknown): Classification {
    if (abortReason !== undefined && cause === abortReason) return "indeterminate";
    if (cause instanceof Indeterminate) return "indeterminate";
    if (userClassify !== undefined) return userClassify(cause);
    if (cause instanceof SluiceError) {
      if (cause.indeterminate) return "indeterminate";
      if (cause.retryable) return "retryable";
    }
    return "failed";
  }

  async function run<T extends Json>(
    spec: EffectSpec,
    fn: (ctx: EffectContext) => Promise<T>
  ): Promise<EffectOutcome<T>> {
    if (spec.key.length === 0 || spec.key.length > MAX_KEY_LENGTH) {
      throw new SluiceError(
        "E_CONFIG",
        `effect key must be 1..${String(MAX_KEY_LENGTH)} chars`,
        { context: { keyLength: spec.key.length } }
      );
    }
    const onIndeterminate = spec.onIndeterminate ?? "fail";
    if (onIndeterminate === "gate" && spec.gate === undefined) {
      throw new SluiceError(
        "E_CONFIG",
        "onIndeterminate:'gate' requires a gate spec (SPEC §5: required iff 'gate')",
        { context: { key: spec.key } }
      );
    }
    const ns = spec.namespace ?? namespace;
    const leaseMs = spec.leaseMs ?? DEFAULT_LEASE_MS;
    const deadlineMs = spec.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const effectRetentionMs = spec.retentionMs ?? retentionMs;
    const fingerprint =
      spec.fingerprint === undefined ? null : sha256Hex(canonicalJson(spec.fingerprint));
    const startedAt = clock.now();
    const deadlineAt = startedAt + deadlineMs;

    // Circuit admission comes BEFORE the claim: a granted claim cannot be
    // released, and completing it as failed would poison the key. An open
    // circuit blocks execution but never blocks replay of a recorded outcome.
    let probe = false;
    if (breakers !== null && spec.circuitKey !== undefined) {
      let admission: Admission;
      try {
        admission = await breakers.admit(ns, spec.circuitKey);
      } catch (cause) {
        throw wrapStoreError(cause, "circuit read failed — the effect was not executed");
      }
      if (!admission.admitted) {
        return settleWithoutExecution<T>(spec, ns, fingerprint, onIndeterminate, admission.record);
      }
      probe = admission.probe;
    }

    const claimInput = {
      namespace: ns,
      key: spec.key,
      fingerprint,
      leaseOwner: owner,
      leaseMs,
      retentionMs: effectRetentionMs,
    };

    async function claimGuarded(reclaimIndeterminate: boolean): Promise<ClaimResult> {
      try {
        return await store.claimEffect({
          ...claimInput,
          now: clock.now(),
          reclaimIndeterminate,
        });
      } catch (cause) {
        // F11 before the claim was granted: fn never ran, safe to retry.
        throw wrapStoreError(cause, "claimEffect failed — the effect was not executed");
      }
    }

    for (;;) {
      const claim = await claimGuarded(false);

      if (claim.outcome === "claimed") {
        return execute<T>(spec, fn, claim.record, { ns, leaseMs, deadlineAt, probe });
      }

      let record = claim.record;

      // This claim discovered an expired lease and transitioned the record to
      // indeterminate (F3/F4) — the discoverer writes the audit event (I7).
      if (claim.expired === true) {
        await emit({
          subjectType: "effect",
          subjectKey: spec.key,
          type: "effect.indeterminate",
          attempt: record.attempt,
          namespace: ns,
          data: { reason: "lease_expired" },
        });
      }

      // F9 comes before every policy — a conflicting key may never replay,
      // reclaim, or re-execute.
      if (
        fingerprint !== null &&
        record.fingerprint !== null &&
        record.fingerprint !== fingerprint
      ) {
        await emit({
          subjectType: "effect",
          subjectKey: spec.key,
          type: "effect.key_conflict",
          namespace: ns,
          data: { expected: record.fingerprint, got: fingerprint },
        });
        throw new SluiceError(
          "E_KEY_CONFLICT",
          "idempotency key reused with different arguments",
          { context: { namespace: ns, key: spec.key } }
        );
      }

      if (record.status === "in_flight") {
        record = await waitForTerminal(record, deadlineAt);
      }

      if (record.status === "succeeded") {
        await emit({
          subjectType: "effect",
          subjectKey: spec.key,
          type: "effect.replayed",
          namespace: ns,
          data: { firstSeenAt: record.createdAt },
        });
        return toReplayedOutcome<T>(record);
      }
      if (record.status === "failed") {
        throwTerminalFailure(record);
      }
      if (record.status === "indeterminate") {
        if (onIndeterminate === "reclaim") {
          // Explicit opt-in (F2): the caller declared the downstream
          // idempotent. New conditional claim on the indeterminate record;
          // losing the race just loops back into the normal flow.
          const reclaim = await claimGuarded(true);
          if (reclaim.outcome === "claimed") {
            return execute<T>(spec, fn, reclaim.record, {
              ns,
              leaseMs,
              deadlineAt,
              reclaimed: true,
              probe,
            });
          }
          continue;
        }
        if (onIndeterminate === "gate" && spec.gate !== undefined) {
          // F2 'gate': open the "did this land?" gate (idempotent on its
          // (ns,key)) and STILL fail closed — a human answers out-of-band and
          // a fresh process resumes via gates.claimDecided(). run() never
          // blocks on a human.
          const gate = await gates.open(spec.gate);
          throw new SluiceError(
            "E_INDETERMINATE",
            "effect outcome is unknown; an approval gate is open to resolve it",
            {
              indeterminate: true,
              context: {
                namespace: ns,
                key: spec.key,
                gateId: gate.id,
                gateStatus: gate.status,
              },
            }
          );
        }
        // Default 'fail' (F2/F3/F4): never success, never re-executed.
        throwTerminalFailure(record);
      }
      // in_flight again after the wait loop cannot happen (waitForTerminal
      // only returns terminal records), but keep the loop total anyway.
    }
  }

  /** F1: poll another owner's in-flight record to a terminal state. */
  async function waitForTerminal(
    record: EffectRecord,
    deadlineAt: number
  ): Promise<EffectRecord> {
    let current = record;
    while (current.status === "in_flight") {
      if (clock.now() >= deadlineAt) {
        throw new SluiceError(
          "E_WAIT_TIMEOUT",
          "another owner holds the effect and did not reach a terminal state before the deadline",
          {
            retryable: true,
            context: { namespace: current.namespace, key: current.key },
          }
        );
      }
      await clock.sleep(WAIT_POLL_MS);
      const next = await store
        .readEffect(current.namespace, current.key)
        .catch((cause: unknown) => {
          throw wrapStoreError(cause, "readEffect failed while waiting");
        });
      if (next === null) {
        throw new SluiceError("E_STORE", "effect record disappeared while waiting", {
          indeterminate: true,
          context: { namespace: current.namespace, key: current.key },
        });
      }
      current = next;
    }
    return current;
  }

  /**
   * The circuit refused execution. Recorded outcomes still replay — the
   * breaker protects the downstream, not the ledger — but anything that
   * would EXECUTE (fresh claim, reclaim, waiting on someone else's lease)
   * fails fast with E_CIRCUIT_OPEN.
   */
  async function settleWithoutExecution<T extends Json>(
    spec: EffectSpec,
    ns: string,
    fingerprint: string | null,
    onIndeterminate: "fail" | "reclaim" | "gate",
    circuit: CircuitRecord
  ): Promise<EffectOutcome<T>> {
    const existing = await store.readEffect(ns, spec.key).catch((cause: unknown) => {
      throw wrapStoreError(cause, "readEffect failed while the circuit is open");
    });
    if (
      existing !== null &&
      fingerprint !== null &&
      existing.fingerprint !== null &&
      existing.fingerprint !== fingerprint
    ) {
      // F9 outranks the breaker.
      await emit({
        subjectType: "effect",
        subjectKey: spec.key,
        type: "effect.key_conflict",
        namespace: ns,
        data: { expected: existing.fingerprint, got: fingerprint },
      });
      throw new SluiceError("E_KEY_CONFLICT", "idempotency key reused with different arguments", {
        context: { namespace: ns, key: spec.key },
      });
    }
    if (existing?.status === "succeeded") {
      await emit({
        subjectType: "effect",
        subjectKey: spec.key,
        type: "effect.replayed",
        namespace: ns,
        data: { firstSeenAt: existing.createdAt },
      });
      return toReplayedOutcome<T>(existing);
    }
    if (existing?.status === "failed") throwTerminalFailure(existing);
    if (existing?.status === "indeterminate" && onIndeterminate === "fail") {
      throwTerminalFailure(existing);
    }
    throw new SluiceError("E_CIRCUIT_OPEN", "circuit is open for this circuitKey — failing fast", {
      retryable: true,
      context: {
        namespace: ns,
        key: spec.key,
        circuitKey: spec.circuitKey ?? null,
        state: circuit.state,
        retryAtMs:
          circuit.openedAt !== null && circuit.openMs !== null
            ? circuit.openedAt + circuit.openMs
            : null,
      },
    });
  }

  async function execute<T extends Json>(
    spec: EffectSpec,
    fn: (ctx: EffectContext) => Promise<T>,
    record: EffectRecord,
    o: { ns: string; leaseMs: number; deadlineAt: number; reclaimed?: boolean; probe?: boolean }
  ): Promise<EffectOutcome<T>> {
    const { ns, leaseMs, deadlineAt } = o;
    const policy: RetryPolicy = { ...baseRetryPolicy, ...spec.retry };
    // A half-open probe is ONE downstream attempt by definition (SPEC §5).
    const maxAttempts = o.probe === true ? 1 : Math.max(1, policy.maxAttempts);
    const budgetKey = RetryBudget.key(ns, spec.circuitKey);
    budget.deposit(budgetKey); // every call funds 10% of a retry (F7)
    await emit({
      subjectType: "effect",
      subjectKey: spec.key,
      type: "effect.claimed",
      attempt: record.attempt,
      namespace: ns,
      data: o.reclaimed === true ? { reclaimed: true } : {},
    });

    const abort = new AbortController();
    const deadlineTimer = startDeadlineTimer(abort, deadlineAt);
    const heartbeat = startHeartbeat(abort, { ns, key: spec.key, leaseMs });
    const ctx: EffectContext = {
      effectId: `${ns}:${spec.key}`,
      key: spec.key,
      namespace: ns,
      attempt: record.attempt,
      signal: abort.signal,
      now: () => clock.now(),
      note: (data) => {
        // Fire-and-forget by contract; a note may never fail the effect.
        void emit({
          subjectType: "effect",
          subjectKey: spec.key,
          type: "note",
          attempt: record.attempt,
          namespace: ns,
          data,
        }).catch(() => undefined);
      },
    };

    /** Advisory breaker write — must never fail the caller's effect. */
    const recordOutcome = async (ok: boolean): Promise<void> => {
      if (breakers === null || spec.circuitKey === undefined) return;
      try {
        await breakers.recordOutcome(ns, spec.circuitKey, ok, o.probe === true);
      } catch {
        // Breaker state is advisory; the effect outcome is what matters.
      }
    };

    let value: T;
    try {
      // The retry loop (SPEC §5): full-jitter backoff INSIDE this one lease.
      // Only terminal outcomes ever persist; a retryable throw stays in-loop.
      for (let tries = 1; ; tries++) {
        try {
          value = await fn(ctx);
          await recordOutcome(true);
          break;
        } catch (cause) {
          const classification = classifyThrow(cause, abort.signal.reason);
          // Our own abort (deadline / lease loss) is not downstream health.
          if (cause !== abort.signal.reason) await recordOutcome(false);
          if (classification !== "retryable") {
            return await persistThrow(spec, record, ns, cause, classification);
          }
          if (tries >= maxAttempts) {
            return await persistThrow(spec, record, ns, cause, "retryable", { tries });
          }
          const hint = retryAfterHint(cause, clock.now());
          if (hint !== null && hint.ms > policy.maxRetryAfterMs) {
            // SPEC §5: beyond the cap, fail fast with the header surfaced.
            return await failTerminal(spec, record, ns, cause, {
              code: "E_EFFECT_FAILED",
              message: `Retry-After ${hint.raw} exceeds maxRetryAfterMs — failing fast`,
              context: {
                retryAfter: hint.raw,
                retryAfterMs: hint.ms,
                maxRetryAfterMs: policy.maxRetryAfterMs,
              },
            });
          }
          if (!budget.tryWithdraw(budgetKey)) {
            // F7: the retry-storm defence. Exhaustion is an immediate fast-fail.
            await emit({
              subjectType: "effect",
              subjectKey: spec.key,
              type: "retry.budget_exhausted",
              attempt: record.attempt,
              namespace: ns,
              data: { budgetKey },
            });
            return await failTerminal(spec, record, ns, cause, {
              code: "E_RETRY_BUDGET",
              message: "retry budget exhausted — failing fast instead of amplifying",
              context: { budgetKey },
            });
          }
          const delayMs = hint === null ? backoffDelayMs(policy, tries, random) : hint.ms;
          if (clock.now() + delayMs > deadlineAt) {
            // Between attempts nothing is in flight: the last attempt provably
            // failed, so this is E_DEADLINE on a `failed` record — not
            // indeterminate (contrast with a deadline mid-execution).
            return await failTerminal(spec, record, ns, cause, {
              code: "E_DEADLINE",
              message: "deadline would pass before the next retry",
              context: { tries, delayMs },
            });
          }
          await emit({
            subjectType: "effect",
            subjectKey: spec.key,
            type: "effect.attempt_failed",
            attempt: record.attempt,
            namespace: ns,
            data: {
              try: tries,
              delayMs,
              message: safeMessage(cause),
              ...(hint === null ? {} : { retryAfter: hint.raw }),
            },
          });
          if (delayMs > 0) {
            try {
              await clock.sleep(delayMs, abort.signal);
            } catch {
              const reason: unknown = abort.signal.reason;
              if (reason instanceof SluiceError && reason.code === "E_LEASE_LOST") {
                // The lease vanished while we waited to retry — fail closed.
                return await persistThrow(spec, record, ns, reason, "indeterminate");
              }
              return await failTerminal(spec, record, ns, cause, {
                code: "E_DEADLINE",
                message: "deadline exceeded while waiting to retry",
                context: { tries, delayMs },
              });
            }
          }
        }
      }
      const serialized = canonicalJson(value);
      const tooLarge = utf8Length(serialized) > maxResultBytes;
      try {
        await store.completeEffect({
          namespace: ns,
          key: spec.key,
          leaseOwner: owner,
          status: "succeeded",
          ...(tooLarge ? { resultOmitted: true } : { result: value }),
          now: clock.now(),
        });
      } catch (cause) {
        // The side effect ran but the terminal write did not land (F11 after
        // the claim): indeterminate, fail closed. E_LEASE_LOST passes through.
        throw wrapStoreError(cause, "completeEffect failed after the effect executed", {
          indeterminate: true,
        });
      }
      await emit({
        subjectType: "effect",
        subjectKey: spec.key,
        type: "effect.succeeded",
        attempt: record.attempt,
        namespace: ns,
        data: { resultOmitted: tooLarge },
      });
      return {
        status: "executed",
        value,
        attempts: record.attempt,
        effectId: `${ns}:${spec.key}`,
      };
    } finally {
      deadlineTimer.stop();
      heartbeat.stop();
    }
  }

  /**
   * Terminal handling for a throwing effect function (classification already
   * decided; retryable means retries were exhausted). Always throws.
   */
  async function persistThrow(
    spec: EffectSpec,
    record: EffectRecord,
    ns: string,
    cause: unknown,
    classification: Classification,
    extra?: { tries?: number }
  ): Promise<never> {
    const indeterminate = classification === "indeterminate";
    const stored: StoredError = {
      code:
        cause instanceof SluiceError
          ? cause.code
          : indeterminate
            ? "E_INDETERMINATE"
            : "E_EFFECT_FAILED",
      message: safeMessage(cause),
      retryable: classification === "retryable",
      indeterminate,
    };
    try {
      await store.completeEffect({
        namespace: ns,
        key: spec.key,
        leaseOwner: owner,
        status: indeterminate ? "indeterminate" : "failed",
        error: stored,
        now: clock.now(),
      });
    } catch (persistCause) {
      // Could not record the terminal state: the attempt happened but its
      // outcome is not durable — indeterminate (F11). E_LEASE_LOST surfaces
      // as itself (a stale owner may not write, F8/I8).
      throw wrapStoreError(persistCause, "completeEffect failed after the effect threw", {
        indeterminate: true,
      });
    }
    await emit({
      subjectType: "effect",
      subjectKey: spec.key,
      type: indeterminate ? "effect.indeterminate" : "effect.failed",
      attempt: record.attempt,
      namespace: ns,
      data: { message: stored.message },
    });
    if (indeterminate) {
      throw new SluiceError(
        "E_INDETERMINATE",
        "effect outcome is unknown (fail-closed): it may or may not have happened",
        { indeterminate: true, context: { namespace: ns, key: spec.key }, cause }
      );
    }
    throw new SluiceError("E_EFFECT_FAILED", stored.message, {
      context: {
        namespace: ns,
        key: spec.key,
        ...(extra?.tries === undefined ? {} : { tries: extra.tries }),
      },
      cause,
    });
  }

  /**
   * Persist a `failed` terminal state for a policy-driven fast-fail (retry
   * budget, Retry-After cap, deadline between attempts) and throw the given
   * typed error. Always throws.
   */
  async function failTerminal(
    spec: EffectSpec,
    record: EffectRecord,
    ns: string,
    cause: unknown,
    t: { code: SluiceErrorCode; message: string; context: Record<string, Json> }
  ): Promise<never> {
    const stored: StoredError = {
      code: t.code,
      message: t.message,
      retryable: false,
      indeterminate: false,
    };
    try {
      await store.completeEffect({
        namespace: ns,
        key: spec.key,
        leaseOwner: owner,
        status: "failed",
        error: stored,
        now: clock.now(),
      });
    } catch (persistCause) {
      throw wrapStoreError(persistCause, "completeEffect failed while recording a fast-fail", {
        indeterminate: true,
      });
    }
    await emit({
      subjectType: "effect",
      subjectKey: spec.key,
      type: "effect.failed",
      attempt: record.attempt,
      namespace: ns,
      data: { message: t.message, code: t.code },
    });
    throw new SluiceError(t.code, t.message, {
      context: { namespace: ns, key: spec.key, ...t.context },
      cause,
    });
  }

  function startDeadlineTimer(abort: AbortController, deadlineAt: number): { stop: () => void } {
    // Object property rather than a closed-over boolean: stop() mutates it
    // from outside the async flow, which TS narrowing cannot see on a `let`.
    const state = { stopped: false };
    const wake = new AbortController();
    void (async () => {
      const remaining = deadlineAt - clock.now();
      if (remaining > 0) {
        try {
          await clock.sleep(remaining, wake.signal);
        } catch {
          return; // stop() won the race
        }
      }
      if (!state.stopped) {
        // A deadline that fires mid-execution is F2's exact case — the effect
        // may have been in flight — so the abort reason is indeterminate.
        abort.abort(new SluiceError("E_DEADLINE", "deadline exceeded", { indeterminate: true }));
      }
    })();
    return {
      stop: () => {
        state.stopped = true;
        wake.abort();
      },
    };
  }

  /**
   * Lease heartbeat at leaseMs/3 (SPEC §5) while the effect executes. A lost
   * lease aborts the effect's signal with E_LEASE_LOST; store hiccups are
   * swallowed and retried at the next beat (the lease itself is the backstop).
   */
  function startHeartbeat(
    abort: AbortController,
    o: { ns: string; key: string; leaseMs: number }
  ): { stop: () => void } {
    // Read through a function: stop() mutates from outside this async flow,
    // which TS property narrowing cannot see.
    let stopped = false;
    const isStopped = () => stopped;
    const wake = new AbortController();
    const interval = Math.max(1, Math.floor(o.leaseMs / 3));
    void (async () => {
      for (;;) {
        try {
          await clock.sleep(interval, wake.signal);
        } catch {
          return; // stop() won the race
        }
        if (isStopped()) return;
        try {
          const beat = await store.heartbeatEffect({
            namespace: o.ns,
            key: o.key,
            leaseOwner: owner,
            leaseMs: o.leaseMs,
            now: clock.now(),
          });
          if (!beat.ok) {
            if (!isStopped()) {
              abort.abort(
                new SluiceError("E_LEASE_LOST", "lease lost while the effect was executing", {
                  indeterminate: true,
                  context: { namespace: o.ns, key: o.key },
                })
              );
            }
            return;
          }
        } catch {
          // Store unavailable for one beat: keep trying. If it stays down the
          // lease expires and the record transitions to indeterminate (F3).
        }
      }
    })();
    return {
      stop: () => {
        stopped = true;
        wake.abort();
      },
    };
  }

  /** sluice.gate() sugar: open + waitFor; only an approval returns (SPEC §5). */
  async function gateSugar(
    spec: GateSpec,
    o?: { maxWaitMs?: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<GateRecord & { status: "approved" }> {
    const opened = await gates.open(spec);
    const settled = opened.status === "pending" ? await gates.waitFor(opened.id, o) : opened;
    if (settled.status === "approved") {
      return { ...settled, status: "approved" };
    }
    if (settled.status === "timed_out") {
      throw new SluiceError("E_GATE_TIMEOUT", "gate timed out before a decision (F12)", {
        context: { id: settled.id, key: settled.key },
      });
    }
    throw new SluiceError("E_GATE_REJECTED", "gate was not approved", {
      context: {
        id: settled.id,
        key: settled.key,
        status: settled.status,
        decidedBy: settled.decidedBy,
        reason: settled.decisionReason,
      },
    });
  }

  return {
    run,
    inspect: (key, ns) => store.readEffect(ns ?? namespace, key),
    sweep: (now) => store.sweep(now ?? clock.now()),
    gates,
    gate: gateSugar,
    audit: {
      append: emit,
      since: (cursor, limit) => store.readEvents(cursor.namespace, cursor.seq, limit ?? 100),
    },
  };
}

function safeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "effect threw a non-Error value";
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
