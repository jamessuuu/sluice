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
 * `extends Record<string, unknown>` (not just a closed shape): rows come
 * back from `db.execute()`, whose generic `TRow` is constrained to
 * `Record<string, unknown>` across every Drizzle Postgres driver — these
 * interfaces describe the known columns while staying assignable there.
 */
export interface EffectRow extends Record<string, unknown> {
  namespace: string;
  key: string;
  fingerprint: string | null;
  status: string;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  result_json: unknown;
  result_omitted: boolean;
  error_json: unknown;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export function mapEffectRow(row: EffectRow): EffectRecord {
  return {
    namespace: row.namespace,
    key: row.key,
    fingerprint: row.fingerprint,
    status: row.status as EffectStatus,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result_json === null ? null : (parseJsonb(row.result_json) as Json),
    resultOmitted: row.result_omitted,
    error: row.error_json === null ? null : (parseJsonb(row.error_json) as StoredError),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
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
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  decision_reason: string | null;
  token_hash: string | null;
  token_nonce: string | null;
  claim_owner: string | null;
  claim_expires_at: number | null;
  processed_at: number | null;
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
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    tokenHash: row.token_hash,
    tokenNonce: row.token_nonce,
    claimOwner: row.claim_owner,
    claimExpiresAt: row.claim_expires_at,
    processedAt: row.processed_at,
  };
}

export interface CircuitRow extends Record<string, unknown> {
  key: string;
  state: string;
  version: number;
  window_json: unknown;
  opened_at: number | null;
  open_ms: number | null;
  half_open_owner: string | null;
  half_open_expires_at: number | null;
  updated_at: number;
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
    openedAt: row.opened_at,
    openMs: row.open_ms,
    consecutiveOpens: window.consecutiveOpens,
    halfOpenOwner: row.half_open_owner,
    halfOpenExpiresAt: row.half_open_expires_at,
    updatedAt: row.updated_at,
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
