/**
 * Golden fixtures (SPEC §8): each fixture pins one deterministic fault
 * scenario — {id, seed, plan, config} — to its expected NORMALIZED outcome
 * trace: ledger count, final statuses, audit event-type sequence, downstream
 * attempts. Ids and timestamps never appear in a trace, so the diff is about
 * BEHAVIOUR. Pass bar is 24/24, zero tolerance: the system is deterministic,
 * a percentage would be dishonest.
 *
 * File I/O (loading fixtures from disk) lives in the chaos CLI and the eval
 * suite — this module only replays fixture objects.
 *
 * Isomorphic-pure: no node builtins.
 */

import type { FaultPlanSpec } from "./fault-plan.js";
import {
  runScenario,
  type ScenarioConfig,
  type ScenarioName,
  type ScenarioResult,
} from "./scenarios.js";

/** The normalized outcome trace a golden pins (SPEC §8). */
export interface GoldenTrace {
  ledgerCount: number;
  /** `effect:<key>` / `gate:<key>` -> final status, key-sorted. */
  finalStatus: Record<string, string>;
  /** Audit event types in sequence order (ids/timestamps normalized away). */
  eventTypes: string[];
  /** Downstream transport attempts. */
  attempts: number;
}

export interface GoldenFixture {
  id: string;
  scenario: ScenarioName;
  seed: number;
  plan: FaultPlanSpec;
  config: ScenarioConfig;
  expected: GoldenTrace;
}

/** A fixture minus its expectation — what the generator and minimizer emit. */
export type GoldenCase = Omit<GoldenFixture, "expected">;

export function traceOf(result: ScenarioResult): GoldenTrace {
  return {
    ledgerCount: result.ledgerCount,
    finalStatus: result.finalStatuses,
    eventTypes: result.eventTypes,
    attempts: result.attempts,
  };
}

/** Replay a golden case and return its normalized trace. */
export async function replayGolden(c: GoldenCase): Promise<GoldenTrace> {
  const result = await runScenario({
    scenario: c.scenario,
    seed: c.seed,
    plan: c.plan,
    config: c.config,
  });
  return traceOf(result);
}

/** Replay and diff against the pinned expectation. */
export async function verifyGolden(
  fixture: GoldenFixture
): Promise<{ ok: boolean; actual: GoldenTrace; diff: string[] }> {
  const actual = await replayGolden(fixture);
  const diff = diffTraces(fixture.expected, actual);
  return { ok: diff.length === 0, actual, diff };
}

export function diffTraces(expected: GoldenTrace, actual: GoldenTrace): string[] {
  const out: string[] = [];
  if (expected.ledgerCount !== actual.ledgerCount) {
    out.push(`ledgerCount: expected ${String(expected.ledgerCount)}, got ${String(actual.ledgerCount)}`);
  }
  if (expected.attempts !== actual.attempts) {
    out.push(`attempts: expected ${String(expected.attempts)}, got ${String(actual.attempts)}`);
  }
  const fsExpected = JSON.stringify(expected.finalStatus);
  const fsActual = JSON.stringify(actual.finalStatus);
  if (fsExpected !== fsActual) {
    out.push(`finalStatus: expected ${fsExpected}, got ${fsActual}`);
  }
  const evExpected = expected.eventTypes.join(" ");
  const evActual = actual.eventTypes.join(" ");
  if (evExpected !== evActual) {
    out.push(`eventTypes:\n  expected: ${evExpected}\n  actual:   ${evActual}`);
  }
  return out;
}
