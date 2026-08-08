/**
 * Store conformance against a REAL Postgres — the enforcement SPEC §8
 * actually asks for ("a postgres:17 service container... CI never needs
 * Neon"). Gated on `DATABASE_URL`: CI's `postgres:17` service sets it (see
 * .github/workflows/ci.yml) and migrates before this runs; locally, with no
 * Docker and no network DB (this machine's constraint per the M6 brief),
 * `DATABASE_URL` is unset and the suite reports itself skipped rather than
 * failing or silently doing nothing indistinguishable from "didn't run".
 */
import { runStoreConformance } from "@jamessuuu/sluice-testkit";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { createPostgresStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  "runStoreConformance: sluice-store-postgres (real postgres via DATABASE_URL)",
  () => {
    const pool = new Pool({ connectionString: databaseUrl });

    afterAll(async () => {
      await pool.end();
    });

    test("passes the full SluiceStore contract suite against real Postgres", async () => {
      // One shared connection pool; each conformance case still gets an
      // isolated namespace ("conf") that it TRUNCATEs first, since — unlike
      // the pglite suite — standing up a fresh Postgres server per case isn't
      // practical against a real service container.
      const db = drizzle(pool);
      const report = await runStoreConformance(async () => {
        await pool.query(
          `TRUNCATE sluice_effect, sluice_gate, sluice_event, sluice_cursor, sluice_circuit`
        );
        return createPostgresStore(db);
      });
      if (report.failed.length > 0) {
        console.error(JSON.stringify(report.failed, null, 2));
      }
      expect(report.failed).toEqual([]);
      expect(report.passed).toBe(report.total);
    });
  }
);

if (databaseUrl === undefined || databaseUrl.length === 0) {
  test.skip("real-postgres conformance skipped: DATABASE_URL not set (no Docker/network DB locally — CI's postgres:17 service sets this)", () => {
    // Intentionally empty — this is a visible, named skip marker so a test
    // run's output makes clear the real-Postgres path did not silently pass
    // by never executing; it shows up as SKIPPED, not as absence of evidence.
  });
}
