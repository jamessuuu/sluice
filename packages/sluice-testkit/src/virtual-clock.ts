/**
 * VirtualClock — deterministic time for the chaos harness (SPEC §7).
 *
 * Every sleep, backoff, lease expiry and gate timeout in sluice reads from
 * the injected Clock; this implementation resolves sleeps only when virtual
 * time is advanced, and `settle()` auto-advances to the next due sleeper
 * whenever the real task queue drains — so a whole scenario runs to
 * completion in milliseconds of wall time while spanning hours of virtual
 * time. All published latency numbers are VIRTUAL clock time, never wall
 * clock (SPEC §7 published numbers).
 *
 * Promoted from the core's test helper (harness.test-helper.ts) with the
 * auto-advancing waiter added. Isomorphic-pure: no node builtins.
 */

import type { Clock } from "@jamessuuu/sluice";

interface Sleeper {
  at: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/**
 * One real macrotask hop — lets every pending microtask and timer-zero
 * callback run. setImmediate when the host has it (Node — setTimeout(0) has
 * a ~1ms floor that adds up over thousands of drains); setTimeout in
 * browsers/Workers. Feature-tested, not imported: this module stays
 * isomorphic-pure.
 */
const scheduleMacrotask: (cb: () => void) => void =
  typeof setImmediate === "function" ? (cb) => void setImmediate(cb) : (cb) => void setTimeout(cb, 0);

function drainTasks(): Promise<void> {
  return new Promise((resolve) => {
    scheduleMacrotask(resolve);
  });
}

function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}

export class VirtualClock implements Clock {
  private time: number;
  private sleepers: Sleeper[] = [];

  constructor(startMs = 0) {
    this.time = startMs;
  }

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(reasonOf(signal));
        return;
      }
      const entry: Sleeper = { at: this.time + ms, resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        entry.onAbort = () => {
          this.sleepers = this.sleepers.filter((s) => s !== entry);
          reject(reasonOf(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.sleepers.push(entry);
    });
  }

  /** Earliest pending sleeper, or undefined. Stable order for equal times. */
  private nextDue(): Sleeper | undefined {
    return [...this.sleepers].sort((a, b) => a.at - b.at)[0];
  }

  private wake(due: Sleeper): void {
    this.time = Math.max(this.time, due.at);
    this.sleepers = this.sleepers.filter((s) => s !== due);
    if (due.signal !== undefined && due.onAbort !== undefined) {
      due.signal.removeEventListener("abort", due.onAbort);
    }
    due.resolve();
  }

  /**
   * Advance virtual time by `ms`, waking due sleepers in time order and
   * letting their continuations schedule follow-up sleeps before moving on.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await drainTasks();
      const due = this.nextDue();
      if (due === undefined || due.at > target) break;
      this.wake(due);
    }
    this.time = target;
    await drainTasks();
  }

  /**
   * Run `work` to settlement, auto-advancing virtual time to the next due
   * sleeper whenever the task queue drains — the harness's main loop. Throws
   * on deadlock (work pending, no virtual timers to advance to) and when the
   * work would need more than `maxVirtualMs` of virtual time.
   */
  async settle<T>(work: Promise<T>, o?: { maxVirtualMs?: number }): Promise<T> {
    const maxVirtualMs = o?.maxVirtualMs ?? 86_400_000; // 24h of virtual time
    const horizon = this.time + maxVirtualMs;
    const state: { done: boolean; ok: boolean; value: unknown; error: unknown } = {
      done: false,
      ok: false,
      value: undefined,
      error: undefined,
    };
    void work.then(
      (value) => {
        state.done = true;
        state.ok = true;
        state.value = value;
      },
      (error: unknown) => {
        state.done = true;
        state.error = error;
      }
    );
    let idleDrains = 0;
    for (;;) {
      await drainTasks();
      if (state.done) break;
      const due = this.nextDue();
      if (due === undefined) {
        // No timers — give stray promise chains a couple more macrotasks to
        // settle before declaring the workload deadlocked.
        idleDrains++;
        if (idleDrains > 3) {
          throw new Error(
            "VirtualClock.settle: deadlock — the awaited work is pending but no virtual timers exist"
          );
        }
        continue;
      }
      idleDrains = 0;
      if (due.at > horizon) {
        throw new Error(
          `VirtualClock.settle: work needs more than maxVirtualMs=${String(maxVirtualMs)} of virtual time`
        );
      }
      this.wake(due);
    }
    if (state.ok) return state.value as T;
    throw state.error;
  }

  /**
   * A skewed VIEW of this clock (F8): `now()` is offset by `skewMs`, sleeps
   * share the same underlying timeline. Give each simulated worker its own
   * view to model clock skew between processes.
   */
  skewed(skewMs: number): Clock {
    return {
      now: () => this.now() + skewMs,
      sleep: (ms, signal) => this.sleep(ms, signal),
    };
  }
}
