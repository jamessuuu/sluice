/**
 * Eval stage 3 (SPEC §7/§8): the chaos-report drift check. The committed
 * numbers must be exactly what the harness produces TODAY:
 *
 * 1. re-run the full chaos suite in-process and diff it against the
 *    committed chaos/results/latest.json (volatile fields — generatedAt,
 *    gitSha — stripped);
 * 2. run `node scripts/chaos-report.mjs --check`, which re-renders the
 *    README chaos block and chaos/RESULTS.md from the committed latest.json
 *    and fails on any byte difference.
 *
 * Together: the README cannot drift from the numbers, and the numbers
 * cannot drift from the behaviour.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runChaosSuite, type ChaosResults } from "@jamessuuu/sluice-testkit/chaos";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const GOLDEN_DIR = resolve(ROOT, "packages", "sluice-testkit", "golden");
const LATEST = resolve(ROOT, "chaos", "results", "latest.json");

function stripVolatile(r: ChaosResults): Partial<ChaosResults> {
  const rest: Partial<ChaosResults> = { ...r };
  delete rest.generatedAt;
  delete rest.gitSha;
  return rest;
}

describe("chaos-report drift check", () => {
  it(
    "committed chaos/results/latest.json matches a fresh harness run",
    { timeout: 600_000 },
    async () => {
      const committed = JSON.parse(readFileSync(LATEST, "utf8")) as ChaosResults;
      const fresh = await runChaosSuite({ goldenDir: GOLDEN_DIR });
      expect(stripVolatile(fresh)).toEqual(stripVolatile(committed));
    }
  );

  it("committed README block and chaos/RESULTS.md render from latest.json", () => {
    // Exit code 1 (and a DRIFT message) on any byte difference.
    const out = execFileSync(process.execPath, [resolve(ROOT, "scripts", "chaos-report.mjs"), "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("match latest.json");
  });
});
