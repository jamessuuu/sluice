/**
 * `sluice chaos --seed <n>` — run the chaos harness's 9-scenario fault
 * taxonomy for one seed and print a summary.
 *
 * `@jamessuuu/sluice-testkit` is deliberately NOT a dependency of this
 * package (see state-file.ts's comment: it would break the zero-runtime-
 * dependency guarantee for every consumer, and create a circular package
 * dependency, since sluice-testkit already depends on sluice). This command
 * dynamically imports it instead, which works for a real consumer who
 * installs both PUBLISHED packages (their `exports` resolve to built
 * `dist/`, which plain Node loads directly) and degrades to a clear,
 * actionable message otherwise.
 *
 * KNOWN LIMITATION, disclosed rather than silently papered over: this
 * dynamic import does NOT resolve inside this monorepo's own unbuilt dev
 * loop under plain Node. A workspace-local `@jamessuuu/sluice-testkit`
 * resolves `exports: "."` to `./src/index.ts` (SPEC §2's local-resolution
 * decision, for tooling that understands TypeScript module resolution —
 * `tsc`, Vitest), and that file's compiled `dist/` sibling in turn imports
 * `@jamessuuu/sluice` as a BARE specifier, which resolves the same way,
 * transitively — a chain plain Node's ESM loader cannot follow without a
 * TypeScript-aware loader in front of it. The CLI's `gates` commands have
 * no such dependency and work everywhere unaffected. `runChaosCommand`'s
 * own logic (scenario execution, violation counting, output shape) is
 * exercised end to end in cli.test.ts, which runs under Vitest's
 * TypeScript-aware loader and does resolve the chain correctly — inside
 * this repo's own dev loop, prefer `pnpm chaos` (scripts/chaos-report.mjs's
 * pipeline), which is what CI actually runs.
 */

interface TestkitChaosModule {
  SCENARIO_NAMES: readonly string[];
  runScenario: (o: {
    scenario: string;
    seed: number;
  }) => Promise<{
    scenario: string;
    intents: number;
    ledgerCount: number;
    duplicateEffects: number;
    attempts: number;
    violations: string[];
  }>;
}

export interface ChaosCommandResult {
  code: number;
  output: string;
}

export async function runChaosCommand(seed: number): Promise<ChaosCommandResult> {
  let testkit: TestkitChaosModule;
  try {
    // The specifier is intentionally dynamic (not a static top-level
    // import) — see this file's header comment.
    const moduleName = "@jamessuuu/sluice-testkit";
    const imported: unknown = await import(/* webpackIgnore: true */ moduleName);
    testkit = imported as TestkitChaosModule;
  } catch {
    return {
      code: 1,
      output: [
        "sluice chaos requires @jamessuuu/sluice-testkit, resolvable by plain Node.",
        "Install it alongside @jamessuuu/sluice to use this command:",
        "  pnpm add -D @jamessuuu/sluice-testkit",
        "(Inside the sluice monorepo's own dev loop, use `pnpm chaos` instead —",
        " a workspace-local testkit resolves to source, not plain-Node-loadable dist.)",
      ].join("\n"),
    };
  }

  const lines: string[] = [`chaos --seed ${String(seed)}: running ${String(testkit.SCENARIO_NAMES.length)} scenarios`];
  let totalViolations = 0;
  for (const scenario of testkit.SCENARIO_NAMES) {
    const result = await testkit.runScenario({ scenario, seed });
    totalViolations += result.violations.length;
    lines.push(
      `  ${scenario.padEnd(24)} intents=${String(result.intents).padStart(4)} ` +
        `ledger=${String(result.ledgerCount).padStart(4)} duplicates=${String(result.duplicateEffects)} ` +
        `attempts=${String(result.attempts).padStart(4)} violations=${String(result.violations.length)}`
    );
  }
  const ok = totalViolations === 0;
  lines.push(
    ok ? "OK — 0 invariant violations." : `FAILED — ${String(totalViolations)} invariant violation(s).`
  );
  return { code: ok ? 0 : 1, output: lines.join("\n") };
}
