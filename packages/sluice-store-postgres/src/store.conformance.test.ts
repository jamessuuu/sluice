/**
 * Store contract conformance against pglite (SPEC §5, §8 M6): the same
 * `runStoreConformance` suite MemoryStore passes, run here against a real
 * Postgres engine (pglite is Postgres compiled to WASM, not a mock). Always
 * runs — no Docker, no network DB, no env var required. This is verification
 * path (2) from the M6 brief: Docker is unavailable on this machine, so
 * pglite stands in locally; `store.real.test.ts` runs the identical suite
 * against a real `postgres:17` service container in CI (the enforcement
 * SPEC §8 actually asks for).
 *
 * Each test gets a fresh schema (drop + recreate from the checked-in
 * migrations) so cases that assert on a clean namespace never see another
 * test's rows — the same "fresh store per case" isolation
 * `runStoreConformance` gives MemoryStore for free by constructing a new
 * instance per case.
 */
import { PGlite } from "@electric-sql/pglite";
import { runStoreConformance } from "@jamessuuu/sluice-testkit";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { createPostgresStore } from "./store.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const clients: PGlite[] = [];

async function freshDb(): Promise<PgliteDatabase> {
  // In-memory pglite instance per store, migrated from the exact checked-in
  // SQL — this is what proves the migration files themselves are correct,
  // not just the schema.ts they were generated from.
  const c = new PGlite();
  clients.push(c);
  const db = drizzle(c);
  await migrate(db, { migrationsFolder });
  return db;
}

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

test(
  "runStoreConformance: sluice-store-postgres (pglite) passes the full SluiceStore contract suite",
  async () => {
    const report = await runStoreConformance(async () => {
      const db = await freshDb();
      return createPostgresStore(db);
    });
    if (report.failed.length > 0) {
      console.error(JSON.stringify(report.failed, null, 2));
    }
    expect(report.failed).toEqual([]);
    expect(report.passed).toBe(report.total);
  },
  // A fresh pglite instance + migration per case (~17 cases) is slower than
  // Vitest's 5s default — each boot is real WASM Postgres startup, not a mock.
  60_000
);
