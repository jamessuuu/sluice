/**
 * Eval stage placeholder (M0). Becomes real in M5 when the golden set +
 * fuzz + chaos-report drift check land (SPEC §8). It exists now so the
 * five-stage CI pipeline (D6) is wired from the first commit, and so the
 * eval stage failing later is a signal, not plumbing.
 */
import { describe, expect, it } from "vitest";

describe("eval stage wiring (M0)", () => {
  it("runs in the eval project", () => {
    expect(true).toBe(true);
  });
});
