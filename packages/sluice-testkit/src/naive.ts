/**
 * The naive baseline (SPEC §7 published numbers): the same fault schedule,
 * the same duplicate deliveries, but a direct transport call with the retry
 * loop everyone writes first — retry on ANY error, including timeouts. It is
 * the honest comparison column: naive "succeeds" more often precisely
 * because it re-fires side effects whose outcome was unknown, and the
 * duplicate side-effect count is the receipt.
 *
 * Isomorphic-pure: no node builtins.
 */

import { FakeTransport } from "./fake-transport.js";
import { FaultPlan, type FaultPlanSpec } from "./fault-plan.js";
import { VirtualClock } from "./virtual-clock.js";

const NAIVE_MAX_ATTEMPTS = 3;
const NAIVE_BACKOFF_MS = 100;

export interface BaselineSideResult {
  intents: number;
  deliveries: number;
  /** Intents for which at least one delivery reported success. */
  intentsSucceeded: number;
  successRate: number;
  attempts: number;
  ledgerCount: number;
  duplicateEffects: number;
}

/**
 * Run the naive client over `intents` logical intents with the plan's
 * duplicate-delivery schedule. Every delivery independently retries up to
 * 3 attempts on any failure — the at-least-once anti-pattern under test.
 */
export async function runNaiveBaseline(o: {
  seed: number;
  intents: number;
  plan: FaultPlanSpec;
}): Promise<BaselineSideResult> {
  const clock = new VirtualClock();
  const plan = new FaultPlan(o.seed, o.plan);
  const transport = new FakeTransport(clock, plan);

  const intents: string[] = [];
  for (let i = 0; i < o.intents; i++) intents.push(`intent-${String(i)}`);

  let deliveries = 0;
  const succeededIntents = new Set<string>();

  async function naiveDeliver(intent: string): Promise<void> {
    deliveries++;
    for (let attempt = 1; attempt <= NAIVE_MAX_ATTEMPTS; attempt++) {
      try {
        await transport.call(intent);
        succeededIntents.add(intent);
        return;
      } catch {
        // The naive bug in one line: a timeout and an error look the same,
        // so the effect that LANDED gets fired again.
        if (attempt < NAIVE_MAX_ATTEMPTS) await clock.sleep(NAIVE_BACKOFF_MS);
      }
    }
  }

  for (const intent of intents) {
    const d = plan.deliveriesFor(intent);
    const group: Promise<void>[] = [];
    for (let k = 0; k < d; k++) group.push(naiveDeliver(intent));
    await clock.settle(Promise.all(group));
  }

  return {
    intents: o.intents,
    deliveries,
    intentsSucceeded: succeededIntents.size,
    successRate: o.intents === 0 ? 0 : succeededIntents.size / o.intents,
    attempts: transport.attempts.length,
    ledgerCount: transport.ledger.length,
    duplicateEffects: transport.duplicateCount(),
  };
}
