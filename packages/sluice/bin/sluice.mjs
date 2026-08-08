#!/usr/bin/env node
// The published `sluice` bin entry point (SPEC §2: "the CLI binary is
// `sluice`"). Imports the BUILT dist output — like the package's "."
// export, the CLI is a build artifact, not something resolved from `src/`
// at run time (see docs/SPEC.md §2's local-resolution decision, which is
// about library consumption, not about running an unbuilt CLI). Run
// `pnpm --filter @jamessuuu/sluice build` once before invoking this
// locally; `pnpm pack`/publish always ships the built dist/.
import { runCli } from "../dist/cli/index.js";

const result = await runCli(process.argv.slice(2));
if (result.output.length > 0) {
  console.log(result.output);
}
process.exitCode = result.code;
