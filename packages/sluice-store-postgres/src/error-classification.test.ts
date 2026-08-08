/**
 * Regression test for a subtle cross-package contract: `sluice.ts`'s own
 * `wrapStoreError` special-cases a `completeEffect` failure as
 * `indeterminate: true` (F11 — the effect already ran by the time
 * completeEffect is called), but ONLY when the store throws something that
 * ISN'T already a `SluiceError` — its first line is
 * `if (cause instanceof SluiceError) return cause`. A store that pre-wraps
 * every driver error as a blanket `retryable:true, indeterminate:false`
 * SluiceError would silently defeat that fail-closed override — core would
 * never get the chance to correct it, and a completeEffect write failure
 * (the side effect DID run; only recording that it succeeded failed) would
 * come back looking safely retryable instead of fail-closed indeterminate.
 *
 * `claimEffect`, by contrast, fails BEFORE anything executes — its errors
 * are correctly retryable, not indeterminate. Both are asserted here so a
 * future edit that flips the wrong one is caught immediately.
 */
import { PGlite } from "@electric-sql/pglite";
import { SluiceError } from "@jamessuuu/sluice";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";
import { createPostgresStore } from "./store.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

test("completeEffect: an unexpected store failure is indeterminate:true, retryable:false (F11)", async () => {
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  const store = createPostgresStore(db);

  const claim = await store.claimEffect({
    namespace: "errcls",
    key: "k1",
    fingerprint: null,
    leaseOwner: "w1",
    leaseMs: 30_000,
    retentionMs: 604_800_000,
    now: 100,
  });
  expect(claim.outcome).toBe("claimed");

  // Force a real driver failure: close the connection out from under the
  // in-flight write, the way a lost network connection or a killed pool
  // would. This is the exact scenario F11 is about — not a mock, a genuine
  // failure of the underlying `db.execute()` call.
  await client.close();

  let caught: unknown;
  try {
    await store.completeEffect({
      namespace: "errcls",
      key: "k1",
      leaseOwner: "w1",
      status: "succeeded",
      result: { ok: true },
      now: 200,
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(SluiceError);
  const err = caught as SluiceError;
  expect(err.code).toBe("E_STORE");
  expect(err.indeterminate).toBe(true);
  expect(err.retryable).toBe(false);
});

test("claimEffect: an unexpected store failure is retryable:true, indeterminate:false (nothing executed yet)", async () => {
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
  const store = createPostgresStore(db);

  await client.close();

  let caught: unknown;
  try {
    await store.claimEffect({
      namespace: "errcls",
      key: "k2",
      fingerprint: null,
      leaseOwner: "w1",
      leaseMs: 30_000,
      retentionMs: 604_800_000,
      now: 100,
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(SluiceError);
  const err = caught as SluiceError;
  expect(err.code).toBe("E_STORE");
  expect(err.indeterminate).toBe(false);
  expect(err.retryable).toBe(true);
});
