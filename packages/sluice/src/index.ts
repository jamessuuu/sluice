/**
 * @jamessuuu/sluice — exactly-once side effects for agent tool calls, plus
 * durable human approval gates. Zero runtime dependencies.
 *
 * M1 surface: createSluice + run() (claim → execute → persist → replay),
 * MemoryStore, idempotencyKey, audit events (unchained). Gates land in M4,
 * retries/breaker in M3, hash-chained audit in M9. See docs/SPEC.md.
 */

export const SLUICE_VERSION = "0.1.0-alpha.0";

export { canonicalJson, type Json } from "./json.js";
export { sha256Hex } from "./sha256.js";
export { MemoryStore } from "./memory-store.js";
export { createSluice, idempotencyKey, type Sluice, type SluiceOptions } from "./sluice.js";
export {
  Indeterminate,
  SluiceError,
  systemClock,
  type AuditEvent,
  type AuditEventType,
  type AuditInput,
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
  type SluiceErrorCode,
  type SluiceStore,
  type StoredError,
} from "./types.js";
