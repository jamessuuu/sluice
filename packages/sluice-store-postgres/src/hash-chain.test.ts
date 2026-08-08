/**
 * Hash-chain integrity (SPEC §3 sluice_event/sluice_cursor, M6 brief): append
 * N events through the real store, recompute the chain in JS from the raw
 * rows, then tamper ONE row directly with a raw UPDATE (bypassing the store
 * entirely, the way a rogue DBA edit or a storage-layer bit-flip would) and
 * assert the break is detected at exactly that point — not before, not
 * "somewhere".
 *
 * The JS-side recomputation deliberately duplicates the exact canonical
 * payload shape `appendEvents` hashes in SQL (see store.ts's comment on
 * `eventPayload`) rather than importing anything from store.ts — an
 * independent recomputation is the only kind that actually tests the SQL,
 * as opposed to testing that the SQL agrees with itself.
 */
import { PGlite } from "@electric-sql/pglite";
import { canonicalJson, sha256Hex, type AuditEvent } from "@jamessuuu/sluice";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPostgresStore } from "./store.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder });
});

afterEach(async () => {
  await client.close();
});

/** The exact payload `appendEvents` hashes — see store.ts's `eventPayload`. */
function payloadFor(e: Pick<AuditEvent, "namespace" | "ts" | "subjectType" | "subjectKey" | "type" | "attempt" | "actor" | "data">): string {
  return canonicalJson({
    namespace: e.namespace,
    ts: e.ts,
    subjectType: e.subjectType,
    subjectKey: e.subjectKey,
    type: e.type,
    attempt: e.attempt,
    actor: e.actor,
    data: e.data,
  });
}

/** Independent JS recomputation of the chain: returns the index of the first break, or -1. */
function findBreak(events: AuditEvent[]): number {
  let expectedPrev: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.prevHash !== expectedPrev) return i;
    const expectedHash = sha256Hex((expectedPrev ?? "") + payloadFor(e));
    if (e.hash !== expectedHash) return i;
    expectedPrev = e.hash;
  }
  return -1;
}

test("hash chain: N appended events verify clean in JS", async () => {
  const db = drizzle(client);
  const store = createPostgresStore(db);
  const N = 12;
  for (let i = 0; i < N; i++) {
    await store.appendEvents([
      {
        namespace: "chain-test",
        ts: 1000 + i,
        subjectType: "effect",
        subjectKey: `k${String(i)}`,
        type: "effect.succeeded",
        attempt: 1,
        actor: "tester",
        data: { i },
      },
    ]);
  }
  const events = await store.readEvents("chain-test", 0, 100);
  expect(events).toHaveLength(N);
  // seq is strictly increasing 1..N
  expect(events.map((e) => e.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect(findBreak(events)).toBe(-1);
});

test("hash chain: tampering one row via raw SQL is detected at exactly that row", async () => {
  const db = drizzle(client);
  const store = createPostgresStore(db);
  const N = 8;
  for (let i = 0; i < N; i++) {
    await store.appendEvents([
      {
        namespace: "tamper-test",
        ts: 2000 + i,
        subjectType: "effect",
        subjectKey: `k${String(i)}`,
        type: "effect.succeeded",
        attempt: 1,
        actor: "tester",
        data: { i },
      },
    ]);
  }

  const before = await store.readEvents("tamper-test", 0, 100);
  expect(findBreak(before)).toBe(-1);

  // Tamper row seq=5's data_json directly — bypassing the store, the way a
  // storage-layer edit or a rogue DBA UPDATE would. hash/prev_hash are left
  // untouched: the point is that the CONTENT no longer matches the hash that
  // was computed over it at append time, which is exactly what the chain is
  // supposed to catch.
  const TAMPERED_SEQ = 5;
  await client.query(
    `UPDATE sluice_event SET data_json = '{"i": "TAMPERED"}'::jsonb WHERE namespace = $1 AND seq = $2`,
    ["tamper-test", TAMPERED_SEQ]
  );

  const after = await store.readEvents("tamper-test", 0, 100);
  expect(after).toHaveLength(N);
  const breakIndex = findBreak(after);
  expect(breakIndex).not.toBe(-1);
  expect(after[breakIndex]?.seq).toBe(TAMPERED_SEQ);

  // Everything strictly BEFORE the tampered row still verifies clean.
  for (let i = 0; i < breakIndex; i++) {
    const e = after[i];
    expect(e).toBeDefined();
  }
  expect(findBreak(after.slice(0, breakIndex))).toBe(-1);
});

test("hash chain: independent namespaces have independent, non-interfering chains", async () => {
  const db = drizzle(client);
  const store = createPostgresStore(db);
  for (const ns of ["ns-a", "ns-b"]) {
    for (let i = 0; i < 3; i++) {
      await store.appendEvents([
        {
          namespace: ns,
          ts: 100 + i,
          subjectType: "effect",
          subjectKey: `k${String(i)}`,
          type: "effect.succeeded",
          attempt: 1,
          actor: "tester",
          data: {},
        },
      ]);
    }
  }
  const a = await store.readEvents("ns-a", 0, 100);
  const b = await store.readEvents("ns-b", 0, 100);
  expect(findBreak(a)).toBe(-1);
  expect(findBreak(b)).toBe(-1);
  // Genesis events of both namespaces have no predecessor.
  expect(a[0]?.prevHash).toBeNull();
  expect(b[0]?.prevHash).toBeNull();
});
