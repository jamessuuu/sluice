/**
 * The 9-scenario fault taxonomy and the runScenario orchestrator (SPEC §7).
 *
 * Every scenario builds the same kit — VirtualClock, FaultPlan, FakeTransport,
 * a shared MemoryStore wrapped in the StoreMonitor, and per-process
 * CrashController views — runs its script entirely in virtual time, then
 * asserts I1–I8. There is no path through runScenario that skips the
 * invariant check.
 *
 * Isomorphic-pure: no node builtins (the playground runs these scripts in a
 * Web Worker at M8).
 */

import {
  createSluice,
  MemoryStore,
  SluiceError,
  type AuditEvent,
  type EffectSpec,
  type GateSpec,
  type Sluice,
} from "@jamessuuu/sluice";
import { CrashController } from "./crash-controller.js";
import { chaosClassify, FakeTransport } from "./fake-transport.js";
import { FaultPlan, type FaultPlanSpec } from "./fault-plan.js";
import { checkInvariants, type DeliveryReport } from "./invariants.js";
import { StoreMonitor } from "./store-monitor.js";
import { VirtualClock } from "./virtual-clock.js";

export const SCENARIO_NAMES = [
  "duplicate-delivery",
  "timeout-then-success",
  "crash-mid-effect",
  "crash-before-effect",
  "crash-mid-gate",
  "retry-storm",
  "clock-skew",
  "slow-downstream",
  "out-of-order-decision",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** All fields JSON-serializable — golden fixtures embed this verbatim. */
export interface ScenarioConfig {
  intents?: number;
  /** Effect lease. Default 30_000. */
  leaseMs?: number;
  /** Whole-run deadline. Default 60_000. */
  deadlineMs?: number;
  /** Retry attempts inside one lease. Default: core default (3). */
  maxAttempts?: number;
  /** Gate timeout for gate-bearing scenarios. */
  gateTimeoutMs?: number;
  /** Scenario-specific switch (documented per scenario). */
  variant?: string;
  /** createSluice maxResultBytes override (the F10 replay-omitted path). */
  maxResultBytes?: number;
  /** Byte size of the value the transport returns (drives F10). */
  resultBytes?: number;
}

export interface RunScenarioOptions {
  scenario: ScenarioName;
  seed: number;
  plan?: FaultPlanSpec;
  config?: ScenarioConfig;
}

export interface ScenarioResult {
  scenario: ScenarioName;
  seed: number;
  /** Logical intents (the exactly-once unit). */
  intents: number;
  /** Delivery attempts started, including ones whose process crashed mid-call. */
  deliveries: number;
  /** Committed downstream side effects (the ledger). */
  ledgerCount: number;
  duplicateEffects: number;
  /** Downstream attempts (the I6 numerator). */
  attempts: number;
  amplification: number;
  reports: DeliveryReport[];
  /** `effect:<key>` / `gate:<key>` -> final status, sorted by key. */
  finalStatuses: Record<string, string>;
  /** Normalized audit trace: event types in sequence order. */
  eventTypes: string[];
  /** run() durations in VIRTUAL ms — never wall clock. */
  durationsVirtualMs: number[];
  violations: string[];
  gates: { total: number; terminal: number };
}

interface ScenarioDefaults {
  intents: number;
  plan: FaultPlanSpec;
  config?: ScenarioConfig;
}

const DEFAULTS: Record<ScenarioName, ScenarioDefaults> = {
  "duplicate-delivery": { intents: 6, plan: { deliveries: [2, 5] } },
  "timeout-then-success": { intents: 6, plan: { attemptOverrides: ["timeout"] } },
  "crash-mid-effect": { intents: 3, plan: {} },
  "crash-before-effect": { intents: 3, plan: {} },
  "crash-mid-gate": { intents: 2, plan: { crashes: 1 } },
  "retry-storm": { intents: 40, plan: { errorRate: 0.3 } },
  "clock-skew": { intents: 4, plan: { latencyMs: 100 } },
  "slow-downstream": { intents: 4, plan: { latencyMs: [5_000, 90_000] } },
  "out-of-order-decision": { intents: 6, plan: {} },
};

const NAMESPACE = "chaos";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 60_000;
const GATE_SLACK_MS = 1_000;
/** gates.claimDecided default lease (mirrors core). */
const CLAIM_LEASE_MS = 30_000;

/** Attach a rejection handler so an abandoned promise is never unhandled. */
function hush(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}

interface Proc {
  name: string;
  sluice: Sluice;
  controller: CrashController | null;
}

interface Kit {
  clock: VirtualClock;
  plan: FaultPlan;
  transport: FakeTransport;
  monitor: StoreMonitor;
  cfg: ScenarioConfig;
  leaseMs: number;
  deadlineMs: number;
  reports: DeliveryReport[];
  resumeIntents: string[];
  deliveryCount: { n: number };
  mkProc(name: string, o?: { skewMs?: number; crash?: CrashController }): Proc;
  deliver(proc: Proc, intent: string, extra?: Partial<EffectSpec>): Promise<void>;
  settle<T>(work: Promise<T>): Promise<T>;
}

function buildKit(seed: number, planSpec: FaultPlanSpec, cfg: ScenarioConfig): Kit {
  const clock = new VirtualClock();
  const plan = new FaultPlan(seed, planSpec);
  const transport = new FakeTransport(clock, plan);
  const monitor = new StoreMonitor(new MemoryStore());
  const leaseMs = cfg.leaseMs ?? DEFAULT_LEASE_MS;
  const deadlineMs = cfg.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const reports: DeliveryReport[] = [];
  const deliveryCount = { n: 0 };

  const mkProc: Kit["mkProc"] = (name, o) => {
    const controller = o?.crash ?? null;
    const store = controller === null ? monitor : controller.wrap(monitor);
    const procClock = o?.skewMs === undefined || o.skewMs === 0 ? clock : clock.skewed(o.skewMs);
    const sluice = createSluice({
      store,
      namespace: NAMESPACE,
      owner: name,
      clock: procClock,
      random: plan.stream(`jitter:${name}`),
      classify: chaosClassify,
      ...(cfg.maxAttempts === undefined ? {} : { retry: { maxAttempts: cfg.maxAttempts } }),
      ...(cfg.maxResultBytes === undefined ? {} : { maxResultBytes: cfg.maxResultBytes }),
    });
    return { name, sluice, controller };
  };

  const deliver: Kit["deliver"] = async (proc, intent, extra) => {
    deliveryCount.n++;
    const startedAt = clock.now();
    let report: DeliveryReport;
    try {
      const value =
        cfg.resultBytes === undefined ? undefined : "x".repeat(Math.max(0, cfg.resultBytes));
      const outcome = await proc.sluice.run(
        {
          key: intent,
          fingerprint: { intent },
          leaseMs,
          deadlineMs,
          ...extra,
        },
        (ctx) =>
          transport.call(intent, {
            signal: ctx.signal,
            ...(value === undefined ? {} : { value }),
          })
      );
      report = {
        intent,
        worker: proc.name,
        outcome: outcome.status,
        code: null,
        resultOmitted: outcome.status === "replayed" && outcome.value === undefined,
        virtualMs: clock.now() - startedAt,
      };
    } catch (err) {
      report = {
        intent,
        worker: proc.name,
        outcome: "error",
        code: err instanceof SluiceError ? err.code : "E_UNKNOWN",
        resultOmitted: false,
        virtualMs: clock.now() - startedAt,
      };
    }
    reports.push(report);
  };

  return {
    clock,
    plan,
    transport,
    monitor,
    cfg,
    leaseMs,
    deadlineMs,
    reports,
    resumeIntents: [],
    deliveryCount,
    mkProc,
    deliver,
    settle: (work) => clock.settle(work),
  };
}

function gateSpecFor(key: string, timeoutMs: number, extra?: Partial<GateSpec>): GateSpec {
  return {
    key,
    action: { kind: "chaos.effect", tool: "transport.call" },
    requester: { actor: "chaos-agent" },
    timeoutMs,
    ...extra,
  };
}

// ── the 9 scenario scripts ────────────────────────────────────────────────────

type Script = (kit: Kit, intents: string[]) => Promise<void>;

/**
 * F1 — each intent delivered 2–5× concurrently across two workers. The
 * `resultBytes`/`maxResultBytes` config drives the F10 replay-omitted path.
 */
const duplicateDelivery: Script = async (kit, intents) => {
  const w1 = kit.mkProc("w1");
  const w2 = kit.mkProc("w2");
  const workers = [w1, w2];
  for (const intent of intents) {
    const d = kit.plan.deliveriesFor(intent);
    const group: Promise<void>[] = [];
    for (let k = 0; k < d; k++) {
      const worker = workers[k % workers.length] ?? w1;
      group.push(kit.deliver(worker, intent));
    }
    await kit.settle(Promise.all(group));
  }
};

/**
 * F2 — the first downstream attempt COMMITS but the caller sees a timeout:
 * classified indeterminate, parked, never reported as success and never
 * auto-retried. A second delivery fails closed on the parked record.
 */
const timeoutThenSuccess: Script = async (kit, intents) => {
  const w1 = kit.mkProc("w1");
  const w2 = kit.mkProc("w2");
  for (const intent of intents) {
    await kit.settle(kit.deliver(w1, intent));
    await kit.settle(kit.deliver(w2, intent));
  }
};

/**
 * F3 — the process dies after the side effect landed, before the terminal
 * write. The lease expires; the next delivery discovers it, parks the record
 * indeterminate and fails closed. Ledger stays at 1.
 */
const crashMidEffect: Script = async (kit, intents) => {
  const w2 = kit.mkProc("w2");
  let i = 0;
  for (const intent of intents) {
    const crash = new CrashController();
    crash.crashAt({ method: "completeEffect", call: 1, mode: "before" });
    const doomed = kit.mkProc(`a${String(i)}`, { crash });
    hush(kit.deliver(doomed, intent)); // the report never lands — the process died
    await kit.settle(crash.whenCrashed);
    await kit.clock.advance(kit.leaseMs + 1);
    await kit.settle(kit.deliver(w2, intent));
    i++;
  }
};

/**
 * F4 — the process dies after the claim landed but before the side effect.
 * Indistinguishable from F3 by design: same indeterminate parking. Variants:
 * "fail" (default) stops there; "reclaim" re-executes via the explicit
 * opt-in; "gate" opens the "did this land?" gate and resumes via claimDecided.
 */
const crashBeforeEffect: Script = async (kit, intents) => {
  const w2 = kit.mkProc("w2");
  const variant = kit.cfg.variant ?? "fail";
  const gateTimeoutMs = kit.cfg.gateTimeoutMs ?? 600_000;
  let i = 0;
  for (const intent of intents) {
    const crash = new CrashController();
    crash.crashAt({ method: "claimEffect", call: 1, mode: "after" });
    const doomed = kit.mkProc(`a${String(i)}`, { crash });
    hush(kit.deliver(doomed, intent));
    await kit.settle(crash.whenCrashed);
    await kit.clock.advance(kit.leaseMs + 1);

    if (variant === "reclaim") {
      await kit.settle(kit.deliver(w2, intent)); // fails closed first (default policy)
      await kit.settle(kit.deliver(w2, intent, { onIndeterminate: "reclaim" }));
    } else if (variant === "gate") {
      const gateKey = `did-land-${intent}`;
      await kit.settle(
        kit.deliver(w2, intent, {
          onIndeterminate: "gate",
          gate: gateSpecFor(gateKey, gateTimeoutMs, {
            presentation: { title: `did ${intent} land?` },
          }),
        })
      );
      // A human answers out-of-band; a fresh process resumes via claimDecided.
      const human = kit.mkProc(`h${String(i)}`);
      const opened = await kit.settle(human.sluice.gates.pending({ namespace: NAMESPACE }));
      const gate = opened.find((g) => g.key === gateKey);
      if (gate !== undefined) {
        await kit.settle(
          human.sluice.gates.decide({ id: gate.id, decision: "approve", decidedBy: "operator" })
        );
        const resumer = kit.mkProc(`r${String(i)}`);
        const claims = await kit.settle(resumer.sluice.gates.claimDecided({}));
        for (const claim of claims) await kit.settle(claim.ack());
      }
    } else {
      await kit.settle(kit.deliver(w2, intent));
    }
    i++;
  }
};

/**
 * F5 — the gate survives process death; post-decision work runs through
 * run(), so resumption is exactly-once across N crashed resumers (I5).
 */
const crashMidGate: Script = async (kit, intents) => {
  const gateTimeoutMs = kit.cfg.gateTimeoutMs ?? 600_000;
  const crashes = Math.max(0, kit.plan.crashCount());
  let i = 0;
  for (const intent of intents) {
    const resumeIntent = `resume-${intent}`;
    kit.resumeIntents.push(resumeIntent);

    const opener = kit.mkProc(`o${String(i)}`);
    const gate = await kit.settle(
      opener.sluice.gates.open(
        gateSpecFor(`gate-${intent}`, gateTimeoutMs, {
          resumeContext: { intent, step: "publish" },
        })
      )
    );
    const openerCrash = new CrashController();
    openerCrash.crashNow(); // the agent that opened the gate is gone (F5)

    const human = kit.mkProc(`h${String(i)}`);
    await kit.settle(
      human.sluice.gates.decide({ id: gate.id, decision: "approve", decidedBy: "operator" })
    );

    for (let c = 0; c < crashes; c++) {
      const crash = new CrashController();
      crash.crashAt({ method: "ackGate", call: 1, mode: "before" });
      const doomed = kit.mkProc(`r${String(i)}c${String(c)}`, { crash });
      hush(
        (async () => {
          const claims = await doomed.sluice.gates.claimDecided({});
          for (const claim of claims) {
            await kit.deliver(doomed, resumeIntent);
            await claim.ack(); // dies here — the claim lease will expire
          }
        })()
      );
      await kit.settle(crash.whenCrashed);
      await kit.clock.advance(CLAIM_LEASE_MS + 1);
    }

    const survivor = kit.mkProc(`r${String(i)}z`);
    const claims = await kit.settle(survivor.sluice.gates.claimDecided({}));
    for (const claim of claims) {
      await kit.settle(kit.deliver(survivor, resumeIntent));
      await kit.settle(claim.ack());
    }
    i++;
  }
};

/**
 * F7 — 30% injected downstream failure across one circuitKey. The retry
 * budget caps amplification at the published ≤1.5 (I6); exhaustion is an
 * immediate E_RETRY_BUDGET fast-fail, never a stampede.
 */
const retryStorm: Script = async (kit, intents) => {
  const w1 = kit.mkProc("w1");
  for (const intent of intents) {
    await kit.settle(kit.deliver(w1, intent, { circuitKey: "downstream" }));
    // The storm arrives over time (1 intent/s of virtual time): an unlucky
    // early window may open the breaker, and the open interval then has a
    // timeline to elapse on so the half-open probe can close it again.
    await kit.clock.advance(1_000);
  }
};

/**
 * F8 — worker clocks disagree. Within the stated ceiling (≤ leaseMs/2) there
 * is no double execution; beyond it sluice fails CLOSED (the stale owner's
 * terminal write is refused, nobody reports success) rather than executing
 * twice. Variants: "within" | "beyond" | "mixed" (default, alternating).
 */
const clockSkew: Script = async (kit, intents) => {
  const variant = kit.cfg.variant ?? "mixed";
  const w1 = kit.mkProc("w1");
  const within = kit.mkProc("w2-within", { skewMs: Math.floor(kit.leaseMs / 2) });
  const beyond = kit.mkProc("w2-beyond", { skewMs: 2 * kit.leaseMs + 1 });
  let i = 0;
  for (const intent of intents) {
    const useBeyond = variant === "beyond" || (variant === "mixed" && i % 2 === 1);
    const skewed = useBeyond ? beyond : within;
    await kit.settle(Promise.all([kit.deliver(w1, intent), kit.deliver(skewed, intent)]));
    i++;
  }
};

/**
 * Slow downstream — latency spans the deadline. Fast-enough intents succeed
 * (slowly, feeding the p99); the rest are aborted by the deadline while the
 * request is in flight, land anyway (F2's shape) and are parked
 * indeterminate. Ledger stays ≤ 1, no phantom success.
 */
const slowDownstream: Script = async (kit, intents) => {
  const w1 = kit.mkProc("w1");
  for (const intent of intents) {
    await kit.settle(kit.deliver(w1, intent));
  }
};

/**
 * F6 — decisions race and arrive out of order. First writer wins; the loser
 * gets the recorded decision back (idempotent, not an error); a decision
 * arriving AFTER the timeout finds the gate already resolved to timed_out
 * (F12 beats a late decision). Variants: "approve-first" | "reject-first" |
 * "late" | "mixed" (default, cycling).
 */
const outOfOrderDecision: Script = async (kit, intents) => {
  const variant = kit.cfg.variant ?? "mixed";
  const gateTimeoutMs = kit.cfg.gateTimeoutMs ?? 60_000;
  const opener = kit.mkProc("opener");
  const ha = kit.mkProc("ha");
  const hb = kit.mkProc("hb");
  let i = 0;
  for (const intent of intents) {
    const which =
      variant === "mixed" ? ["approve-first", "reject-first", "late"][i % 3] : variant;
    const gate = await kit.settle(
      opener.sluice.gates.open(gateSpecFor(`gate-${intent}`, gateTimeoutMs))
    );
    if (which === "late") {
      await kit.clock.advance(gateTimeoutMs + 1);
      // The late decision must lose to the recorded timeout, not flip it.
      await kit.settle(
        ha.sluice.gates.decide({ id: gate.id, decision: "approve", decidedBy: "h-late" })
      );
    } else {
      const first =
        which === "reject-first"
          ? ha.sluice.gates.decide({ id: gate.id, decision: "reject", decidedBy: "h-a" })
          : ha.sluice.gates.decide({ id: gate.id, decision: "approve", decidedBy: "h-a" });
      const second =
        which === "reject-first"
          ? hb.sluice.gates.decide({ id: gate.id, decision: "approve", decidedBy: "h-b" })
          : hb.sluice.gates.decide({ id: gate.id, decision: "reject", decidedBy: "h-b" });
      await kit.settle(Promise.allSettled([first, second]));
    }
    i++;
  }
};

const SCRIPTS: Record<ScenarioName, Script> = {
  "duplicate-delivery": duplicateDelivery,
  "timeout-then-success": timeoutThenSuccess,
  "crash-mid-effect": crashMidEffect,
  "crash-before-effect": crashBeforeEffect,
  "crash-mid-gate": crashMidGate,
  "retry-storm": retryStorm,
  "clock-skew": clockSkew,
  "slow-downstream": slowDownstream,
  "out-of-order-decision": outOfOrderDecision,
};

// ── orchestrator ──────────────────────────────────────────────────────────────

export async function runScenario(o: RunScenarioOptions): Promise<ScenarioResult> {
  const defaults = DEFAULTS[o.scenario];
  const planSpec: FaultPlanSpec = { ...defaults.plan, ...o.plan };
  const cfg: ScenarioConfig = { ...defaults.config, ...o.config };
  const intentCount = cfg.intents ?? defaults.intents;
  const kit = buildKit(o.seed, planSpec, cfg);
  const intents: string[] = [];
  for (let i = 0; i < intentCount; i++) intents.push(`intent-${String(i)}`);

  // Scripts are self-settling: every step that can park on virtual time goes
  // through kit.settle. (Never wrap the whole script in settle() — nested
  // settle loops confuse each other's idle-drain deadlock detection.)
  await SCRIPTS[o.scenario](kit, intents);

  // I4 finalization: any still-pending gate is advanced past its horizon and
  // swept, so liveness is measured, not assumed.
  if (kit.monitor.gateIds.size > 0) {
    let maxExpires = -1;
    let anyPending = false;
    for (const id of kit.monitor.gateIds) {
      const record = await kit.monitor.readGate(id);
      if (record !== null && record.status === "pending") {
        anyPending = true;
        maxExpires = Math.max(maxExpires, record.expiresAt);
      }
    }
    if (anyPending) {
      const needed = maxExpires - kit.clock.now() + 1;
      if (needed > 0) await kit.clock.advance(needed);
      const janitor = kit.mkProc("janitor");
      await kit.settle(janitor.sluice.gates.sweepTimeouts());
    }
  }

  const events: AuditEvent[] = await kit.monitor.readEvents(NAMESPACE, 0, 1_000_000);

  // The invariant check needs the actual intents measured by the ledger —
  // include resume intents (crash-mid-gate's post-decision work).
  const allIntents = [...intents.filter((k) => hasIntent(kit, k)), ...kit.resumeIntents];

  const violations = await checkInvariants({
    namespace: NAMESPACE,
    transport: kit.transport,
    monitor: kit.monitor,
    store: kit.monitor,
    reports: kit.reports,
    events,
    intents: allIntents,
    resumeIntents: kit.resumeIntents,
    amplificationGate: injectedFailureRate(planSpec) >= 0.3 ? 1.5 : null,
    gateSlackMs: GATE_SLACK_MS,
  });

  const finalStatuses: Record<string, string> = {};
  const effectKeys = [...kit.monitor.effectKeys].sort();
  for (const id of effectKeys) {
    const { namespace, key } = StoreMonitor.splitEffectId(id);
    const record = await kit.monitor.readEffect(namespace, key);
    finalStatuses[`effect:${key}`] = record?.status ?? "none";
  }
  const gateIds = [...kit.monitor.gateIds].sort();
  for (const id of gateIds) {
    const record = await kit.monitor.readGate(id);
    if (record !== null) finalStatuses[`gate:${record.key}`] = record.status;
  }

  const ledgerCount = kit.transport.ledger.length;
  const attempts = kit.transport.attempts.length;
  let terminalGates = 0;
  for (const id of gateIds) {
    const record = await kit.monitor.readGate(id);
    if (record !== null && record.status !== "pending") terminalGates++;
  }

  return {
    scenario: o.scenario,
    seed: o.seed,
    intents: intentCount,
    deliveries: kit.deliveryCount.n,
    ledgerCount,
    duplicateEffects: kit.transport.duplicateCount(),
    attempts,
    amplification: allIntents.length === 0 ? 0 : attempts / allIntents.length,
    reports: kit.reports,
    finalStatuses: sortRecord(finalStatuses),
    eventTypes: events.map((e) => e.type),
    durationsVirtualMs: kit.reports.map((r) => r.virtualMs),
    violations,
    gates: { total: gateIds.length, terminal: terminalGates },
  };
}

function hasIntent(kit: Kit, key: string): boolean {
  // An intent counts once it produced any observable trace (delivery report,
  // ledger entry or store record) — scenario scripts deliver every intent, so
  // in practice this is always true; the guard keeps the checker honest.
  return (
    kit.reports.some((r) => r.intent === key) ||
    kit.transport.ledgerCount(key) > 0 ||
    [...kit.monitor.effectKeys].some((id) => StoreMonitor.splitEffectId(id).key === key)
  );
}

function injectedFailureRate(plan: FaultPlanSpec): number {
  return (plan.errorRate ?? 0) + (plan.timeoutRate ?? 0);
}

function sortRecord(r: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(r).sort()) {
    const value = r[k];
    if (value !== undefined) out[k] = value;
  }
  return out;
}
