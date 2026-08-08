// SPEC §9: zero API routes, zero database, zero writes — this file has no
// rewrites/headers pointed at a backend because there is no backend.
import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * DEVIATION from SPEC §2's "local resolution without a build step" (each
 * package's `exports` points at `./src/index.ts`, so Next/Vitest compile
 * source directly with no dist-ordering problem): that holds for Vitest and
 * for every SERVER-side usage in this app, but Turbopack (Next 16's default
 * bundler, used for both `dev` and `build` here — this project does not use
 * `--webpack`) cannot reliably bundle these two packages' `src/` for CLIENT
 * graphs (the playground/gate Web Workers, `/audit`) — every internal
 * relative import in `src/` uses the NodeNext-required `.js` extension
 * pointing at a sibling `.ts` file (`export { uuidv7 } from "./uuid.js"`),
 * and Turbopack's client-component compilation graph fails to resolve that
 * `.js -> .ts` hop through a `transpilePackages` workspace dependency, even
 * with `turbopack.resolveExtensions` configured (tried first; did not fix
 * it — this matches known open Turbopack monorepo-resolution issues, not a
 * misconfiguration here). First-party app code hits the identical failure
 * for the SAME reason (see the worker.ts files under lib/) — fixed there
 * simply by using extensionless relative imports, which is the idiomatic style for this
 * project anyway (apps/web's own tsconfig uses `"moduleResolution":
 * "Bundler"`, not NodeNext) — but the workspace packages' `.js`-suffixed
 * imports are correct per their OWN NodeNext tsconfig and are not this
 * app's file tree to rewrite.
 *
 * The contained fix: alias the two bare package specifiers to their BUILT
 * `dist/index.js` for the bundler only. `tsc`/typecheck and Vitest are
 * untouched (they still resolve `exports: "./src/index.ts"` via Node/TS
 * module resolution, unaffected by a bundler-level alias) — dist and src are
 * always API-identical (dist is `tsc`'s own compiled output of src), so this
 * changes nothing about what ships, only how the browser bundle finds it.
 * The cost: apps/web's `dev`/`build` now depend on the two packages' `dist/`
 * existing, which `predev`/`prebuild` (package.json) build transparently —
 * still one command (`pnpm dev` / `pnpm build`), not a manual extra step.
 */
// Turbopack's resolveAlias rejects absolute Windows paths outright ("windows
// imports are not implemented yet" — a platform limitation, not just a
// backslash-vs-forward-slash formatting issue). A path relative to this
// config file works on every platform.
const distAlias = {
  "@jamessuuu/sluice": "../../packages/sluice/dist/index.js",
  "@jamessuuu/sluice-testkit": "../../packages/sluice-testkit/dist/index.js",
};

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "mdx"],
  reactStrictMode: true,
  // Static-first (SPEC §9): every route below either renders at build time
  // or is a pure client component with no server dependency. `output` stays
  // the Next default (not `export`) so the docs' dynamic route segments and
  // the Playwright `next build && next start` gate (SPEC §8) both work
  // unchanged; nothing in the app ever reads a request in a Node runtime.
  turbopack: {
    root: workspaceRoot,
    resolveAlias: distAlias,
  },
  outputFileTracingRoot: workspaceRoot,
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
