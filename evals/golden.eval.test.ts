/**
 * Eval stage 1 (SPEC §8): the golden set. 24 fixtures, each pinning a
 * deterministic fault scenario to its normalized outcome trace. Pass bar is
 * 24/24, ZERO tolerance — the system is deterministic, so a percentage bar
 * would be dishonest. Any diff is an intentional behaviour change and must
 * regenerate the goldens in the same PR with a CHANGELOG entry
 * (node --import tsx packages/sluice-testkit/src/chaos/generate-goldens.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verifyGolden, type GoldenFixture } from "@jamessuuu/sluice-testkit";

const GOLDEN_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "packages",
  "sluice-testkit",
  "golden"
);

const files = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("golden set (24/24, zero tolerance)", () => {
  it("has exactly 24 fixtures", () => {
    expect(files).toHaveLength(24);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(GOLDEN_DIR, file), "utf8")) as GoldenFixture;
    it(`replays ${fixture.id} to its pinned trace`, async () => {
      const check = await verifyGolden(fixture);
      expect(check.diff, `golden ${fixture.id} diverged:\n${check.diff.join("\n")}`).toEqual([]);
    });
  }
});
