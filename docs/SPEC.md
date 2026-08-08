# sluice — SPEC

**Exactly-once side effects for agent tool calls, plus human approval gates that survive a
process crash. Proven by a chaos harness that runs without a model API key.**

P3 of the showcase program (FLAGSHIP · reliability infrastructure). Binding upstream:
`showcase-program/PROGRAM.md` (D1–D6), `SELECTION.md`, `research/feasibility.md` §4/§4.2
(platform baseline), `BRAND-KIT.md`. Spec author: architect, 2026-08-08.

---

## 1. Goal + non-goals

**Goal.** A TypeScript library that makes an agent's side-effecting tool call safe to
retry, safe to duplicate, and safe to interrupt: idempotent execution with cached results,
typed retry/circuit policy, a durable human approval gate, and a tamper-evident audit
trail. Proof surface = a deterministic chaos harness (zero model API, runs in CI) plus a
docs site whose playground runs the real core in the browser.

**Non-goals (SELECTION.md guards — these are refusals, not backlog).**
1. **No domain.** No email/Slack senders, no incident model, no scheduler, no notification
   delivery. Approvers are opaque strings; sluice performs no identity, authn or authz.
2. **No LLM anywhere in core.** No model SDK dependency, no prompts, no classification.
3. **No guardrail-policy scope creep.** No policy DSL, no PII scanning, no content
   moderation, no "risk scoring".
4. **Not a workflow engine or queue.** No DAGs, no fan-out, no scheduling, no sagas or
   compensating transactions in v1. sluice runs *inside* a step of your workflow.
5. **No telemetry phone-home.** Ever.

P5 (dogwatch) is the production consumer: it supplies the domain, sluice supplies the
primitives. "P3 never ships a domain; P5 never reimplements a primitive."

---

## 2. Repo layout and what ships

```
sluice/                          GitHub jamessuuu/sluice (public, MIT + brand carve-out)
  packages/
    sluice/                      @jamessuuu/sluice        core + MemoryStore + CLI (bin: sluice)
    sluice-store-postgres/       @jamessuuu/sluice-store-postgres   Drizzle/Neon store + migrations
    sluice-testkit/              @jamessuuu/sluice-testkit  chaos harness, fake transport, conformance
  apps/web/                      Next.js 16.3 docs + playground (Vercel project `sluice`)
  chaos/results/                 committed harness output (the proof artifact)
  docs/SPEC.md  SECURITY.md  CHANGELOG.md  README.md
  .github/workflows/{ci.yml,release.yml}
```

**Decisions.**
- **Scoped npm publish: `@jamessuuu/sluice`.** The unscoped name is a dead 2013 squat
  (naming.md); contesting it is a distraction with no upside. The **CLI binary is `sluice`**
  and the repo is `jamessuuu/sluice` — those are the public identity. README states this
  in one honest line.
- **Three published packages, ESM-only, Node ≥ 22.** No CJS build (stated as a limitation).
  `sluice` core has **zero runtime dependencies** — that is a credibility feature and it is
  what lets the playground bundle it into a browser Web Worker.
- **No bundler:** `tsc -p tsconfig.build.json` emits `dist/` + `.d.ts`.
- **Local resolution without a build step:** each package's `exports` points at
  `./src/index.ts`; `publishConfig.exports` swaps to `./dist/index.js` at publish time.
  `apps/web` sets `transpilePackages` for both packages, so Next and Vitest compile source
  directly and there is no dist-ordering problem. *M0 verifies with `pnpm pack` that the
  tarball resolves to `dist/`; if pnpm does not rewrite `exports`, fall back to a `prebuild`
  that runs `pnpm -r build`.*
- **Release:** manual semver bump + `pnpm -r publish --access public --provenance` from a
  tag-triggered Actions workflow. Hand-written CHANGELOG (Keep a Changelog). No changesets —
  three packages, one maintainer, 2h/week.

---

## 3. Data model

Four tables. Every operation must be expressible as **one SQL statement** (no interactive
transactions) so the store works over the Neon HTTP driver and inside a serverless function.

### `sluice_effect` — PK `(namespace, key)`
| column | type | note |
|---|---|---|
| namespace, key | text | key ≤ 200 chars |
| fingerprint | text | sha256 of canonical args; **mismatch on the same key ⇒ `E_KEY_CONFLICT`** (catches a key derived too loosely) |
| status | text | `in_flight` \| `succeeded` \| `failed` \| `indeterminate` |
| attempt | int | claims, not retries |
| lease_owner, lease_expires_at | text, timestamptz | fencing |
| result_json / result_omitted | jsonb / bool | result cached for replay; > `maxResultBytes` (64 KiB) stores the marker instead |
| error_json | jsonb | `{code, message, retryable, indeterminate}` — never a stack |
| created_at, updated_at, expires_at | timestamptz | `expires_at` = retention horizon |

Indexes: `(expires_at)` for sweep, `(status, lease_expires_at)` for reclaim scan.

**The three decisions that matter.**
1. **Four states, not three.** `failed` means *provably did not happen* (replay returns the
   recorded typed error). `indeterminate` means *we do not know* — a caller-side timeout,
   a crash after send, or an expired lease. Every idempotency helper collapses these two;
   collapsing them is exactly how a charge gets made twice. sluice **fails closed** on
   indeterminate by default and offers `reclaim` / `gate` as explicit opt-ins.
2. **Claim is one statement.** `INSERT … ON CONFLICT (namespace,key) DO UPDATE SET
   lease_owner=EXCLUDED.lease_owner, lease_expires_at=…, attempt=attempt+1 WHERE
   status='in_flight' AND lease_expires_at < now() RETURNING *`. Zero rows returned ⇒ read
   the existing row and branch (replay / conflict / indeterminate). No transaction, no
   advisory lock, safe under concurrent duplicate delivery.
3. **TTL is a memory horizon, not a correctness knob.** Default retention 7 days, set longer
   than the longest possible duplicate-delivery window. After expiry the same key executes
   again — documented in bold, because it is the one way a user can shoot themselves.

### `sluice_gate` — PK `id` (uuidv7, generated in app), unique `(namespace, key)`
`status` (`pending|approved|rejected|timed_out|cancelled`), `action_json`,
`presentation_json`, `requester`, `run_id`, `approvers text[]`, `resume_context jsonb`
(≤ 32 KiB), `created_at`, `expires_at`, `decided_at`, `decided_by`, `decision_reason`,
`token_hash`, `token_nonce`, `claim_owner`, `claim_expires_at`, `processed_at`.
Indexes: `(status, expires_at)`, `(namespace, status)`, `(status, decided_at)`.

Opening the same `(namespace,key)` twice returns the existing gate — gates are idempotent
like effects. Deciding is a conditional update `WHERE status='pending'`: **first writer
wins, and a second decide returns the recorded decision rather than an error.**

### `sluice_event` — append-only, hash-chained per namespace
`id`, `namespace`, `seq bigint`, `ts`, `subject_type`, `subject_key`, `type`, `attempt`,
`actor`, `data jsonb` (≤ 8 KiB), `prev_hash`, `hash`. Unique `(namespace, seq)`.
Companion `sluice_cursor(namespace PK, seq, head_hash, updated_at)`.

Append is a single data-modifying CTE: `WITH c AS (UPDATE sluice_cursor SET seq=seq+1 …
RETURNING seq, head_hash) INSERT INTO sluice_event SELECT …, encode(sha256(convert_to(
c.head_hash || $payload,'UTF8')),'hex') FROM c RETURNING *`, then a second CTE updates
`head_hash`. `sha256()` is a Postgres 11+ builtin — **no pgcrypto extension required**.
The cursor row lock serializes appends per namespace: honest ceiling ~hundreds of
events/sec, disable with `audit.chain=false`. `audit.verify()` recomputes the chain in JS.

### `sluice_circuit` — PK `key` (`namespace:circuitKey`)
`state`, `version` (CAS), `window_json` (last 20 outcomes), `opened_at`, `open_ms`,
`half_open_owner`, `half_open_expires_at`, `updated_at`.

**Migrations: forward-only, additive-only.** Numbered SQL under
`packages/sluice-store-postgres/migrations/`, generated by drizzle-kit and checked in.
No column drops, no type narrowing, no destructive backfills — stated as repo policy in
SECURITY.md. `db:migrate` + `db:seed` give a reviewer a working local instance (§4.2.7).

---

## 4. Module / boundary map

```
             ┌──────────────────────── @jamessuuu/sluice (zero deps) ───────────────────────┐
 caller ───▶ │ run()  ─▶ classify ─▶ retry(budget) ─▶ circuit ─▶ effect state machine       │
 (P5,        │ gate()/gates.* ─▶ gate state machine                                          │
  demo)      │ audit.* ─▶ event builder (canonical JSON + hash chain)                        │
             │ clock, random, owner  ← INJECTED (this is what makes chaos deterministic)     │
             └───────────────────────────────┬──────────────────────────────────────────────┘
                                             │ SluiceStore (one SQL statement per method)
                          ┌──────────────────┴───────────────────┐
                    MemoryStore (in core)            @…/sluice-store-postgres
                    tests · playground · CLI          Drizzle + Neon/node-postgres
```

Isolation rules: core never imports a driver, a framework, `node:fs`, or `process.env`.
The store never contains policy (retry, breaker, timeout logic lives in core only). The
web app never imports the postgres store. The testkit is the only package allowed to
depend on both core and a fake transport.

---

## 5. API surface

```ts
// ── construction ──────────────────────────────────────────────────────────────
export function createSluice(o: {
  store: SluiceStore;
  namespace?: string;                 // default 'default'
  owner?: string;                     // instance id; default host:pid:rand
  clock?: Clock;                      // { now(): number; sleep(ms, signal?): Promise<void> }
  random?: () => number;              // seeded in tests — deterministic backoff/jitter
  retry?: RetryPolicy;
  circuit?: CircuitPolicy | false;
  classify?: (err: unknown) => 'retryable' | 'failed' | 'indeterminate';
  retentionMs?: number;               // default 7d
  maxResultBytes?: number;            // default 65536
  audit?: { chain?: boolean; sink?: (e: AuditEvent) => void };
  approvalSecret?: string;            // only needed to mint approval tokens
}): Sluice;

// ── idempotency keys ──────────────────────────────────────────────────────────
export function idempotencyKey(parts: Json): string;  // sha256(canonicalJson(parts)) hex
// Doctrine (documented at the top of the idempotency page): derive from the INTENT
// — { tool, args, actor, runId } — never from the transport attempt (message id,
// delivery id, timestamp). A key that changes on retry is not an idempotency key.

// ── effects ───────────────────────────────────────────────────────────────────
interface EffectSpec {
  key: string; namespace?: string;
  fingerprint?: Json;                 // hashed; mismatch ⇒ E_KEY_CONFLICT
  leaseMs?: number;                   // default 30_000 (heartbeat at leaseMs/3)
  deadlineMs?: number;                // default 60_000, whole run incl. retries
  retry?: Partial<RetryPolicy>; circuitKey?: string;
  onIndeterminate?: 'fail' | 'reclaim' | 'gate';   // default 'fail'
  gate?: GateSpec;                    // required iff onIndeterminate:'gate'
  retentionMs?: number;
}
type EffectOutcome<T> =
  | { status:'executed'; value:T; attempts:number; effectId:string }
  | { status:'replayed'; value:T; effectId:string; firstSeenAt:number }
  | { status:'replayed'; value:undefined; resultOmitted:true; effectId:string; firstSeenAt:number };

sluice.run<T>(spec: EffectSpec, fn: (ctx: EffectContext) => Promise<T>): Promise<EffectOutcome<T>>;
sluice.inspect(key: string, ns?: string): Promise<EffectRecord | null>;
sluice.sweep(now?: number): Promise<{ effects:number; gates:number; events:number }>;
// EffectContext = { effectId, key, namespace, attempt, signal: AbortSignal, now(), note(data) }
// fn may throw `new Indeterminate(cause)` to force classification.
```

**Retry policy** (inside one lease, retryable errors only): full-jitter exponential backoff
`delay = random() * min(maxDelayMs, baseDelayMs * 2**attempt)`; `baseDelayMs` 200,
`maxDelayMs` 10_000, `maxAttempts` 3. `Retry-After` (seconds or HTTP-date) is honoured when
≤ `maxRetryAfterMs` (60s), otherwise the call fails fast with the header surfaced.
**Retry budget**: token bucket per `(namespace, circuitKey)` capping retries at 10% of
calls; exhaustion ⇒ `E_RETRY_BUDGET` immediately (this is the retry-storm defence and the
source of the published amplification number). Retries never exceed `deadlineMs`; the
deadline aborts `ctx.signal`.

**Circuit breaker** per `circuitKey`: rolling window of 20 outcomes, opens at ≥50% failures
with ≥5 samples, `openMs` 30s ±20% jitter, doubling to `maxOpenMs` 5min. Half-open admits
**exactly one probe**, enforced by a CAS write to the store (`half_open_owner`), so
concurrent serverless instances cannot all probe. Breaker state is read-through cached
1s in-process — one extra query per second per instance, never per call. Honest note in
docs: breaker sharing is eventually consistent within 1s.

```ts
// ── gates ─────────────────────────────────────────────────────────────────────
interface GateSpec {
  key: string; namespace?: string;
  action: { kind: string; tool?: string; args?: Json; digest?: string };
  presentation?: { title: string; summary?: string; details?: Json };
  requester: { actor: string; runId?: string };
  approvers?: string[];               // opaque ids; sluice does not resolve identity
  timeoutMs: number;                  // REQUIRED — there is no unbounded gate
  onTimeout?: 'reject' | 'approve';   // default 'reject' (fail closed)
  resumeContext?: Json;               // ≤32 KiB — what a NEW process needs to continue
}
sluice.gates.open(s: GateSpec): Promise<GateRecord>;              // idempotent on (ns,key)
sluice.gates.get(id: string): Promise<GateRecord | null>;
sluice.gates.waitFor(id, o?: { maxWaitMs?; pollMs?; signal? }): Promise<GateRecord>;
sluice.gates.decide(i: { id; decision:'approve'|'reject'; decidedBy:string; reason?:string;
                         token?:string }): Promise<GateRecord>;   // first writer wins
sluice.gates.cancel(id, by, reason?): Promise<GateRecord>;
sluice.gates.mintToken(id, o?: { ttlMs? }): string;               // HMAC-SHA256, single-use
sluice.gates.pending(q?): Promise<GateRecord[]>;
sluice.gates.claimDecided(o?: { leaseMs?; limit? }): Promise<GateClaim[]>;
sluice.gates.sweepTimeouts(now?): Promise<number>;
sluice.gate(s: GateSpec, o?): Promise<GateRecord & { status:'approved' }>;  // sugar; throws on reject/timeout

// ── audit ─────────────────────────────────────────────────────────────────────
sluice.audit.append(e: AuditInput): Promise<AuditEvent>;   // consumers may add their own
sluice.audit.since(c: { namespace; seq }, limit?): Promise<AuditEvent[]>;
sluice.audit.export(ns: string, o?): AsyncIterable<AuditEvent>;      // dogwatch publishes this
sluice.audit.verify(ns: string, o?): Promise<{ ok:boolean; brokenAt?:number; checked:number }>;

// ADDENDUM 2026-08-08 (dogwatch SPEC §14 Q1, accepted by the dispatcher):
// pure, store-free verification of an EXPORTED event slice — required by
// dogwatch's browser verifier, useful to any consumer. Ships in the frozen
// v1.0 surface alongside the hash chain (M9). Not domain-shaped.
export function verifyEvents(events: AuditEvent[], prevHead?: string | null):
  { ok: boolean; brokenAt?: number; checked: number };
```

Event types: `effect.claimed | effect.attempt_failed | effect.succeeded | effect.failed |
effect.indeterminate | effect.replayed | effect.key_conflict | gate.opened | gate.decided |
gate.timed_out | gate.claimed | gate.resumed | circuit.opened | circuit.half_open |
circuit.closed | retry.budget_exhausted`.

**Resumption delivery — decided: polling is primary, push is out of scope.**
`waitFor` polls with backoff 1s → ×1.5 → **cap 60s** (not 5s: on Neon Free a tight poll
keeps compute from scaling to zero and burns the 100 CU-hr budget — one 24h gate at 5s
polling would cost ~24 CU-hrs). Docs state the rule: **waits > 5 minutes must use
`open()` + return, and resume from a scheduled poller** (`claimDecided`, GitHub Actions
every 5 min per D4). A webhook/push dispatcher is an application concern and stays out of
core; sluice guarantees the decision is durable and readable, not that it is pushed to you.

**Store interface** (`SluiceStore`): `claimEffect`, `completeEffect`, `heartbeatEffect`,
`readEffect`, `openGate`, `readGate`, `decideGate`, `listGates`, `claimDecidedGates`,
`expireGates`, `appendEvents`, `readEvents`, `readCircuit`, `writeCircuit`, `sweep`,
`capabilities`. Every method: one statement, no cross-method transaction assumed. The
testkit exports `runStoreConformance(makeStore)` — the same suite runs against MemoryStore
and Postgres, and **that is the contract for any future adapter**.

**Auth model.** The library has none by design (approvers are opaque strings) except one
primitive: `mintToken` issues a single-use HMAC-SHA256 approval token
(`base64url(gateId.exp.nonce).mac`) so an emailed link can decide without a session.
Timing-safe compare; single-use falls out of the gate's own state machine — the same
conditional update that records the decision (`WHERE status='pending'`) is what makes a
second use a no-op, so there is no nonce table to consult and the path stays one statement.
`E_BAD_TOKEN` on any mismatch. **The hosted demo has no server-side write path at all**
(§7) — the quality bar "no unauthenticated write path, ever" is met structurally.

**P5 (dogwatch) consumer contract — frozen at v1.0.0:** `run()` per tool call,
`gate()`/`gates.open()+claimDecided()` for the publish gate, `audit.export()` for the
published run record, `audit.verify()` for tamper-evidence, `MemoryStore` for its tests,
`sluice-store-postgres` in production. Nothing domain-shaped is added to sluice for P5;
if dogwatch needs it and it names an incident, an email, or a schedule, it lives in dogwatch.

---

## 6. Failure contracts (the ugly paths, explicitly)

| # | Fault | Contract |
|---|---|---|
| F1 | **Duplicate delivery** (2–5×, concurrent) | Exactly one claim wins; losers read the record. Winner executing ⇒ losers get `E_STORE_BUSY`-free behaviour: they poll the record to terminal state (bounded by `deadlineMs`) and return `replayed`. Side-effect ledger count is 1. |
| F2 | **Timeout, effect landed anyway** | Classified `indeterminate`. Default `onIndeterminate:'fail'` ⇒ `E_INDETERMINATE` thrown, row parked as `indeterminate`, **never reported as success and never auto-retried**. `'gate'` opens a human gate ("did this land?"); `'reclaim'` re-executes and is only legal when the caller declares the downstream idempotent. |
| F3 | **Crash after side effect, before result persisted** | Lease expires ⇒ next claim finds `in_flight` + expired lease ⇒ transitions to `indeterminate` (not a silent re-claim). Same three policies as F2. |
| F4 | **Crash before the side effect** | Same `indeterminate` transition — sluice cannot distinguish F3 from F4, and says so in the docs. This is why `'fail'` is the default. |
| F5 | **Crash mid-gate** | Gate row is durable; `resumeContext` carries what a new process needs. A new process resumes via `claimDecided` (leased) and post-decision work runs through `run()`, so resumption is itself exactly-once. |
| F6 | **Double decision / approve-reject race** | Conditional update; first writer wins; the second call returns the recorded decision (idempotent, not an error). Audit records both attempts. |
| F7 | **Retry storm** | Retry budget (10%) + full-jitter backoff + breaker. Exhaustion ⇒ `E_RETRY_BUDGET` fast-fail. Published amplification factor is the receipt. |
| F8 | **Clock skew between workers** | With skew ≤ `leaseMs/2` no double execution (leases and gate timeouts are compared with a skew allowance). Beyond that sluice **fails closed to `indeterminate`** rather than double-executing. Stated ceiling; harness scenario asserts it. |
| F9 | **Key reuse with different args** | `fingerprint` mismatch ⇒ `E_KEY_CONFLICT` + audit event. Never silently returns the other call's result. |
| F10 | **Result too large** | Stored as `resultOmitted`; replay returns `{status:'replayed', value: undefined, resultOmitted:true}`. Callers must handle it — the type forces it. |
| F11 | **Store unavailable** | `E_STORE`, marked `indeterminate:true` if it fails *after* the claim, `retryable:true` if before. sluice never executes `fn` without a granted claim. |
| F12 | **Gate timeout** | `sweepTimeouts` (and any read of an expired gate) resolves to `timed_out` and applies `onTimeout` (default `reject`). `sluice.gate()` throws `E_GATE_TIMEOUT`. |

**Error taxonomy** — all extend `SluiceError { code, retryable, indeterminate, context }`,
no stacks or driver strings ever surfaced: `E_KEY_CONFLICT`, `E_INDETERMINATE`,
`E_EFFECT_FAILED`, `E_CIRCUIT_OPEN`, `E_RETRY_BUDGET`, `E_DEADLINE`, `E_LEASE_LOST`,
`E_GATE_REJECTED`, `E_GATE_TIMEOUT`, `E_WAIT_TIMEOUT`, `E_BAD_TOKEN`, `E_STORE`,
`E_RESULT_TOO_LARGE`, `E_CONFIG`. This table ships in the README as the failure-mode table
(§4.2.8), one row per fault with mode / detection signal / fallback.

---

## 7. Chaos harness (the proof artifact)

`@jamessuuu/sluice-testkit`: `FakeTransport` (records every side effect into an observable
**ledger**), `FaultPlan` (seeded mulberry32 PRNG, implemented in-repo), `VirtualClock`
(all sleeps, backoff, lease expiry and gate timeouts read from it), `CrashController`
(aborts a store write or the whole "process" at a chosen point).

**Fault taxonomy (published list):** `duplicate-delivery`, `timeout-then-success`,
`crash-mid-effect`, `crash-before-effect`, `crash-mid-gate`, `retry-storm`, `clock-skew`,
`slow-downstream`, `out-of-order-decision`.

**Invariants asserted (every scenario, every seed):**
- **I1 exactly-once** — ledger entries per logical intent ≤ 1 always, = 1 whenever `run()`
  reported `executed` or `replayed`.
- **I2 no phantom success** — reported success ⇒ the ledger entry exists.
- **I3 fail-closed** — `indeterminate` outcomes never report success and never re-execute
  under the default policy.
- **I4 gate liveness** — every gate reaches terminal state within `timeoutMs` + slack.
- **I5 gate resume exactly-once** — post-decision work runs once across N crashes.
- **I6 retry amplification** — downstream attempts / logical intents ≤ **1.5** under 30%
  injected failure (CI gate).
- **I7 audit completeness** — every terminal effect has a matching terminal event and the
  hash chain verifies.
- **I8 monotonic terminal states** — nothing leaves a terminal state except retention.

**Published numbers** (generated, never hand-written): baseline (`naive` direct call) vs
sluice for success rate and **duplicate side-effect count**; retry-amplification factor;
p50/p99 of `run()` under fault injection, **labelled "virtual clock time, not wall clock"**;
run shape (9 scenarios × 10 seeds × N intents) and the git SHA.

**Artifact pipeline.** `pnpm chaos` → `chaos/results/latest.json` +
`chaos/results/<date>-<sha>.json`; `scripts/chaos-report.mjs` renders `chaos/RESULTS.md`
and injects a table into README between `<!-- chaos:begin -->` / `<!-- chaos:end -->`.
**CI regenerates and fails if the committed README block differs** — the README cannot
drift from the numbers. `apps/web` imports the same `latest.json`, so the site and the
README are the same source of truth (receipts rule).

---

## 8. Eval / golden set (feasibility §4.1)

The eval stage for a deterministic library is a **golden set of fault scenarios with
expected outcome traces**: 24 fixtures in `packages/sluice-testkit/golden/*.json`, each
`{ id, seed, plan, config, expected: { ledgerCount, finalStatus, eventTypes[], attempts } }`.
The runner replays each with a fixed seed and virtual clock and diffs the **normalized
outcome trace** (event type sequence + terminal statuses + ledger counts; ids and timestamps
normalized).

**Pass bar: 24/24, zero tolerance** — the system is deterministic, so a percentage bar
would be dishonest. Any diff is an intentional behaviour change and must regenerate the
goldens in the same PR with a CHANGELOG entry. **Second gate:** 200 randomized seeds with
zero I1–I8 violations; a failing seed is auto-minimized (shrink the fault plan) and printed
for pinning as golden #25. README badge: `golden 24/24 · fuzz 200 seeds · 0 invariant violations`.

**CI, five stages (D6):** `typecheck → lint → unit → e2e:smoke → eval`.
- unit: Vitest 4, incl. `runStoreConformance` against MemoryStore **and** a
  `postgres:17` service container (CI never needs Neon — Neon is only the demo/P5 store).
- e2e:smoke: Playwright against `next build && next start` — landing renders with numbers,
  gate walkthrough completes, footer/favicon present.
- eval: golden + fuzz + chaos-report drift check.
Also in CI: `pnpm -r build` (proves `dist` compiles), `pnpm pack` shape check.

---

## 9. Demo site (`apps/web`)

Next.js 16.3 App Router / React 19.2 / TS strict + `noUncheckedIndexedAccess` / Tailwind 4.
**Zero API routes. Zero database. Zero writes.** The hosted demo does not use Neon —
justified: (a) satisfies "no unauthenticated write path" structurally, (b) D3 blackout-safe
because there are no functions to pause, (c) Neon's 5-minute cold start would wreck the
30-second gate walkthrough. The Postgres store is proven by CI and by P5, not by the demo.

- **`/` landing** — fully static: name, tagline, install snippet, the chaos table built from
  `chaos/results/latest.json` at build time, links. Renders with JS disabled and during any
  platform pause (D3).
- **`/playground`** — the **real core** in a Web Worker against `MemoryStore` +
  `FakeTransport` + `VirtualClock`. Sliders: duplicate rate, timeout rate, error rate, crash
  toggle, seed. Renders the live effect ledger, the audit event stream, and a side-by-side
  **without sluice / with sluice** duplicate-side-effect counter. Zero server cost
  (feasibility §5.H.4, §7.3).
- **`/gate`** — the ≤30s walkthrough: a scripted "dogwatch publish" opens a gate → the worker
  panel **auto-crashes** after 2s → the pending card stays (store mirrored to
  `sessionStorage`, so a real page reload also survives) → visitor clicks **Approve** →
  "Start worker" resumes from `resumeContext` and the side effect fires **once** → the audit
  trail prints. A "Replay everything" button proves the second run does nothing.
- **`/audit`** — a fixture trail with a **Verify chain** button recomputing the hash chain
  in the browser; a "Tamper" button flips a byte and shows the chain break.
- **`/docs/*`** — MDX, statically compiled: quickstart, idempotency keys, retries & breaker,
  gates, stores & migrations, chaos harness, failure modes, **limitations**.

**Cost safety (D2).** sluice has **no path to a model call anywhere** — the standing gate is
N/A and the README says so with the reason. Metered exposure is edge requests only:
expected ~2k views/mo ≈ 0.6% of the 1M budget; abuse case = one IP at the single Hobby WAF
rate-limit rule (30 req/10s, bound to `/*`, documented in `docs/OPERATIONS.md`) ≈ 259k
edge requests/day. Vercel DDoS mitigation + Attack Mode is the real defence; the worst case
is a 30-day pause of **the demo site only**, which invalidates no claim, because every
published number is reproducible from the repo with `pnpm chaos`.

**Branding (BRAND-KIT, acceptance criteria).** `public/brand/` with `mark.svg`,
`mark-16.svg`, `mark-inv.svg`, `mark-16-inv.svg` copied from
`agentjames/public/brand/system/`; chip-mark favicon; footer on **every** page (chip mark +
"Built by James Lorenz Santos" + agentjames.vercel.app + repo link) and **no hire-me CTA**
(D1); README lockup header + "Part of the Agent James portfolio" footer with sibling links;
per-project glyph — **a weir gate: a channel with a raised sluice plate, ink strokes, one
amber accent on the held item** — drawn on the 64px grid by a committed deterministic
`scripts/brand.mjs` (no `Math.random`, no webfont, dot-matrix type generated, following
`system.mjs`); OG image generated at build from SVG via sharp; brand-asset licensing
carve-out in LICENSE and README.

---

## 10. Build order — walking skeleton, then increments

Each milestone ends in a green-gate commit (all five CI stages pass).

| M | Deliverable | Verified by |
|---|---|---|
| **M0** | pnpm workspace, three package skeletons, tsconfig strict + `noUncheckedIndexedAccess`, ESLint 9 flat, Vitest 4, five-stage CI (eval stage trivially passing), MIT + brand carve-out, README stub with lockup, `pnpm pack` shape check | CI green on an empty repo; tarball resolves to `dist/` |
| **M1** | **WALKING SKELETON:** core types, `MemoryStore`, `createSluice`, `run()` with claim → execute → persist → replay (no retries, no breaker, no gates), unchained audit events, `idempotencyKey()` | Test: 5 concurrent duplicate deliveries ⇒ ledger count 1. Publishable as `0.1.0-alpha`; dogfoodable immediately |
| **M2** | Failure semantics: `classify`, `indeterminate`, lease + heartbeat + expiry reclaim, `onIndeterminate` policies, fingerprint conflict, full error taxonomy | Unit tests for F2, F3, F4, F9, F11 |
| **M3** | Retries (full jitter, `Retry-After`, deadline/AbortSignal), retry budget, circuit breaker with single-probe half-open, injected `clock`/`random` | Deterministic backoff test (fixed seed ⇒ fixed delay sequence); F7 |
| **M4** | Gates: open/get/waitFor/decide/cancel/sweepTimeouts/claimDecided, `resumeContext`, HMAC single-use tokens, `sluice.gate()` sugar | F5, F6, F12 |
| **M5** | Testkit: FakeTransport, FaultPlan, VirtualClock, CrashController, 9 scenarios, I1–I8, 24 goldens, 200-seed fuzz + minimizer, `pnpm chaos`, report generator, README injection + drift check | **Eval stage becomes real.** Numbers land in README |
| **M6** | `sluice-store-postgres`: Drizzle schema, forward-only migrations, single-statement implementations, hash-chain SQL, `db:migrate`/`db:seed`, conformance suite in CI against `postgres:17` service | Conformance suite passes identically on Memory + Postgres |
| **M7** | `apps/web`: static landing, docs MDX, brand assets, `scripts/brand.mjs` glyph, OG generator, favicon, footer; Vercel project + WAF rule; SECURITY.md, OPERATIONS.md | Playwright smoke; live URL renders with JS disabled |
| **M8** | Playground + `/gate` walkthrough (Web Worker, sessionStorage persistence, kill/restart) + `/audit` verify/tamper | Playwright: gate walkthrough completes in < 30s of interaction |
| **M9** | Hash-chained audit + `verify` + `export`, `sluice` CLI (`sluice gates ls|approve|reject`, `sluice chaos --seed`), README failure-mode table, limitations section, `--provenance` release workflow, publish `1.0.0-rc.1`, freeze the P5 consumer contract | Full acceptance checklist §11; a dogwatch spike compiles against the frozen surface |

Cut line if the program slips: M9's CLI. Never cut M5.

---

## 11. Acceptance criteria

**Platform / §4.2 minimum bar.** ☐ TS strict + `noUncheckedIndexedAccess`, no `as any` at a
boundary ☐ Zod at every external input in `apps/web` (core uses hand-written guards to stay
zero-dep) ☐ **no unauthenticated write path** (demo has no write path at all) ☐ WAF rule
configured + documented ☐ cost ceiling N/A with the reason stated (no model call path)
☐ structured error taxonomy, no stacks or driver strings to callers ☐ self-persisted
observability = the audit table ☐ migrations + seed checked in, forward-only ☐ **README
failure-mode table (F1–F12)** ☐ SECURITY.md incl. approval-token threat note.

**Product.** ☐ Exactly-once proven by ledger assertions, not prose ☐ gate survives a real
process death in CI *and* a real page reload in the browser demo ☐ chaos numbers generated,
committed, CI-drift-checked ☐ golden 24/24 + fuzz 200 seeds 0 violations ☐ store conformance
green on Memory + Postgres ☐ published limitations: ESM-only, TTL semantics, chain
throughput ceiling, breaker eventual consistency, clock-skew ceiling, virtual-clock latency
numbers ☐ three packages published under `@jamessuuu/*` with provenance.

**Brand (BRAND-KIT).** ☐ chip-mark favicon ☐ footer with attribution + backlink + repo link
on every page ☐ README lockup header + portfolio footer ☐ sluice glyph from a committed
deterministic generator ☐ OG image generated at build in the house palette ☐ brand-asset
licensing carve-out ☐ palette compliance (PAPER/INK/AMBER/RULE, 0–2px radius, no gradients,
no dark chrome) ☐ **no hire-me CTA anywhere** (D1).

**Boundary.** ☐ core has zero runtime dependencies ☐ core imports no driver, framework,
`node:fs` or `process.env` ☐ no domain vocabulary in any public identifier ☐ non-goals
section present in the README.

---

## 12. Open questions (deferred to the main session)

1. **`pnpm publishConfig.exports` rewrite** — verify with `pnpm pack` in M0; fall back to a
   `prebuild` if it does not apply. *(Blocking M0 only.)*
2. **npm scope + name availability at publish time** — re-check `@jamessuuu/sluice` and the
   `sluice` bin at M9; naming.md's dead-squat finding is from 2026-08-08.
3. **`sluice.vercel.app` availability** — fallback `sluice-dev.vercel.app`. Domain purchase
   is James's call, not a build dependency.
4. **Postgres driver matrix** — spec requires single-statement ops so both `node-postgres`
   and Neon HTTP work; decide at M6 whether to ship one entry point taking a Drizzle
   instance (preferred) or two thin factories.
5. **Whether `@jamessuuu/sluice-testkit` ships publicly at 1.0** — recommended yes (it lets
   consumers write their own chaos tests); acceptable to hold at `private: true` until M9 if
   its API is still moving.
6. **Retry-budget default (10%) and amplification gate (≤1.5)** — placeholders chosen to be
   provably achievable; tighten in M5 once the first real distribution is measured, and
   record the change in CHANGELOG rather than silently editing the gate.
