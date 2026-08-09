/**
 * Reproduction + regression test for the CI failure documented in
 * store.real.test.ts's history: `store.real.test.ts` (real Postgres via
 * `pg`/`drizzle-orm/node-postgres`) failed with e.g.
 * `leaseExpiresAt: expected 30100, got "30100"`, while the byte-identical
 * conformance suite passed against pglite (store.conformance.test.ts).
 *
 * Root cause: every `bigint` (int8) column this schema defines (schema.ts)
 * is read through raw `db.execute(sql\`...\`)`, which bypasses Drizzle's
 * `{ mode: "number" }` column conversion (mapping.ts's header comment) —
 * so the RAW driver's default int8 type parser applies, and that parser
 * differs by driver: node-postgres returns int8 as a STRING, pglite
 * returns a `number`. The `SluiceStore` interface types every one of these
 * fields as `number` (types.ts) — so, pre-fix, the Postgres adapter's
 * *types lied* about what node-postgres actually hands back.
 *
 * This machine has no Docker, so there's no local way to run a real
 * `postgres:17` and observe the string-returning path directly (that's
 * exactly why store.real.test.ts is gated on `DATABASE_URL` and only runs
 * in CI). Instead, this file reproduces the FAILURE MODE — not just the
 * end symptom — locally, two ways:
 *
 *   1. Against plain pglite (what store.conformance.test.ts already runs):
 *      every bigint-backed field comes back as a `number` today, so this
 *      passes regardless of the fix. This is the negative control: it
 *      shows pglite alone can never catch this class of bug.
 *   2. Against pglite wrapped in a shim that mimics node-postgres's int8
 *      parser — stringifying exactly the columns schema.ts declares
 *      `bigint` — before store.ts's row mapping ever sees them. Before the
 *      fix in mapping.ts/store.ts (raw `row.created_at` etc. returned
 *      unchanged), this case failed with the identical
 *      `expected 30100, got "30100"`-shaped assertion CI showed. After the
 *      fix (`toNumber`/`toNumberOrNull` applied to every bigint column at
 *      the row-mapping boundary), it passes — which is the actual
 *      regression guard this file exists to provide.
 */
import { PGlite, type QueryOptions } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createPostgresStore } from "./store.js";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations"
);

const clients: PGlite[] = [];

async function freshPglite(): Promise<PGlite> {
  const c = new PGlite();
  clients.push(c);
  const db = drizzle(c);
  await migrate(db, { migrationsFolder });
  return c;
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

/**
 * Every `bigint` (int8) column across schema.ts's five tables, by its
 * literal snake_case SQL name — exactly the set store.ts's raw
 * `SELECT * ` / `RETURNING *` queries return keyed by. `version`,
 * `open_ms`, and `attempt` are deliberately excluded: they're `integer`
 * (int4) columns, which every Postgres driver (node-postgres included)
 * already returns as a JS `number`.
 */
const BIGINT_COLUMNS = new Set([
  "lease_expires_at",
  "created_at",
  "updated_at",
  "expires_at",
  "decided_at",
  "claim_expires_at",
  "processed_at",
  "opened_at",
  "half_open_expires_at",
  "seq",
  "ts",
]);

function stringifyBigintColumns<T extends Record<string, unknown>>(row: T): T {
  const shimmed: Record<string, unknown> = { ...row };
  for (const col of BIGINT_COLUMNS) {
    if (typeof shimmed[col] === "number") shimmed[col] = String(shimmed[col]);
  }
  return shimmed as T;
}

/**
 * Wraps a pglite `PGlite` client's `query` so any bigint-column value in
 * the result rows is returned as a STRING — mimicking node-postgres's
 * documented int8-as-string default (mapping.ts's `toNumber` doc comment).
 * This is the "driver/type-parser shim" the fix's diagnosis needs to be
 * tested against locally, since Docker (a real `postgres:17`) is
 * unavailable on this machine.
 *
 * `shimmedQuery` is deliberately NOT typed as `PGlite["query"]` (that
 * generic signature promises `Promise<Results<T>>` for whatever `T` the
 * caller asks for; this shim only ever hands back
 * `Record<string, unknown>` rows, which is all drizzle's raw `execute()`
 * path ever requests). It's handed back through the `ProxyHandler`'s
 * `unknown`-typed `get` trap instead, which needs no such promise.
 */
function withNodePgInt8Shim(client: PGlite): PGlite {
  async function shimmedQuery(query: string, params?: unknown[], options?: QueryOptions) {
    const result = await client.query<Record<string, unknown>>(query, params, options);
    return { ...result, rows: result.rows.map(stringifyBigintColumns) };
  }
  const handler: ProxyHandler<PGlite> = {
    get(target, prop, receiver): unknown {
      if (prop === "query") return shimmedQuery;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  };
  return new Proxy(client, handler);
}

/** Fields the fix must coerce, read straight off a claimed effect + a heartbeat + an event. */
async function assertReturnedTypes(db: PgliteDatabase): Promise<void> {
  const store = createPostgresStore(db);

  const claim = await store.claimEffect({
    namespace: "repro",
    key: "k1",
    fingerprint: "fp",
    leaseOwner: "w1",
    leaseMs: 30_000,
    retentionMs: 604_800_000,
    now: 100,
  });
  expect(claim.outcome).toBe("claimed");
  expect(typeof claim.record.leaseExpiresAt).toBe("number");
  expect(claim.record.leaseExpiresAt).toBe(30_100);
  expect(typeof claim.record.createdAt).toBe("number");
  expect(typeof claim.record.updatedAt).toBe("number");
  expect(typeof claim.record.expiresAt).toBe("number");

  await store.heartbeatEffect({
    namespace: "repro",
    key: "k1",
    leaseOwner: "w1",
    leaseMs: 30_000,
    now: 10_000,
  });
  const afterHeartbeat = await store.readEffect("repro", "k1");
  expect(typeof afterHeartbeat?.leaseExpiresAt).toBe("number");
  expect(afterHeartbeat?.leaseExpiresAt).toBe(40_000);

  const opened = await store.openGate({
    id: "g-1",
    namespace: "repro",
    key: "gk",
    status: "pending",
    action: { kind: "conformance" },
    presentation: null,
    requester: { actor: "suite", runId: null },
    approvers: [],
    onTimeout: "reject",
    resumeContext: null,
    createdAt: 100,
    expiresAt: 1_100,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    tokenHash: null,
    tokenNonce: null,
    claimOwner: null,
    claimExpiresAt: null,
    processedAt: null,
  });
  expect(typeof opened.record.createdAt).toBe("number");
  expect(typeof opened.record.expiresAt).toBe("number");

  const [expired] = await store.expireGates(2_000);
  expect(typeof expired?.decidedAt).toBe("number");
  expect(expired?.decidedAt).toBe(1_100);

  const [evt] = await store.appendEvents([
    {
      namespace: "repro",
      ts: 100,
      subjectType: "effect",
      subjectKey: "k1",
      type: "effect.claimed",
      attempt: 1,
      actor: "w1",
      data: {},
    },
  ]);
  expect(typeof evt?.seq).toBe("number");
  expect(evt?.seq).toBe(1);
  expect(typeof evt?.ts).toBe("number");
}

describe("bigint column coercion (node-postgres int8-as-string reproduction)", () => {
  test("plain pglite: bigint-backed fields are already numbers (negative control)", async () => {
    const client = await freshPglite();
    await assertReturnedTypes(drizzle(client));
  });

  test("pglite shimmed to return int8 columns as strings (node-postgres reproduction): fields are still numbers after mapping", async () => {
    const client = await freshPglite();
    await assertReturnedTypes(drizzle(withNodePgInt8Shim(client)));
  });
});
