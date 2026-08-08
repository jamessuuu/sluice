/**
 * Hash-chained audit events (SPEC §3 sluice_event/sluice_cursor, M9).
 *
 * The chained payload is a canonical JSON of the event's CONTENT —
 * namespace/ts/subjectType/subjectKey/type/attempt/actor/data. `seq` is
 * deliberately excluded: the chain's tamper-evidence comes from hash LINKAGE
 * (each event's prev_hash must equal its predecessor's hash), not from
 * encoding the sequence number inside the hashed bytes. This is the exact
 * scheme `sluice-store-postgres` computes in SQL (see that package's
 * `store.ts` `appendEvents` and the independent JS recomputation in
 * `hash-chain.test.ts`) — MemoryStore mirrors it here so the two stores
 * produce byte-identical chains for the same event sequence, and so a
 * fixture exported from either store verifies with the same pure function.
 *
 * Isomorphic-pure: no node builtins. This is what lets `verifyEvents` run in
 * a browser with no store at all (the dogwatch addendum, SPEC §5 ADDENDUM
 * 2026-08-08) — `apps/web`'s `/audit` page recomputes a fixture's chain
 * client-side with exactly this function.
 */
import { canonicalJson } from "./json.js";
import { sha256Hex } from "./sha256.js";
import type { AuditEvent } from "./types.js";

type ChainableEvent = Pick<
  AuditEvent,
  "namespace" | "ts" | "subjectType" | "subjectKey" | "type" | "attempt" | "actor" | "data"
>;

/** The exact bytes that get hashed for one event — never includes `seq`. */
export function eventPayload(e: ChainableEvent): string {
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

/** `sha256((prevHash ?? "") + eventPayload(e))` — the one-line chain rule. */
export function chainHash(prevHash: string | null, e: ChainableEvent): string {
  return sha256Hex((prevHash ?? "") + eventPayload(e));
}

export interface VerifyEventsResult {
  ok: boolean;
  /** Index into `events` of the first broken link, when `ok` is false. */
  brokenAt?: number;
  /** How many events were checked before stopping (== events.length when ok). */
  checked: number;
}

/**
 * Pure, store-free verification of an exported slice of hash-chained events
 * (SPEC §5 ADDENDUM 2026-08-08 — the dogwatch requirement). Recomputes the
 * chain from `events` (must be in ascending `seq` order — the shape
 * `audit.export()`/`audit.since()` already return) and reports the first
 * index where the recorded `prevHash`/`hash` no longer matches what the
 * content implies.
 *
 * `prevHead` anchors what the FIRST event's `prevHash` must equal:
 * - omitted (`undefined`): trust the first event's own claimed `prevHash` as
 *   the starting anchor and verify internal cohesion from there — the right
 *   default for a slice exported without independently knowing the true
 *   genesis hash (e.g. a fixture, or a page of a much longer chain).
 * - passed explicitly (a hash string, or `null` for "must be genesis"):
 *   authoritative — the first event's `prevHash` must equal exactly this,
 *   which is how a caller chains verification across successive pages of a
 *   long export (pass the previous page's last `hash` as this page's
 *   `prevHead`).
 */
export function verifyEvents(events: AuditEvent[], prevHead?: string | null): VerifyEventsResult {
  if (events.length === 0) return { ok: true, checked: 0 };
  const first = events[0];
  let expectedPrev = prevHead === undefined ? (first?.prevHash ?? null) : prevHead;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, checked: i };
    }
    const expectedHash = chainHash(expectedPrev, e);
    if (e.hash !== expectedHash) {
      return { ok: false, brokenAt: i, checked: i };
    }
    expectedPrev = e.hash;
  }
  return { ok: true, checked: events.length };
}
