/**
 * Eval stage 2 (SPEC §8): 200 randomized seeds, zero I1–I8 violations. A
 * failing seed is auto-minimized (the fault plan is greedily shrunk while it
 * still fails) and printed as a pinnable golden fixture — copy it into
 * packages/sluice-testkit/golden/ as #25 to make the bug a permanent
 * regression test.
 */
import { describe, expect, it } from "vitest";
import {
  fuzzCase,
  minimizeFuzzCase,
  pinnableGolden,
  runFuzzCase,
} from "@jamessuuu/sluice-testkit";

const SEEDS = 200;

describe("fuzz (200 randomized seeds, I1-I8 on every run)", () => {
  it(
    `finds zero invariant violations across ${String(SEEDS)} seeds`,
    { timeout: 300_000 },
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const c = fuzzCase(seed);
        const result = await runFuzzCase(c);
        if (result.violations.length > 0) {
          const minimized = await minimizeFuzzCase(c);
          const pinnable = await pinnableGolden(minimized);
          expect.fail(
            `fuzz seed ${String(seed)} (${c.scenario}) violated invariants:\n` +
              `${result.violations.join("\n")}\n\n` +
              `minimized, pinnable golden (add as golden #25 once the fix regenerates it):\n${pinnable}`
          );
        }
      }
    }
  );
});
