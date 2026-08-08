import { defineConfig, devices } from "@playwright/test";

// SPEC §8 e2e:smoke stage: Playwright against `next build && next start` —
// never `next dev` (dev-mode HTML differs from what's actually served in
// production, and the whole point of this gate is proving the deployed
// shape). `webServer` below runs the exact `pnpm build && pnpm start`
// scripts (prebuild's OG generation included), so `pnpm test:e2e` alone is
// the whole gate — nothing to pre-build by hand.
const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Inlined rather than `pnpm build && pnpm start -- --port N`: pnpm's
    // arg-passthrough for a zero-arg script ("start": "next start") does not
    // reliably forward `-- --port N` as flags to the underlying `next`
    // binary. Calling next directly (still preceded by the same OG-generation
    // prebuild step `pnpm build` would otherwise run) is unambiguous.
    command: `node scripts/generate-og.mjs && next build && next start -p ${String(PORT)}`,
    url: `http://127.0.0.1:${String(PORT)}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
