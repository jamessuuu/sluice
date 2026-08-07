/**
 * Retry mechanics (SPEC §5 retry policy, §6 F7): full-jitter exponential
 * backoff inside one lease, Retry-After honouring, and the retry-budget token
 * bucket that is the retry-storm defence. Pure policy — no store access.
 */

import type { Json } from "./json.js";

export interface RetryPolicy {
  /** Attempts inside ONE lease (the first try counts). Default 3. */
  maxAttempts: number;
  /** Default 200. */
  baseDelayMs: number;
  /** Default 10_000. */
  maxDelayMs: number;
  /** Retry-After above this fails fast with the header surfaced. Default 60_000. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 60_000,
};

/**
 * Full-jitter backoff (SPEC §5): `random() * min(maxDelayMs, baseDelayMs *
 * 2**attempt)` where `attempt` is the number of completed tries (1 after the
 * first failure), so the first retry draws from [0, 2·base).
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  completedTries: number,
  random: () => number
): number {
  return random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** completedTries);
}

export interface RetryAfterHint {
  ms: number;
  /** The raw header/property value, surfaced in errors and audit data. */
  raw: string;
}

/**
 * Extract a Retry-After hint from a thrown error. Recognized shapes (SPEC §5,
 * documented): an own `retryAfter` property (number = seconds, string =
 * seconds or HTTP-date), or a `headers` bag — Headers-like `.get()` or a
 * plain record, case-insensitive. Unparseable values are ignored.
 */
export function retryAfterHint(cause: unknown, now: number): RetryAfterHint | null {
  if (typeof cause !== "object" || cause === null) return null;
  const obj = cause as Record<string, unknown>;
  const direct = parseRetryAfter(obj.retryAfter, now);
  if (direct !== null) return direct;
  return parseRetryAfter(headerLookup(obj.headers, "retry-after"), now);
}

function headerLookup(headers: unknown, name: string): unknown {
  if (typeof headers !== "object" || headers === null) return undefined;
  const bag = headers as Record<string, unknown>;
  if (typeof bag.get === "function") {
    // Method call preserves `this` for Headers-like objects.
    return (bag as { get: (n: string) => unknown }).get(name);
  }
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === name) return bag[key];
  }
  return undefined;
}

function parseRetryAfter(value: unknown, now: number): RetryAfterHint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return { ms: value * 1000, raw: String(value) };
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    return { ms: Number(trimmed) * 1000, raw: trimmed };
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return { ms: Math.max(0, dateMs - now), raw: trimmed };
}

/**
 * Token bucket per (namespace, circuitKey) capping retries at 10% of calls
 * (SPEC §6 F7). Integer arithmetic in tenths of a token — no float drift:
 * every call deposits 1 tenth, every retry withdraws 10. The initial balance
 * (3 tokens = one full default retry cycle) lets a cold instance retry its
 * first failure burst; steady-state amplification converges to the 10% rate.
 * In-process by design: the budget bounds THIS instance's amplification.
 */
export class RetryBudget {
  private readonly tenths = new Map<string, number>();

  constructor(
    private readonly depositTenths = 1,
    private readonly capTenths = 100,
    private readonly initialTenths = 30
  ) {}

  static key(namespace: string, circuitKey: string | undefined): string {
    return `${namespace}:${circuitKey ?? ""}`;
  }

  /** One call started — fund 10% of a retry. */
  deposit(key: string): void {
    const balance = this.tenths.get(key) ?? this.initialTenths;
    this.tenths.set(key, Math.min(this.capTenths, balance + this.depositTenths));
  }

  /** Returns false when the budget is exhausted (⇒ E_RETRY_BUDGET). */
  tryWithdraw(key: string): boolean {
    const balance = this.tenths.get(key) ?? this.initialTenths;
    if (balance < 10) return false;
    this.tenths.set(key, balance - 10);
    return true;
  }

  /** For audit data. */
  balance(key: string): Json {
    return (this.tenths.get(key) ?? this.initialTenths) / 10;
  }
}
