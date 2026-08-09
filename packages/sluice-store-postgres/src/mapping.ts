/**
 * Row <-> record mapping. Raw `db.execute(sql\`...\`)` queries return rows
 * keyed by the literal column names in the SQL (snake_case) — Drizzle's
 * camelCase mapping only applies to the fluent query builder, not to
 * `execute()`. Every store method goes through these mappers so the
 * snake_case boundary stays in exactly one place.
 */
import type {
  CircuitRecord,
  CircuitState,
  EffectRecord,
  EffectStatus,
  GateAction,
  GatePresentation,
  GateRecord,
  GateStatus,
  Json,
  StoredError,
} from "@jamessuuu/sluice";

/**
 * jsonb columns come back already-parsed as JS values from both node-postgres
 * and pglite (their default type parsers JSON.parse jsonb/json OIDs) — but a
 * driver swapped in later (SPEC §12.4 says any Drizzle instance must work)
 * might not. Defensive either way, and cheap. Returns `unknown`, not a
 * generic `T`: every call site already knows (and asserts) the shape it
 * expects, so a generic here would only be inferred from that assertion —
 * type-checked in appearance only.
 */
export function parseJsonb(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

/**
 * Coerce a `bigint`-column driver value to the `number` every `SluiceStore`
 * method is typed to return (types.ts). This exists because
 * `db.execute(sql\`...\`)` bypasses Drizzle's own `{ mode: "number" }`
 * column-mode conversion — that conversion is wired into the fluent query
 * builder's row mapper, which raw `execute()` never runs (see this file's
 * header comment) — so the RAW driver's default int8 (OID 20) type parser
 * applies instead, and that parser is driver-specific:
 *
 *   - node-postgres (`pg`, used by `drizzle-orm/node-postgres` — the real
 *     Postgres path CI exercises against `postgres:17`) returns int8 as a
 *     STRING. This is `pg`'s documented, deliberate default: int8 can
 *     exceed `Number.MAX_SAFE_INTEGER` in general, so the driver refuses to
 *     silently risk precision loss.
 *   - pglite's default int8 parser returns a `number` — which is why the
 *     always-on local suite (store.conformance.test.ts) never caught this;
 *     it only ever ran the string-returning path in CI, against real
 *     Postgres (store.real.test.ts).
 *
 * Every `bigint` column this schema defines (schema.ts) stores an epoch-
 * millisecond timestamp or the monotonic `seq` — both stay far inside
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1 = 9,007,199,254,740,991; at
 * millisecond resolution that's the year 287396, per schema.ts's header),
 * so `Number(value)` never loses precision for any value this store
 * actually writes.
 *
 * A global `pg.types.setTypeParser(20, ...)` was deliberately rejected in
 * favor of this per-field coercion: a type parser is registered once on
 * `pg.types` (or a `Pool`'s shared `types` option) and applies to EVERY
 * int8 column that consumer's entire application queries through that
 * driver instance — not just sluice's own tables. This package never
 * imports `pg` as a runtime dependency (store.ts's header) specifically so
 * it stays a well-behaved library; reaching into the driver's global type
 * registry to fix its own bug would violate that same principle by
 * silently changing bigint behaviour for code this package doesn't own.
 * Coercing only the columns this store reads, at the point each row is
 * mapped into a record, keeps the fix local to this package's own output.
 */
export function toNumber(value: number | string | bigint): number {
  return typeof value === "number" ? value : Number(value);
}

/** {@link toNumber}, nullable — for the `bigint` columns that allow NULL. */
export function toNumberOrNull(value: number | string | bigint | null): number | null {
  return value === null ? null : toNumber(value);
}

/**
 * `extends Record<string, unknown>` (not just a closed shape): rows come
 * back from `db.execute()`, whose generic `TRow` is constrained to
 * `Record<string, unknown>` across every Drizzle Postgres driver — these
 * interfaces describe the known columns while staying assignable there.
 *
 * `bigint` columns are typed `number | string` (nullable ones
 * `number | string | null`), not bare `number`: that is what the driver
 * can actually hand back for an int8 column (see {@link toNumber}), and
 * every such field is run through `toNumber`/`toNumberOrNull` below before
 * it reaches the `EffectRecord`/`GateRecord`/`CircuitRecord` the interface
 * promises callers a plain `number`.
 */
export interface EffectRow extends Record<string, unknown> {
  namespace: string;
  key: string;
  fingerprint: string | null;
  status: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: number | string | null;
  result_json: unknown;
  result_omitted: boolean;
  error_json: unknown;
  created_at: number | string;
  updated_at: number | string;
  expires_at: number | string;
}

export function mapEffectRow(row: EffectRow): EffectRecord {
  return {
    namespace: row.namespace,
    key: row.key,
    fingerprint: row.fingerprint,
    status: row.status as EffectStatus,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toNumberOrNull(row.lease_expires_at),
    result: row.result_json === null ? null : (parseJsonb(row.result_json) as Json),
    resultOmitted: row.result_omitted,
    error: row.error_json === null ? null : (parseJsonb(row.error_json) as StoredError),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
    expiresAt: toNumber(row.expires_at),
  };
}

export interface GateRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  key: string;
  status: string;
  action_json: unknown;
  presentation_json: unknown;
  requester_json: unknown;
  approvers: string[];
  on_timeout: string;
  resume_context_json: unknown;
  created_at: number | string;
  expires_at: number | string;
  decided_at: number | string | null;
  decided_by: string | null;
  decision_reason: string | null;
  token_hash: string | null;
  token_nonce: string | null;
  claim_owner: string | null;
  claim_expires_at: number | string | null;
  processed_at: number | string | null;
}

export function mapGateRow(row: GateRow): GateRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    status: row.status as GateStatus,
    action: parseJsonb(row.action_json) as GateAction,
    presentation:
      row.presentation_json === null
        ? null
        : (parseJsonb(row.presentation_json) as GatePresentation),
    requester: parseJsonb(row.requester_json) as { actor: string; runId: string | null },
    approvers: [...row.approvers],
    onTimeout: row.on_timeout as "reject" | "approve",
    resumeContext:
      row.resume_context_json === null ? null : (parseJsonb(row.resume_context_json) as Json),
    createdAt: toNumber(row.created_at),
    expiresAt: toNumber(row.expires_at),
    decidedAt: toNumberOrNull(row.decided_at),
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    tokenHash: row.token_hash,
    tokenNonce: row.token_nonce,
    claimOwner: row.claim_owner,
    claimExpiresAt: toNumberOrNull(row.claim_expires_at),
    processedAt: toNumberOrNull(row.processed_at),
  };
}

export interface CircuitRow extends Record<string, unknown> {
  key: string;
  state: string;
  /** `integer` (int4), not `bigint` — node-postgres always returns int4 as a `number`. */
  version: number;
  window_json: unknown;
  opened_at: number | string | null;
  /** `integer` (int4), not `bigint` — see `version` above. */
  open_ms: number | null;
  half_open_owner: string | null;
  half_open_expires_at: number | string | null;
  updated_at: number | string;
}

interface WindowJson {
  outcomes: number[];
  consecutiveOpens: number;
}

export function mapCircuitRow(row: CircuitRow): CircuitRecord {
  const window = parseJsonb(row.window_json) as WindowJson;
  return {
    key: row.key,
    state: row.state as CircuitState,
    version: row.version,
    window: [...window.outcomes],
    openedAt: toNumberOrNull(row.opened_at),
    openMs: row.open_ms,
    consecutiveOpens: window.consecutiveOpens,
    halfOpenOwner: row.half_open_owner,
    halfOpenExpiresAt: toNumberOrNull(row.half_open_expires_at),
    updatedAt: toNumber(row.updated_at),
  };
}

export function circuitWindowJson(window: readonly number[], consecutiveOpens: number): string {
  return JSON.stringify({ outcomes: [...window], consecutiveOpens } satisfies WindowJson);
}

/**
 * A Postgres `text[]` array literal, e.g. `{"a","b"}`. Deliberately NOT
 * interpolating a JS array directly into a `sql\`...\`` template: Drizzle's
 * tag treats an interpolated array as a comma-spliced LIST of placeholders
 * (built for `IN (${values})`), not a single array-typed bind parameter —
 * an empty `approvers: []` renders as literal `()`, a syntax error. A
 * pre-built literal string bound as one text parameter and cast `::text[]`
 * sidesteps that entirely.
 */
export function pgTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}
