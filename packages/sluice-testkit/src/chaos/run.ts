/**
 * `pnpm chaos` — the artifact pipeline's first stage (SPEC §7): run the full
 * chaos suite and write chaos/results/latest.json plus the dated copy.
 * scripts/chaos-report.mjs (stage two) renders chaos/RESULTS.md and injects
 * the README table from latest.json — numbers are generated, never
 * hand-written, and CI fails when the committed artifacts drift.
 *
 * Node-only by design: this is the one place in the testkit allowed to touch
 * the filesystem and the process.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runChaosSuite } from "./suite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(HERE, "..", "..", "golden");

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log("chaos: running the full suite (9 scenarios x 10 seeds, baseline, golden, fuzz)...");
  const results = await runChaosSuite({ goldenDir: GOLDEN_DIR });
  results.generatedAt = new Date().toISOString();
  results.gitSha = gitSha();

  const resultsDir = resolve(process.cwd(), "chaos", "results");
  mkdirSync(resultsDir, { recursive: true });
  const json = `${JSON.stringify(results, null, 2)}\n`;
  const latestPath = join(resultsDir, "latest.json");
  writeFileSync(latestPath, json);
  const date = results.generatedAt.slice(0, 10);
  const sha7 = results.gitSha === "unknown" ? "unknown" : results.gitSha.slice(0, 7);
  const datedPath = join(resultsDir, `${date}-${sha7}.json`);
  writeFileSync(datedPath, json);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`chaos: wrote ${latestPath}`);
  console.log(`chaos: wrote ${datedPath}`);
  console.log(
    `chaos: invariants ${String(results.harness.invariantViolations)} violations · ` +
      `golden ${String(results.golden.passed)}/${String(results.golden.total)} · ` +
      `fuzz ${String(results.fuzz.seeds)} seeds ${String(results.fuzz.violations)} violations · ` +
      `amplification ${String(results.amplification.factor)} (gate ${String(results.amplification.gate)}) · ` +
      `${elapsed}s wall`
  );
  if (results.harness.invariantViolations > 0) {
    for (const v of results.harness.violationDetails) console.error(`  VIOLATION: ${v}`);
    process.exitCode = 1;
    return;
  }
  if (results.golden.failures.length > 0) {
    for (const f of results.golden.failures) console.error(`  GOLDEN DIFF: ${f}`);
    process.exitCode = 1;
    return;
  }
  if (results.fuzz.violations > 0) {
    console.error("  FUZZ VIOLATIONS — run the eval suite for the minimized, pinnable case");
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
