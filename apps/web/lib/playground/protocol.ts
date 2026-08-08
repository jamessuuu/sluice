/**
 * Message protocol between the /playground page (main thread) and its Web
 * Worker (SPEC §9: the real core, in a worker, against MemoryStore +
 * FakeTransport/VirtualClock/FaultPlan). Kept in its own module so both
 * sides import the same types without either importing the other.
 */

export interface PlaygroundParams {
  seed: number;
  /** Batch size — how many logical intents one run works through. */
  intents: number;
  /** 0..1 — maps to a duplicate-deliveries-per-intent spread. */
  duplicateRate: number;
  /** 0..1 — P(a downstream attempt commits but the response is lost). */
  timeoutRate: number;
  /** 0..1 — P(a downstream attempt is rejected before commit). */
  errorRate: number;
  /** Injects an occasional crash-mid-effect on the sluice side (recovery demo). */
  crashEnabled: boolean;
}

export interface LedgerRow {
  side: "naive" | "sluice";
  intent: string;
  attempt: number;
}

export interface AuditRow {
  seq: number;
  type: string;
  subjectKey: string;
  attempt: number | null;
}

export interface IntentResult {
  intent: string;
  deliveries: number;
  naiveLedgerCount: number;
  sluiceLedgerCount: number;
  sluiceOutcome: string;
  crashed: boolean;
}

export interface PlaygroundTotals {
  intents: number;
  naiveDuplicates: number;
  sluiceDuplicates: number;
  naiveAttempts: number;
  sluiceAttempts: number;
}

export interface WorkerRequest {
  params: PlaygroundParams;
}

export type WorkerResponse =
  | {
      kind: "intent";
      result: IntentResult;
      naiveLedger: LedgerRow[];
      sluiceLedger: LedgerRow[];
      auditBatch: AuditRow[];
    }
  | { kind: "done"; totals: PlaygroundTotals }
  | { kind: "error"; message: string };
