/**
 * @jamessuuu/sluice — exactly-once side effects for agent tool calls, plus
 * durable human approval gates. Zero runtime dependencies.
 *
 * Surface as of M4: createSluice + run() (claim → execute with in-lease
 * retries/breaker → persist → replay), failure semantics (classify, lease
 * heartbeat, expiry → indeterminate, onIndeterminate policies), gates
 * (open/decide/waitFor/claimDecided + HMAC approval tokens), MemoryStore,
 * idempotencyKey, audit events (unchained — the hash chain lands in M9).
 * See docs/SPEC.md.
 */

export const SLUICE_VERSION = "0.1.0-alpha.0";

export { canonicalJson, type Json } from "./json.js";
export { sha256Hex } from "./sha256.js";
export { hmacSha256Hex, timingSafeEqualHex } from "./hmac.js";
export { uuidv7 } from "./uuid.js";
export { MemoryStore } from "./memory-store.js";
export { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";
export { DEFAULT_CIRCUIT_POLICY } from "./circuit.js";
export { type GatesApi } from "./gates.js";
export { createSluice, idempotencyKey, type Sluice, type SluiceOptions } from "./sluice.js";
export {
  Indeterminate,
  SluiceError,
  systemClock,
  type AuditEvent,
  type AuditEventType,
  type AuditInput,
  type CircuitPolicy,
  type CircuitRecord,
  type CircuitState,
  type ClaimResult,
  type Classification,
  type ClassifyFn,
  type Clock,
  type CompleteEffectInput,
  type EffectContext,
  type EffectOutcome,
  type EffectRecord,
  type EffectSpec,
  type EffectStatus,
  type GateAction,
  type GateClaim,
  type GatePresentation,
  type GateRecord,
  type GateSpec,
  type GateStatus,
  type SluiceErrorCode,
  type SluiceStore,
  type StoredError,
} from "./types.js";
