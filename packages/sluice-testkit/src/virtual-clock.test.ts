import { describe, expect, it } from "vitest";
import { VirtualClock } from "./virtual-clock.js";

describe("VirtualClock", () => {
  it("resolves sleeps only when time advances, in time order", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    void clock.sleep(300).then(() => order.push("c"));
    void clock.sleep(100).then(() => order.push("a"));
    void clock.sleep(200).then(() => order.push("b"));
    await clock.advance(50);
    expect(order).toEqual([]);
    await clock.advance(200);
    expect(order).toEqual(["a", "b"]);
    expect(clock.now()).toBe(250);
    await clock.advance(50);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("settle() auto-advances to the next sleeper until the work completes", async () => {
    const clock = new VirtualClock();
    const result = await clock.settle(
      (async () => {
        await clock.sleep(1_000);
        await clock.sleep(2_000);
        return clock.now();
      })()
    );
    expect(result).toBe(3_000);
  });

  it("settle() propagates rejections", async () => {
    const clock = new VirtualClock();
    await expect(
      clock.settle(
        (async () => {
          await clock.sleep(500);
          throw new Error("boom");
        })()
      )
    ).rejects.toThrow("boom");
  });

  it("settle() detects deadlock (pending work, no timers)", async () => {
    const clock = new VirtualClock();
    const never = new Promise(() => {
      /* hangs */
    });
    await expect(clock.settle(never)).rejects.toThrow(/deadlock/);
  });

  it("settle() enforces its virtual-time horizon", async () => {
    const clock = new VirtualClock();
    await expect(
      clock.settle(clock.sleep(10_000), { maxVirtualMs: 5_000 })
    ).rejects.toThrow(/maxVirtualMs/);
  });

  it("abortable sleeps reject with the signal reason", async () => {
    const clock = new VirtualClock();
    const abort = new AbortController();
    const p = clock.sleep(1_000, abort.signal);
    const reason = new Error("cancelled");
    abort.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it("skewed views offset now() but share the timeline", async () => {
    const clock = new VirtualClock();
    const skewed = clock.skewed(15_000);
    expect(skewed.now()).toBe(15_000);
    await clock.advance(1_000);
    expect(skewed.now()).toBe(16_000);
    expect(clock.now()).toBe(1_000);
  });
});
