# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: semver.

## [Unreleased]

### Added
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
