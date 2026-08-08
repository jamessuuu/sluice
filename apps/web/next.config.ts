// SPEC §9: zero API routes, zero database, zero writes — this file has no
// rewrites/headers pointed at a backend because there is no backend.
// `transpilePackages` is SPEC §2's "no dist-ordering problem" decision: Next
// compiles the workspace packages' `src/` directly, same as Vitest, so
// nothing here depends on `pnpm -r build` having run first.
import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "mdx"],
  transpilePackages: ["@jamessuuu/sluice", "@jamessuuu/sluice-testkit"],
  reactStrictMode: true,
  // Static-first (SPEC §9): every route below either renders at build time
  // or is a pure client component with no server dependency. `output` stays
  // the Next default (not `export`) so the docs' dynamic route segments and
  // the Playwright `next build && next start` gate (SPEC §8) both work
  // unchanged; nothing in the app ever reads a request in a Node runtime.
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
