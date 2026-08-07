/**
 * FaultPlan — the declarative, seeded fault schedule (SPEC §7).
 *
 * Every decision is a pure function of (seed, label): fault draws do not
 * depend on call interleaving, so a scenario replays identically and the
 * fuzz minimizer can shrink a plan without shifting unrelated draws.
 * The spec is plain JSON so golden fixtures can embed it verbatim.
 *
 * Isomorphic-pure: no node builtins (the playground imports this in a
 * Web Worker at M8).
 */

export type AttemptFault = "ok" | "error" | "timeout";

export interface FaultPlanSpec {
  /** Deliveries per intent: exact, or [min, max] inclusive drawn per intent. Default 1. */
  deliveries?: number | [number, number];
  /** P(a downstream attempt fails BEFORE committing — retryable, nothing landed). Default 0. */
  errorRate?: number;
  /** P(a downstream attempt COMMITS but the response is lost — the F2 fault). Default 0. */
  timeoutRate?: number;
  /** Downstream latency in virtual ms: exact, or [min, max] drawn per attempt. Default 0. */
  latencyMs?: number | [number, number];
  /** Simulated crashes (interpretation is per scenario, e.g. crashed resumers). Default 1. */
  crashes?: number;
  /**
   * Forced fault for attempt N (index 0 = attempt 1) of EVERY intent;
   * null falls through to the rates. Lets a scenario script the exact
   * sequence ("first attempt times out") instead of tuning rates.
   */
  attemptOverrides?: (AttemptFault | null)[];
}

/** Seeded PRNG (mulberry32) — the harness's only randomness source (SPEC §7). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a label string — mixes (seed, label) into a derived PRNG seed. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class FaultPlan {
  readonly seed: number;
  readonly spec: FaultPlanSpec;

  constructor(seed: number, spec: FaultPlanSpec = {}) {
    this.seed = seed;
    this.spec = spec;
  }

  /** An independent deterministic PRNG stream for a labelled consumer. */
  stream(label: string): () => number {
    return mulberry32(fnv1a(`${String(this.seed)}:${label}`));
  }

  /** One deterministic draw in [0, 1) for a label — order-independent. */
  draw(label: string): number {
    return this.stream(label)();
  }

  private drawRange(value: number | [number, number] | undefined, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (typeof value === "number") return value;
    const [min, max] = value;
    if (max <= min) return min;
    return min + Math.floor(this.draw(label) * (max - min + 1));
  }

  /** How many times `intent` is delivered (the duplicate-delivery knob). */
  deliveriesFor(intent: string): number {
    return Math.max(1, this.drawRange(this.spec.deliveries, 1, `deliveries:${intent}`));
  }

  /** The fault injected into downstream attempt `attempt` (1-based) of `intent`. */
  attemptFault(intent: string, attempt: number): AttemptFault {
    const override = this.spec.attemptOverrides?.[attempt - 1];
    if (override !== null && override !== undefined) return override;
    const errorRate = this.spec.errorRate ?? 0;
    const timeoutRate = this.spec.timeoutRate ?? 0;
    const r = this.draw(`fault:${intent}:${String(attempt)}`);
    if (r < errorRate) return "error";
    if (r < errorRate + timeoutRate) return "timeout";
    return "ok";
  }

  /** Downstream latency (virtual ms) for attempt `attempt` of `intent`. */
  latencyFor(intent: string, attempt: number): number {
    const value = this.spec.latencyMs;
    if (value === undefined) return 0;
    if (typeof value === "number") return value;
    const [min, max] = value;
    if (max <= min) return min;
    return Math.round(min + this.draw(`latency:${intent}:${String(attempt)}`) * (max - min));
  }

  /** Crash count for the scenario (crashed resumers etc.). */
  crashCount(): number {
    return this.spec.crashes ?? 1;
  }
}
