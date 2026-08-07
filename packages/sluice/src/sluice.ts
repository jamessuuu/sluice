import { canonicalJson, type Json } from "./json.js";
import { sha256Hex } from "./sha256.js";
import {
  Indeterminate,
  SluiceError,
  systemClock,
  type AuditEvent,
  type AuditInput,
  type Clock,
  type EffectContext,
  type EffectOutcome,
  type EffectRecord,
  type EffectSpec,
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
  retentionMs?: number;
  maxResultBytes?: number;
  audit?: { sink?: (e: AuditEvent) => void };
}

export interface Sluice {
  run<T extends Json>(
    spec: EffectSpec,
    fn: (ctx: EffectContext) => Promise<T>
  ): Promise<EffectOutcome<T>>;
  inspect(key: string, namespace?: string): Promise<EffectRecord | null>;
  sweep(now?: number): Promise<{ effects: number; gates: number; events: number }>;
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
  const sink = options.audit?.sink;

  async function emit(input: AuditInput): Promise<AuditEvent> {
    const [event] = await store.appendEvents([
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
    if (event === undefined) {
      throw new SluiceError("E_STORE", "appendEvents returned no event");
    }
    sink?.(event);
    return event;
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

  async function settleExisting<T extends Json>(
    record: EffectRecord,
    fingerprint: string | null,
    deadlineAt: number
  ): Promise<EffectOutcome<T>> {
    if (
      fingerprint !== null &&
      record.fingerprint !== null &&
      record.fingerprint !== fingerprint
    ) {
      await emit({
        subjectType: "effect",
        subjectKey: record.key,
        type: "effect.key_conflict",
        data: { expected: record.fingerprint, got: fingerprint },
      });
      throw new SluiceError(
        "E_KEY_CONFLICT",
        "idempotency key reused with different arguments",
        { context: { namespace: record.namespace, key: record.key } }
      );
    }

    let current = record;
    // F1: another owner is executing. Poll to terminal state, bounded by the
    // caller's deadline. Never a second execution.
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
      const next = await store.readEffect(current.namespace, current.key);
      if (next === null) {
        throw new SluiceError("E_STORE", "effect record disappeared while waiting", {
          indeterminate: true,
          context: { namespace: current.namespace, key: current.key },
        });
      }
      current = next;
    }

    if (current.status === "succeeded") {
      await emit({
        subjectType: "effect",
        subjectKey: current.key,
        type: "effect.replayed",
        data: { firstSeenAt: current.createdAt },
      });
      return toReplayedOutcome<T>(current);
    }
    throwTerminalFailure(current);
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
    const ns = spec.namespace ?? namespace;
    const leaseMs = spec.leaseMs ?? DEFAULT_LEASE_MS;
    const deadlineMs = spec.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const effectRetentionMs = spec.retentionMs ?? retentionMs;
    const fingerprint =
      spec.fingerprint === undefined ? null : sha256Hex(canonicalJson(spec.fingerprint));
    const startedAt = clock.now();
    const deadlineAt = startedAt + deadlineMs;

    const claim = await store.claimEffect({
      namespace: ns,
      key: spec.key,
      fingerprint,
      leaseOwner: owner,
      leaseMs,
      retentionMs: effectRetentionMs,
      now: startedAt,
    });

    if (claim.outcome === "exists") {
      return settleExisting<T>(claim.record, fingerprint, deadlineAt);
    }

    const record = claim.record;
    await emit({
      subjectType: "effect",
      subjectKey: spec.key,
      type: "effect.claimed",
      attempt: record.attempt,
      namespace: ns,
    });

    const abort = new AbortController();
    const deadlineTimer = deadlineTimeout(abort, deadlineAt);
    const ctx: EffectContext = {
      effectId: `${ns}:${spec.key}`,
      key: spec.key,
      namespace: ns,
      attempt: record.attempt,
      signal: abort.signal,
      now: () => clock.now(),
      note: (data) => {
        void emit({
          subjectType: "effect",
          subjectKey: spec.key,
          type: "note",
          attempt: record.attempt,
          namespace: ns,
          data,
        });
      },
    };

    try {
      const value = await fn(ctx);
      const serialized = canonicalJson(value);
      const tooLarge = utf8Length(serialized) > maxResultBytes;
      await store.completeEffect({
        namespace: ns,
        key: spec.key,
        leaseOwner: owner,
        status: "succeeded",
        ...(tooLarge ? { resultOmitted: true } : { result: value }),
        now: clock.now(),
      });
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
    } catch (cause) {
      const classified = classifyThrow(cause);
      const stored: StoredError = {
        code: classified.indeterminate ? "E_INDETERMINATE" : "E_EFFECT_FAILED",
        message: safeMessage(cause),
        retryable: false,
        indeterminate: classified.indeterminate,
      };
      await store.completeEffect({
        namespace: ns,
        key: spec.key,
        leaseOwner: owner,
        status: classified.indeterminate ? "indeterminate" : "failed",
        error: stored,
        now: clock.now(),
      });
      await emit({
        subjectType: "effect",
        subjectKey: spec.key,
        type: classified.indeterminate ? "effect.indeterminate" : "effect.failed",
        attempt: record.attempt,
        namespace: ns,
        data: { message: stored.message },
      });
      if (classified.indeterminate) {
        throw new SluiceError(
          "E_INDETERMINATE",
          "effect outcome is unknown (fail-closed): it may or may not have happened",
          { indeterminate: true, context: { namespace: ns, key: spec.key }, cause }
        );
      }
      throw new SluiceError("E_EFFECT_FAILED", stored.message, {
        context: { namespace: ns, key: spec.key },
        cause,
      });
    } finally {
      deadlineTimer.clear();
    }
  }

  function deadlineTimeout(abort: AbortController, deadlineAt: number): { clear: () => void } {
    // Object property rather than a closed-over boolean: clear() mutates it
    // from outside the async flow, which TS narrowing cannot see on a `let`.
    const state = { cleared: false };
    void (async () => {
      const remaining = deadlineAt - clock.now();
      if (remaining <= 0) {
        abort.abort(new SluiceError("E_DEADLINE", "deadline exceeded"));
        return;
      }
      try {
        await clock.sleep(remaining);
      } catch {
        return; // sleep aborted — clear() won the race
      }
      if (!state.cleared) {
        abort.abort(new SluiceError("E_DEADLINE", "deadline exceeded"));
      }
    })();
    return {
      clear: () => {
        state.cleared = true;
      },
    };
  }

  return {
    run,
    inspect: (key, ns) => store.readEffect(ns ?? namespace, key),
    sweep: (now) => store.sweep(now ?? clock.now()),
    audit: {
      append: emit,
      since: (cursor, limit) => store.readEvents(cursor.namespace, cursor.seq, limit ?? 100),
    },
  };
}

function classifyThrow(cause: unknown): { indeterminate: boolean } {
  if (cause instanceof Indeterminate) return { indeterminate: true };
  if (cause instanceof SluiceError && cause.indeterminate) return { indeterminate: true };
  return { indeterminate: false };
}

function safeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "effect threw a non-Error value";
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
