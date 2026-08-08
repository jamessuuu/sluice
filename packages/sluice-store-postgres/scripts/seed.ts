/**
 * db:seed — write one representative row into every table (effect, gate,
 * circuit, audit event) through the real store adapter, so a reviewer who
 * just ran `db:migrate` can immediately see a working instance. Targets the
 * same DATABASE_URL / local-pglite choice as migrate.ts. Run `db:migrate`
 * first.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPostgresStore, type AnyPgDatabase } from "../src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function getDb(): Promise<{ db: AnyPgDatabase; label: string; close: () => Promise<void> }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: databaseUrl });
    return { db: drizzle(pool), label: "DATABASE_URL", close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dataDir = path.join(here, "..", ".pglite-data");
  const client = new PGlite(dataDir);
  return { db: drizzle(client), label: `local pglite (${dataDir})`, close: () => client.close() };
}

async function main(): Promise<void> {
  const { db, label, close } = await getDb();
  try {
    const store = createPostgresStore(db);
    const now = Date.now();

    const claim = await store.claimEffect({
      namespace: "seed",
      key: "example-effect",
      fingerprint: "seed-fingerprint",
      leaseOwner: "seed-script",
      leaseMs: 30_000,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      now,
    });
    if (claim.outcome === "claimed") {
      await store.completeEffect({
        namespace: "seed",
        key: "example-effect",
        leaseOwner: "seed-script",
        status: "succeeded",
        result: { seeded: true },
        now: now + 10,
      });
    }

    await store.appendEvents([
      {
        namespace: "seed",
        ts: now,
        subjectType: "effect",
        subjectKey: "example-effect",
        type: "effect.succeeded",
        attempt: 1,
        actor: "seed-script",
        data: { seeded: true },
      },
    ]);

    await store.openGate({
      id: "01911111-1111-7111-8111-111111111111",
      namespace: "seed",
      key: "example-gate",
      status: "pending",
      action: { kind: "seed.example" },
      presentation: { title: "Example approval gate", summary: "Seeded by db:seed" },
      requester: { actor: "seed-script", runId: null },
      approvers: ["reviewer@example.com"],
      onTimeout: "reject",
      resumeContext: null,
      createdAt: now,
      expiresAt: now + 60_000,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      tokenHash: null,
      tokenNonce: null,
      claimOwner: null,
      claimExpiresAt: null,
      processedAt: null,
    });

    await store.writeCircuit(
      {
        key: "seed:example-circuit",
        state: "closed",
        window: [0, 0, 1],
        openedAt: null,
        openMs: null,
        consecutiveOpens: 0,
        halfOpenOwner: null,
        halfOpenExpiresAt: null,
        updatedAt: now,
      },
      null
    );

    console.log(`sluice-store-postgres: seeded ${label} — one effect, gate, circuit, and audit event.`);
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
