/**
 * Drizzle schema for the five sluice tables (SPEC §3).
 *
 * Timestamp columns are `bigint` epoch-milliseconds, NOT `timestamptz`.
 * Deviation from the SPEC's literal column-type prose, made deliberately:
 * every store method takes an explicit `now: number` from the caller's
 * (possibly virtual) clock — the store must never consult Postgres' own
 * `now()`, or the chaos harness's VirtualClock and the Postgres store would
 * disagree about time. `EffectRecord`/`GateRecord`/`CircuitRecord` are all
 * typed as plain `number` timestamps in `types.ts`; bigint-as-number columns
 * round-trip that exactly with zero timezone-conversion surface. (Millisecond
 * epoch values stay well inside JS's safe-integer range until the year
 * 287396 — `{ mode: "number" }` is safe here.)
 *
 * `status` / `type` / `subject_type` / `on_timeout` columns are plain `text`
 * with no CHECK constraint or Postgres ENUM. This is also deliberate: the
 * app-level TypeScript union types are the source of truth, and a future
 * milestone that adds a new status or event type (M9 adds none today, but
 * the pattern generalizes) never needs a migration to widen a CHECK/ENUM —
 * staying additive-only (SPEC §3) for free.
 *
 * Two schema additions beyond SPEC §3's bare column list, both noted at M4
 * (types.ts) and required by the M6 brief:
 *   - `sluice_gate.on_timeout` — its own column (not packed into
 *     `action_json`, which is the caller-supplied action payload; keeping
 *     policy out of user data is worth a genuinely additive column).
 *   - `sluice_circuit.window_json` carries `{ outcomes, consecutiveOpens }`
 *     instead of a bare array, exactly as flagged in types.ts — doubling a
 *     jittered `openMs` needs the un-jittered consecutive-open count, which
 *     §3's column list has nowhere else to live.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";

// ── sluice_effect ────────────────────────────────────────────────────────────

export const effects = pgTable(
  "sluice_effect",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint"),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    resultJson: jsonb("result_json"),
    resultOmitted: boolean("result_omitted").notNull().default(false),
    errorJson: jsonb("error_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.key] }),
    index("sluice_effect_expires_at_idx").on(t.expiresAt),
    index("sluice_effect_status_lease_idx").on(t.status, t.leaseExpiresAt),
  ]
);

// ── sluice_gate ──────────────────────────────────────────────────────────────

export const gates = pgTable(
  "sluice_gate",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    status: text("status").notNull(),
    actionJson: jsonb("action_json").notNull(),
    presentationJson: jsonb("presentation_json"),
    requesterJson: jsonb("requester_json").notNull(),
    approvers: text("approvers")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    onTimeout: text("on_timeout").notNull().default("reject"),
    resumeContextJson: jsonb("resume_context_json"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    decidedAt: bigint("decided_at", { mode: "number" }),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
    tokenHash: text("token_hash"),
    tokenNonce: text("token_nonce"),
    claimOwner: text("claim_owner"),
    claimExpiresAt: bigint("claim_expires_at", { mode: "number" }),
    processedAt: bigint("processed_at", { mode: "number" }),
  },
  (t) => [
    unique("sluice_gate_namespace_key_key").on(t.namespace, t.key),
    index("sluice_gate_status_expires_idx").on(t.status, t.expiresAt),
    index("sluice_gate_namespace_status_idx").on(t.namespace, t.status),
    index("sluice_gate_status_decided_idx").on(t.status, t.decidedAt),
  ]
);

// ── sluice_event + sluice_cursor ────────────────────────────────────────────

export const events = pgTable(
  "sluice_event",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    subjectType: text("subject_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    type: text("type").notNull(),
    attempt: integer("attempt"),
    actor: text("actor").notNull(),
    dataJson: jsonb("data_json").notNull().default({}),
    prevHash: text("prev_hash"),
    hash: text("hash"),
  },
  (t) => [unique("sluice_event_namespace_seq_key").on(t.namespace, t.seq)]
);

export const cursors = pgTable("sluice_cursor", {
  namespace: text("namespace").primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  // Genesis head is the empty string, not NULL — every SQL append computes
  // `sha256(coalesce(head_hash, '') || payload)`, and starting from '' keeps
  // that coalesce a no-op rather than a genesis special case.
  headHash: text("head_hash").notNull().default(""),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ── sluice_circuit ───────────────────────────────────────────────────────────

export const circuits = pgTable("sluice_circuit", {
  key: text("key").primaryKey(),
  state: text("state").notNull(),
  version: integer("version").notNull().default(1),
  /** `{ outcomes: number[]; consecutiveOpens: number }` — see file header. */
  windowJson: jsonb("window_json").notNull(),
  openedAt: bigint("opened_at", { mode: "number" }),
  openMs: integer("open_ms"),
  halfOpenOwner: text("half_open_owner"),
  halfOpenExpiresAt: bigint("half_open_expires_at", { mode: "number" }),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
