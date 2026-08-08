/**
 * @jamessuuu/sluice-store-postgres — Drizzle/Neon store adapter (SPEC §3, §5,
 * §12.4). Every method below is EXACTLY ONE round-tripped SQL statement for
 * its mutation, which is what lets this run over the Neon HTTP driver (no
 * interactive transactions, no BEGIN/COMMIT held across an await). Where a
 * conditional write can legitimately match zero rows (a claim that isn't
 * granted, a decide that lost the race, a CAS write that's stale), that zero
 * -row result is itself the single statement's answer; a second, read-only
 * SELECT then fetches the current row purely to shape the return value —
 * SPEC §3's own claim example describes exactly this two-step "zero rows
 * returned ⇒ read the existing row" pattern, and it never changes what the
 * one write statement already decided.
 *
 * Entry point takes any Drizzle `PgDatabase` instance (SPEC §12.4, the
 * preferred option over shipping separate node-postgres/Neon factories) — a
 * consumer builds their own `drizzle(...)` with whichever driver they want
 * and hands it in. This package never imports `pg`, `@neondatabase/serverless`,
 * or any concrete driver as a runtime dependency.
 */
import { canonicalJson, SluiceError, type Json } from "@jamessuuu/sluice";
import type {
  AuditEvent,
  CircuitRecord,
  ClaimResult,
  CompleteEffectInput,
  EffectRecord,
  GateRecord,
  SluiceStore,
  StoredError,
} from "@jamessuuu/sluice";
import { sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { wrapDbError } from "./errors.js";
import {
  circuitWindowJson,
  mapCircuitRow,
  mapEffectRow,
  mapGateRow,
  pgTextArrayLiteral,
  type CircuitRow,
  type EffectRow,
  type GateRow,
} from "./mapping.js";

/** Any Drizzle Postgres database instance — node-postgres, Neon HTTP, pglite, ... */
export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

interface EventRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  seq: number;
  ts: number;
  subject_type: string;
  subject_key: string;
  type: string;
  attempt: number | null;
  actor: string;
  data_json: unknown;
  prev_hash: string | null;
  hash: string | null;
}

function mapEventRow(row: EventRow): AuditEvent {
  return {
    id: row.id,
    namespace: row.namespace,
    seq: row.seq,
    ts: row.ts,
    subjectType: row.subject_type as AuditEvent["subjectType"],
    subjectKey: row.subject_key,
    type: row.type as AuditEvent["type"],
    attempt: row.attempt,
    actor: row.actor,
    data:
      typeof row.data_json === "string"
        ? (JSON.parse(row.data_json) as Record<string, Json>)
        : (row.data_json as Record<string, Json>),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

const LEASE_LOST_ERROR: StoredError = {
  code: "E_LEASE_LOST",
  message: "lease expired before a terminal state was recorded",
  retryable: false,
  indeterminate: true,
};

/**
 * Build a `SluiceStore` on top of an already-constructed Drizzle instance.
 * The generic parameter is inferred from `db`, so this accepts a
 * `NodePgDatabase`, a `NeonHttpDatabase`, a `PgliteDatabase`, or any other
 * first-party Drizzle Postgres driver without a cast at the call site.
 */
export function createPostgresStore<TQueryResult extends PgQueryResultHKT>(
  db: PgDatabase<TQueryResult, Record<string, unknown>>
): SluiceStore {
  /**
   * Every Drizzle Postgres driver (node-postgres, neon-http, neon-serverless,
   * postgres-js, pglite) normalizes `execute()` to `{ rows: T[] }` — that
   * contract is stable across the whole driver family, just not statically
   * visible through the abstract `TQueryResult` HKT this function is generic
   * over. One documented assertion here stands in for a driver-specific cast
   * in every method below.
   */
  async function exec<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
    const result = await db.execute<TRow>(query);
    return (result as unknown as { rows: TRow[] }).rows;
  }

  async function execWrapped<TRow extends Record<string, unknown>>(
    query: SQL,
    message: string,
    opts?: { indeterminate?: boolean }
  ): Promise<TRow[]> {
    try {
      return await exec<TRow>(query);
    } catch (cause) {
      throw wrapDbError(cause, message, opts);
    }
  }

  async function selectEffect(namespace: string, key: string): Promise<EffectRecord | null> {
    const rows = await execWrapped<EffectRow>(
      sql`SELECT * FROM sluice_effect WHERE namespace = ${namespace} AND key = ${key}`,
      "readEffect failed"
    );
    const row = rows[0];
    return row === undefined ? null : mapEffectRow(row);
  }

  async function selectGateByKey(namespace: string, key: string): Promise<GateRecord | null> {
    const rows = await execWrapped<GateRow>(
      sql`SELECT * FROM sluice_gate WHERE namespace = ${namespace} AND key = ${key}`,
      "openGate failed"
    );
    const row = rows[0];
    return row === undefined ? null : mapGateRow(row);
  }

  async function selectGateById(id: string): Promise<GateRecord | null> {
    const rows = await execWrapped<GateRow>(
      sql`SELECT * FROM sluice_gate WHERE id = ${id}`,
      "readGate failed"
    );
    const row = rows[0];
    return row === undefined ? null : mapGateRow(row);
  }

  async function selectCircuit(key: string): Promise<CircuitRecord | null> {
    const rows = await execWrapped<CircuitRow>(
      sql`SELECT * FROM sluice_circuit WHERE key = ${key}`,
      "readCircuit failed"
    );
    const row = rows[0];
    return row === undefined ? null : mapCircuitRow(row);
  }

  return {
    // ── effects ──────────────────────────────────────────────────────────
    async claimEffect(input): Promise<ClaimResult> {
      const reclaim = input.reclaimIndeterminate === true;
      const newLeaseExpiresAt = input.now + input.leaseMs;
      const newExpiresAt = input.now + input.retentionMs;
      const rows = await execWrapped<EffectRow>(
        sql`
          INSERT INTO sluice_effect
            (namespace, key, fingerprint, status, attempt, lease_owner, lease_expires_at,
             result_json, result_omitted, error_json, created_at, updated_at, expires_at)
          VALUES
            (${input.namespace}, ${input.key}, ${input.fingerprint}, 'in_flight', 1,
             ${input.leaseOwner}, ${newLeaseExpiresAt}, NULL, false, NULL,
             ${input.now}, ${input.now}, ${newExpiresAt})
          ON CONFLICT (namespace, key) DO UPDATE SET
            status = CASE
              WHEN sluice_effect.status = 'indeterminate' THEN 'in_flight'
              ELSE 'indeterminate'
            END,
            attempt = CASE
              WHEN sluice_effect.status = 'indeterminate' THEN sluice_effect.attempt + 1
              ELSE sluice_effect.attempt
            END,
            lease_owner = CASE
              WHEN sluice_effect.status = 'indeterminate' THEN ${input.leaseOwner}::text
              ELSE NULL
            END,
            lease_expires_at = CASE
              WHEN sluice_effect.status = 'indeterminate' THEN ${newLeaseExpiresAt}::bigint
              ELSE NULL
            END,
            error_json = CASE
              WHEN sluice_effect.status = 'indeterminate' THEN NULL
              ELSE ${JSON.stringify(LEASE_LOST_ERROR)}::jsonb
            END,
            updated_at = ${input.now}
          WHERE
            (${reclaim}::boolean AND sluice_effect.status = 'indeterminate')
            OR (sluice_effect.status = 'in_flight' AND sluice_effect.lease_expires_at < ${input.now})
          RETURNING *;
        `,
        "claimEffect failed"
      );
      const row = rows[0];
      if (row !== undefined) {
        const record = mapEffectRow(row);
        if (record.status === "in_flight") {
          return { outcome: "claimed", record };
        }
        return { outcome: "exists", record, expired: true };
      }
      // WHERE matched zero rows: the row exists and none of the mutation
      // conditions applied (live lease held elsewhere, a terminal record, or
      // an indeterminate record with no reclaim opt-in) — read it as-is
      // (SPEC §3: "Zero rows returned ⇒ read the existing row and branch").
      const existing = await selectEffect(input.namespace, input.key);
      if (existing === null) {
        throw new SluiceError(
          "E_STORE",
          "claimEffect: expected an existing row after a no-op conditional write",
          { context: { namespace: input.namespace, key: input.key } }
        );
      }
      return { outcome: "exists", record: existing };
    },

    async completeEffect(input: CompleteEffectInput & { now: number }): Promise<EffectRecord> {
      const resultJson =
        input.resultOmitted === true || input.result === undefined
          ? null
          : JSON.stringify(input.result);
      const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
      const rows = await execWrapped<EffectRow>(
        sql`
          UPDATE sluice_effect SET
            status = ${input.status},
            lease_owner = NULL,
            lease_expires_at = NULL,
            result_json = ${resultJson}::jsonb,
            result_omitted = ${input.resultOmitted ?? false},
            error_json = ${errorJson}::jsonb,
            updated_at = ${input.now}
          WHERE namespace = ${input.namespace} AND key = ${input.key}
            AND status = 'in_flight' AND lease_owner = ${input.leaseOwner}
          RETURNING *;
        `,
        "completeEffect failed",
        // The effect already executed by the time completeEffect is called
        // (F11) — an unexpected driver failure here must fail closed, not
        // come back looking safely retryable. See errors.ts's wrapDbError.
        { indeterminate: true }
      );
      const row = rows[0];
      if (row !== undefined) return mapEffectRow(row);
      const existing = await selectEffect(input.namespace, input.key);
      if (existing === null) {
        throw new SluiceError("E_STORE", "completeEffect: record not found", {
          context: { namespace: input.namespace, key: input.key },
        });
      }
      throw new SluiceError("E_LEASE_LOST", "completeEffect: lease not held", {
        indeterminate: true,
        context: {
          namespace: input.namespace,
          key: input.key,
          status: existing.status,
        },
      });
    },

    async heartbeatEffect(input): Promise<{ ok: boolean }> {
      const rows = await execWrapped<{ ok: number } & Record<string, unknown>>(
        sql`
          UPDATE sluice_effect SET lease_expires_at = ${input.now + input.leaseMs}, updated_at = ${input.now}
          WHERE namespace = ${input.namespace} AND key = ${input.key}
            AND status = 'in_flight' AND lease_owner = ${input.leaseOwner}
          RETURNING 1 AS ok;
        `,
        "heartbeatEffect failed"
      );
      return { ok: rows.length > 0 };
    },

    async readEffect(namespace, key): Promise<EffectRecord | null> {
      return selectEffect(namespace, key);
    },

    // ── gates ────────────────────────────────────────────────────────────
    async openGate(candidate: GateRecord): Promise<{ created: boolean; record: GateRecord }> {
      const rows = await execWrapped<GateRow>(
        sql`
          INSERT INTO sluice_gate
            (id, namespace, key, status, action_json, presentation_json, requester_json,
             approvers, on_timeout, resume_context_json, created_at, expires_at, decided_at,
             decided_by, decision_reason, token_hash, token_nonce, claim_owner,
             claim_expires_at, processed_at)
          VALUES
            (${candidate.id}, ${candidate.namespace}, ${candidate.key}, ${candidate.status},
             ${JSON.stringify(candidate.action)}::jsonb,
             ${candidate.presentation === null ? null : JSON.stringify(candidate.presentation)}::jsonb,
             ${JSON.stringify(candidate.requester)}::jsonb,
             ${pgTextArrayLiteral(candidate.approvers)}::text[], ${candidate.onTimeout},
             ${candidate.resumeContext === null ? null : JSON.stringify(candidate.resumeContext)}::jsonb,
             ${candidate.createdAt}, ${candidate.expiresAt}, ${candidate.decidedAt},
             ${candidate.decidedBy}, ${candidate.decisionReason}, ${candidate.tokenHash},
             ${candidate.tokenNonce}, ${candidate.claimOwner}, ${candidate.claimExpiresAt},
             ${candidate.processedAt})
          ON CONFLICT (namespace, key) DO NOTHING
          RETURNING *;
        `,
        "openGate failed"
      );
      const row = rows[0];
      if (row !== undefined) return { created: true, record: mapGateRow(row) };
      const existing = await selectGateByKey(candidate.namespace, candidate.key);
      if (existing === null) {
        throw new SluiceError("E_STORE", "openGate: expected an existing row after a conflict", {
          context: { namespace: candidate.namespace, key: candidate.key },
        });
      }
      return { created: false, record: existing };
    },

    async readGate(id): Promise<GateRecord | null> {
      return selectGateById(id);
    },

    async decideGate(input): Promise<{ applied: boolean; record: GateRecord | null }> {
      const rows = await execWrapped<GateRow>(
        sql`
          UPDATE sluice_gate SET
            status = ${input.status},
            decided_at = ${input.now},
            decided_by = ${input.decidedBy},
            decision_reason = ${input.reason},
            token_hash = ${input.tokenHash},
            token_nonce = ${input.tokenNonce}
          WHERE id = ${input.id} AND status = 'pending'
          RETURNING *;
        `,
        "decideGate failed"
      );
      const row = rows[0];
      if (row !== undefined) return { applied: true, record: mapGateRow(row) };
      const existing = await selectGateById(input.id);
      return { applied: false, record: existing };
    },

    async listGates(q): Promise<GateRecord[]> {
      const conditions: SQL[] = [];
      if (q.namespace !== undefined) conditions.push(sql`namespace = ${q.namespace}`);
      if (q.status !== undefined) conditions.push(sql`status = ${q.status}`);
      const where =
        conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
      const rows = await execWrapped<GateRow>(
        sql`SELECT * FROM sluice_gate ${where} ORDER BY created_at ASC LIMIT ${q.limit ?? 100};`,
        "listGates failed"
      );
      return rows.map(mapGateRow);
    },

    async claimDecidedGates(input): Promise<GateRecord[]> {
      const rows = await execWrapped<GateRow>(
        sql`
          UPDATE sluice_gate SET
            claim_owner = ${input.owner},
            claim_expires_at = ${input.now + input.leaseMs}
          WHERE id IN (
            SELECT id FROM sluice_gate
            WHERE status IN ('approved', 'rejected', 'timed_out')
              AND processed_at IS NULL
              AND (claim_owner IS NULL OR claim_expires_at < ${input.now})
            ORDER BY created_at ASC
            LIMIT ${input.limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *;
        `,
        "claimDecidedGates failed"
      );
      return rows.map(mapGateRow);
    },

    async ackGate(input): Promise<boolean> {
      const rows = await execWrapped<{ ok: number } & Record<string, unknown>>(
        sql`
          UPDATE sluice_gate SET processed_at = ${input.now}
          WHERE id = ${input.id} AND claim_owner = ${input.owner} AND processed_at IS NULL
          RETURNING 1 AS ok;
        `,
        "ackGate failed"
      );
      return rows.length > 0;
    },

    async expireGates(now): Promise<GateRecord[]> {
      const rows = await execWrapped<GateRow>(
        sql`
          UPDATE sluice_gate SET
            status = CASE WHEN on_timeout = 'approve' THEN 'approved' ELSE 'timed_out' END,
            decided_at = expires_at,
            decided_by = 'sluice:timeout',
            decision_reason = 'gate timed out (onTimeout: ' || on_timeout || ')'
          WHERE status = 'pending' AND expires_at <= ${now}
          RETURNING *;
        `,
        "expireGates failed"
      );
      return rows.map(mapGateRow);
    },

    // ── circuit breaker ──────────────────────────────────────────────────
    async readCircuit(key): Promise<CircuitRecord | null> {
      return selectCircuit(key);
    },

    async writeCircuit(
      record,
      expectedVersion
    ): Promise<{ ok: boolean; record: CircuitRecord | null }> {
      const windowJson = circuitWindowJson(record.window, record.consecutiveOpens);
      if (expectedVersion === null) {
        const rows = await execWrapped<CircuitRow>(
          sql`
            INSERT INTO sluice_circuit
              (key, state, version, window_json, opened_at, open_ms, half_open_owner,
               half_open_expires_at, updated_at)
            VALUES
              (${record.key}, ${record.state}, 1, ${windowJson}::jsonb, ${record.openedAt},
               ${record.openMs}, ${record.halfOpenOwner}, ${record.halfOpenExpiresAt},
               ${record.updatedAt})
            ON CONFLICT (key) DO NOTHING
            RETURNING *;
          `,
          "writeCircuit failed"
        );
        const row = rows[0];
        if (row !== undefined) return { ok: true, record: mapCircuitRow(row) };
        return { ok: false, record: await selectCircuit(record.key) };
      }
      const rows = await execWrapped<CircuitRow>(
        sql`
          UPDATE sluice_circuit SET
            state = ${record.state},
            version = version + 1,
            window_json = ${windowJson}::jsonb,
            opened_at = ${record.openedAt},
            open_ms = ${record.openMs},
            half_open_owner = ${record.halfOpenOwner},
            half_open_expires_at = ${record.halfOpenExpiresAt},
            updated_at = ${record.updatedAt}
          WHERE key = ${record.key} AND version = ${expectedVersion}
          RETURNING *;
        `,
        "writeCircuit failed"
      );
      const row = rows[0];
      if (row !== undefined) return { ok: true, record: mapCircuitRow(row) };
      return { ok: false, record: await selectCircuit(record.key) };
    },

    // ── audit ────────────────────────────────────────────────────────────
    async appendEvents(events): Promise<AuditEvent[]> {
      const appended: AuditEvent[] = [];
      // Practically always length 1 in this codebase (core emits one event
      // per call) — a loop of independent single-statement round trips for
      // N>1 stays true to "no interactive, app-managed transaction" even
      // though it costs N round trips instead of one.
      for (const e of events) {
        // The chained payload is a canonical JSON of the event's CONTENT —
        // namespace/ts/subjectType/subjectKey/type/attempt/actor/data. `seq`
        // is deliberately excluded: the chain's tamper-evidence comes from
        // hash LINKAGE (each event's prev_hash must equal its predecessor's
        // hash), not from encoding the sequence number inside the hashed
        // bytes, and `seq` isn't known until the SQL below assigns it.
        const payload = canonicalJson({
          namespace: e.namespace,
          ts: e.ts,
          subjectType: e.subjectType,
          subjectKey: e.subjectKey,
          type: e.type,
          attempt: e.attempt,
          actor: e.actor,
          data: e.data,
        });
        const dataJson = JSON.stringify(e.data);
        const rows = await execWrapped<EventRow>(
          sql`
            WITH locked AS (
              SELECT head_hash FROM sluice_cursor WHERE namespace = ${e.namespace} FOR UPDATE
            ),
            bumped AS (
              INSERT INTO sluice_cursor (namespace, seq, head_hash, updated_at)
              VALUES (
                ${e.namespace}, 1,
                encode(sha256(convert_to(${payload}, 'UTF8')), 'hex'),
                ${e.ts}
              )
              ON CONFLICT (namespace) DO UPDATE
              SET seq = sluice_cursor.seq + 1,
                  head_hash = encode(
                    sha256(convert_to(coalesce((SELECT head_hash FROM locked), '') || ${payload}, 'UTF8')),
                    'hex'
                  ),
                  updated_at = ${e.ts}
              RETURNING seq, head_hash
            )
            INSERT INTO sluice_event
              (id, namespace, seq, ts, subject_type, subject_key, type, attempt, actor,
               data_json, prev_hash, hash)
            SELECT
              'evt_' || ${e.namespace} || '_' || bumped.seq::text,
              ${e.namespace}, bumped.seq, ${e.ts}, ${e.subjectType}, ${e.subjectKey},
              ${e.type}, ${e.attempt}, ${e.actor}, ${dataJson}::jsonb,
              (SELECT head_hash FROM locked),
              bumped.head_hash
            FROM bumped
            RETURNING *;
          `,
          "appendEvents failed"
        );
        const row = rows[0];
        if (row === undefined) {
          throw new SluiceError("E_STORE", "appendEvents: insert returned no row", {
            context: { namespace: e.namespace },
          });
        }
        appended.push(mapEventRow(row));
      }
      return appended;
    },

    async readEvents(namespace, sinceSeq, limit): Promise<AuditEvent[]> {
      const rows = await execWrapped<EventRow>(
        sql`
          SELECT * FROM sluice_event
          WHERE namespace = ${namespace} AND seq > ${sinceSeq}
          ORDER BY seq ASC
          LIMIT ${limit};
        `,
        "readEvents failed"
      );
      return rows.map(mapEventRow);
    },

    // ── sweep ────────────────────────────────────────────────────────────
    async sweep(now): Promise<{ effects: number; gates: number; events: number }> {
      const rows = await execWrapped<{ deleted: number } & Record<string, unknown>>(
        sql`
          DELETE FROM sluice_effect
          WHERE expires_at <= ${now} AND status != 'in_flight'
          RETURNING 1 AS deleted;
        `,
        "sweep failed"
      );
      // Parity with MemoryStore (M1-M5): gate/event retention has no
      // established policy yet in the frozen contract, so both stay 0 here
      // too — a future milestone, not an M6 addition.
      return { effects: rows.length, gates: 0, events: 0 };
    },
  };
}
