/**
 * @jamessuuu/sluice-testkit — deterministic chaos harness for sluice
 * (SPEC §7/§8): FakeTransport (the observable side-effect ledger), FaultPlan
 * (seeded, declarative fault schedules), VirtualClock (all sleeps/backoff/
 * lease-expiry/gate-timeouts in virtual time, auto-advancing), CrashController
 * (store-write and whole-process crashes), the 9-scenario taxonomy with
 * I1–I8 asserted on every run, golden replay, the 200-seed fuzz gate with
 * auto-minimizer, and the store conformance suite.
 *
 * Everything exported here is isomorphic-pure (no node builtins) — the
 * playground imports it in a Web Worker at M8. File I/O lives only in the
 * chaos CLI runner (src/chaos/, not re-exported here).
 */

export const SLUICE_TESTKIT_VERSION = "1.0.0-rc.1";

export {
  FaultPlan,
  mulberry32,
  type AttemptFault,
  type FaultPlanSpec,
} from "./fault-plan.js";
export { VirtualClock } from "./virtual-clock.js";
export {
  chaosClassify,
  FakeTransport,
  TransportError,
  TransportTimeoutError,
  type AttemptEntry,
  type LedgerEntry,
} from "./fake-transport.js";
export {
  CrashController,
  type StoreCrashPoint,
  type StoreMethodName,
} from "./crash-controller.js";
export { FaultyStore } from "./faulty-store.js";
export { StoreMonitor } from "./store-monitor.js";
export { checkInvariants, type DeliveryReport, type InvariantContext } from "./invariants.js";
export {
  runScenario,
  SCENARIO_NAMES,
  type RunScenarioOptions,
  type ScenarioConfig,
  type ScenarioName,
  type ScenarioResult,
} from "./scenarios.js";
export { runNaiveBaseline, type BaselineSideResult } from "./naive.js";
export {
  diffTraces,
  replayGolden,
  traceOf,
  verifyGolden,
  type GoldenCase,
  type GoldenFixture,
  type GoldenTrace,
} from "./golden.js";
export {
  fuzzCase,
  minimizeCase,
  minimizeFuzzCase,
  pinnableGolden,
  runFuzz,
  runFuzzCase,
  type FuzzCase,
  type FuzzReport,
} from "./fuzz.js";
export {
  runStoreConformance,
  type ConformanceFailure,
  type ConformanceReport,
} from "./conformance.js";
