# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: semver.

## [Unreleased]

### Added
- Design + documentation pass on `apps/web` (no consumer-contract change,
  packages stay at `1.0.0-rc.1`): `scripts/diagram.mjs`, a deterministic
  generator (same conventions as `scripts/brand.mjs`, CI drift-checked) for
  the four-state effect machine diagram — `in_flight` to `succeeded` /
  `failed` / `indeterminate`, with the fail-closed edge into `indeterminate`
  as the one amber element. A real demo recording of the gate walkthrough
  (`scripts/record-demo.mjs`, run against the deployed site) — open, crash,
  a real page reload, approve, resume, fires once — embedded on the landing
  page with a `prefers-reduced-motion` fallback (poster + link, CSS-only, no
  client component). The landing page rebuilt around evidence density: the
  666→0 comparison rendered at size, the diagram, the demo, and the F1–F12
  failure-mode table each sit next to the claim they back up. A new
  `/docs/concepts` page. README reordered to lead with the same evidence,
  plus a fix for several stale `sluice.vercel.app` links that should have
  read `sluice-iota.vercel.app`.
- Fixed a real bug in `scripts/record-demo.mjs`'s `tryClick` helper: an
  unconditional `getByRole(...).or(getByText(...))` resolved in DOM order,
  so on `/gate` — whose own intro paragraph says "Approve it, resume it..."
  above the Approve button — `.first()` silently clicked the paragraph
  instead of the button. Found by recording sluice's own demo and noticing
  the Approve click never landed.

## [1.0.0-rc.1] — M9: freeze + polish

The v1 consumer contract is frozen (SPEC §5's P5/dogwatch contract):
`createSluice`, `idempotencyKey`, `run`,
`gates.{open,get,waitFor,decide,cancel,mintToken,pending,claimDecided,sweepTimeouts}`,
`audit.{append,since,export,verify,verifyEvents}`, `MemoryStore`, and
`@jamessuuu/sluice-store-postgres`'s `createPostgresStore`. All three
packages bump from `0.1.0-alpha.0` to `1.0.0-rc.1` together.

### Added
- M9: the `sluice` CLI (`bin/sluice.mjs`, package `bin` field) —
  `sluice gates ls|show|approve|reject` against a local JSON `MemoryStore`
  snapshot (the CLI's ephemeral mode; a real deployment points its own
  script at its own store) and `sluice chaos --seed <n>` (dynamically
  imports `@jamessuuu/sluice-testkit` so the zero-dependency core never
  depends on it). CLI source lives in `packages/sluice/src/cli/`, built by
  its own `tsconfig.cli.build.json` pass (kept separate from the core's
  `types: []` build so the CLI can use Node builtins without weakening the
  core's zero-node-builtins guarantee — see `eslint.config.mjs`).
- M9: hash-chained audit is now documented at the top level — README gained
  a full F1–F12 failure-mode table, a Limitations section (ESM-only, TTL
  semantics, hash-chain throughput ceiling, breaker eventual consistency,
  clock-skew ceiling, virtual-clock latency numbers), an Install section,
  and a CLI section.
- M9: `.github/workflows/release.yml` — tag-triggered (`v*.*.*`), runs the
  identical five CI gates plus build/pack-check, then
  `pnpm -r publish --access public --provenance`. Not run as part of this
  build — no tag has been pushed.
- M8: `/playground` (Web Worker running the real core against
  `MemoryStore` + the testkit's `FakeTransport`/`FaultPlan`/`VirtualClock`/
  `CrashController`; sliders for duplicate/timeout/error rate, a crash
  toggle, and a seed; a live side-by-side "without sluice / with sluice"
  duplicate-side-effect counter), `/gate` (a scripted gate walkthrough
  whose opening worker is killed after ~2s, sessionStorage-mirrored so a
  real page reload survives, approve → resume → replay proving
  exactly-once), and `/audit` (a real-core fixture trail with a browser-side
  "Verify chain" via the new `verifyEvents` and a "Tamper" button). 25
  Playwright e2e tests, including the gate walkthrough completing in under
  30s of interaction and surviving `page.reload()`.
- M8/M9 core prerequisite (see M8's commit message for why hash-chained
  audit ships alongside the M8 UI rather than waiting for this entry):
  `MemoryStore.appendEvents` now computes `prevHash`/`hash` with the
  identical algorithm `sluice-store-postgres` already computes in SQL
  (`hash-chain.ts`'s `chainHash`/`eventPayload`) — a chain built by either
  store is byte-identical for the same events. `verifyEvents(events,
  prevHead?)` — pure, store-free chain verification (the dogwatch addendum,
  SPEC §5 ADDENDUM 2026-08-08) — is now in the frozen v1 surface.
  `sluice.audit.export()`/`audit.verify()` are paginated and delegate to
  `verifyEvents`, so store-backed and browser-side verification are one
  algorithm. `MemoryStore(state?)` + `store.exportState()` — a plain-JSON
  snapshot/restore pair — is what makes `/gate`'s sessionStorage mirror
  possible (also useful for the CLI's ephemeral mode).
- M7: `apps/web` — the Next.js 16.3 docs + demo site (App Router, React
  19.2, TS strict + `noUncheckedIndexedAccess`, Tailwind 4 with config in
  `globals.css`). Fully static `/` (chaos table read from
  `chaos/results/latest.json` at build time), MDX docs (`/docs/*`:
  quickstart, idempotency keys, retries & breaker, gates, stores &
  migrations, chaos harness, failure modes, limitations), a footer on every
  page (chip mark + attribution + backlink + repo link, no hire-me CTA per
  D1), OG image generated at build from the committed brand SVG via sharp,
  a real Playwright `e2e:smoke` CI stage (replacing the M0-era echo no-op),
  `SECURITY.md` filled in (approval-token threat model), and new
  `docs/OPERATIONS.md` (WAF rule, edge-request abuse-case numbers, cost-
  ceiling-N/A rationale). Root `brand` script + a CI brand-drift gate
  mirroring `chaos-report --check`.
- M5: `@jamessuuu/sluice-testkit` is real — FakeTransport (the observable
  side-effect ledger), FaultPlan (seeded mulberry32, declarative fault
  schedules, order-independent draws), VirtualClock (auto-advancing
  `settle()`, skewed per-worker views), CrashController (store-write and
  whole-process crashes), FaultyStore, StoreMonitor (live I8 watcher),
  `runScenario` over the 9-scenario fault taxonomy with I1–I8 asserted on
  every run, `runStoreConformance` (16-case store contract suite, green on
  MemoryStore; Postgres consumes it at M6), 24 golden fixtures with
  normalized outcome traces (24/24 zero-tolerance), 200-seed fuzz with a
  greedy auto-minimizer that prints a pinnable golden, and the `pnpm chaos`
  artifact pipeline (chaos/results/*.json → chaos/RESULTS.md → README table
  injection) with a CI drift gate. The eval CI stage is now real: golden +
  fuzz + an in-process harness re-run diffed against the committed numbers.
- M5 measurement for SPEC §12.6 (retry-budget default 10%, amplification
  gate ≤ 1.5): under 30% injected failure the measured amplification is
  0.875× aggregate (1.15–1.18× on seeds where the breaker stays closed;
  < 1 on seeds where an unlucky early window trips it and load is shed).
  Both defaults are kept; the gate stays ≤ 1.5.
- M0: pnpm workspace (core / store-postgres / testkit), TS strict +
  `noUncheckedIndexedAccess`, ESLint 9 flat config with the core
  no-node-builtins boundary rule, Vitest 4 unit+eval projects, five-stage CI
  (typecheck → lint → unit → e2e:smoke → eval) plus build + pack-check guards,
  MIT license with brand-asset carve-out, SPEC committed.

### Changed
- Zero regressions across M7–M9: unit+eval grew from 151 to 178 tests (2
  skipped throughout, the real-Postgres path without `DATABASE_URL`), all
  passing; e2e grew from a no-op stage to 25 real Playwright tests, all
  passing.
