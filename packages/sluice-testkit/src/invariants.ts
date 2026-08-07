/**
 * The I1–I8 invariant checker (SPEC §7). Runs after EVERY scenario at EVERY
 * seed — runScenario calls it unconditionally, so there is no code path that
 * skips an invariant. Violations are returned as strings (never thrown) so
 * the fuzz minimizer can shrink a failing plan and the chaos runner can
 * aggregate.
 *
 * I7's hash-chain verification is deferred to M9 (events are unchained until
 * then); event COMPLETENESS — every terminal effect has a matching terminal
 * event — is asserted now, as the milestone requires.
 *
 * Isomorphic-pure: no node builtins.
 */

import type { AuditEvent, EffectRecord, GateRecord, SluiceStore } from "@jamessuuu/sluice";
import type { FakeTransport } from "./fake-transport.js";
import { StoreMonitor } from "./store-monitor.js";

export interface DeliveryReport {
  intent: string;
  worker: string;
  outcome: "executed" | "replayed" | "error";
  /** SluiceError code when outcome is "error". */
  code: string | null;
  resultOmitted: boolean;
  /** run() duration in VIRTUAL ms (never wall clock). */
  virtualMs: number;
}

export interface InvariantContext {
  namespace: string;
  transport: FakeTransport;
  monitor: StoreMonitor;
  /** Read side for final records — normally the monitor itself. */
  store: SluiceStore;
  reports: DeliveryReport[];
  events: AuditEvent[];
  /** Logical intent keys measured by the ledger (effect keys 1:1). */
  intents: string[];
  /** Intents that are gate-resume work — I5 requires ledger exactly 1. */
  resumeIntents: string[];
  /** I6 gate: attempts/intents ceiling, or null when the scenario's injected failure rate is below the published 30% bar. */
  amplificationGate: number | null;
  /** I4 slack beyond a gate's timeout horizon. */
  gateSlackMs: number;
}

function successReports(reports: DeliveryReport[], intent: string): number {
  let n = 0;
  for (const r of reports) {
    if (r.intent === intent && (r.outcome === "executed" || r.outcome === "replayed")) n++;
  }
  return n;
}

export async function checkInvariants(ctx: InvariantContext): Promise<string[]> {
  const v: string[] = [];
  const { transport, monitor, store, reports, events, intents } = ctx;

  // Final records, enumerated from everything the monitor ever saw.
  const effectRecords = new Map<string, EffectRecord>();
  for (const id of monitor.effectKeys) {
    const { namespace, key } = StoreMonitor.splitEffectId(id);
    const record = await store.readEffect(namespace, key);
    if (record !== null) effectRecords.set(key, record);
  }
  const gateRecords: GateRecord[] = [];
  for (const id of monitor.gateIds) {
    const record = await store.readGate(id);
    if (record !== null) gateRecords.push(record);
  }

  // I1 — exactly-once: ledger per intent ≤ 1 always; = 1 when success reported.
  // I2 — no phantom success: a reported success requires the ledger entry.
  for (const intent of intents) {
    const landed = transport.ledgerCount(intent);
    const successes = successReports(reports, intent);
    if (landed > 1) {
      v.push(`I1: intent ${intent} landed ${String(landed)} side effects (exactly-once broken)`);
    }
    if (successes > 0 && landed !== 1) {
      v.push(
        `I${landed === 0 ? "2" : "1"}: intent ${intent} reported success ${String(successes)}x but the ledger has ${String(landed)} entries`
      );
    }
  }

  // I3 — fail-closed: an effect parked indeterminate (and never explicitly
  // reclaimed) must never have reported success and must never execute again.
  for (const intent of intents) {
    const record = effectRecords.get(intent);
    if (record?.status !== "indeterminate") continue;
    const id = `${record.namespace}${String.fromCharCode(0)}${intent}`;
    if (monitor.reclaimedKeys.has(id)) continue;
    if (successReports(reports, intent) > 0) {
      v.push(`I3: intent ${intent} is indeterminate yet a delivery reported success`);
    }
    const parkedAt = monitor.indeterminateAt.get(id);
    if (parkedAt !== undefined) {
      for (const a of transport.attempts) {
        if (a.intent === intent && a.at > parkedAt) {
          v.push(
            `I3: intent ${intent} executed downstream at ${String(a.at)} after being parked indeterminate at ${String(parkedAt)}`
          );
        }
      }
    }
  }

  // I4 — gate liveness: every gate terminal, decided within timeout + slack.
  for (const gate of gateRecords) {
    if (gate.status === "pending") {
      v.push(`I4: gate ${gate.key} is still pending at scenario end`);
      continue;
    }
    if (gate.decidedAt !== null && gate.decidedAt > gate.expiresAt + ctx.gateSlackMs) {
      v.push(
        `I4: gate ${gate.key} decided at ${String(gate.decidedAt)}, past its timeout horizon ${String(gate.expiresAt)} + slack`
      );
    }
  }

  // I5 — gate resume exactly-once: post-decision work landed exactly once
  // across every crashed resumer.
  for (const intent of ctx.resumeIntents) {
    const landed = transport.ledgerCount(intent);
    if (landed !== 1) {
      v.push(`I5: gate-resume work ${intent} landed ${String(landed)} times (must be exactly 1)`);
    }
  }

  // I6 — retry amplification under 30% injected failure.
  if (ctx.amplificationGate !== null && intents.length > 0) {
    const factor = transport.attempts.length / intents.length;
    if (factor > ctx.amplificationGate) {
      v.push(
        `I6: amplification ${factor.toFixed(3)} exceeds the ${String(ctx.amplificationGate)} gate (${String(transport.attempts.length)} attempts / ${String(intents.length)} intents)`
      );
    }
  }

  // I7 — audit completeness: every terminal effect has its terminal event;
  // every replayed delivery has a matching effect.replayed event.
  const terminalEventFor: Record<string, string> = {
    succeeded: "effect.succeeded",
    failed: "effect.failed",
    indeterminate: "effect.indeterminate",
  };
  for (const [key, record] of effectRecords) {
    const wanted = terminalEventFor[record.status];
    if (wanted === undefined) continue; // in_flight records are not terminal
    const found = events.some((e) => e.type === wanted && e.subjectKey === key);
    if (!found) {
      v.push(`I7: effect ${key} is ${record.status} but no ${wanted} audit event exists`);
    }
  }
  for (const intent of intents) {
    const replays = reports.filter((r) => r.intent === intent && r.outcome === "replayed").length;
    const replayEvents = events.filter(
      (e) => e.type === "effect.replayed" && e.subjectKey === intent
    ).length;
    if (replays > 0 && replayEvents < replays) {
      v.push(
        `I7: intent ${intent} replayed ${String(replays)}x but only ${String(replayEvents)} effect.replayed events exist`
      );
    }
  }

  // I8 — terminal-state monotonicity, observed live by the store monitor.
  v.push(...monitor.violations);

  return v;
}
