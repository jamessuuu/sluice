<p align="left">
  <img src="apps/web/public/brand/lockup-sluice.svg" alt="sluice — by Agent James" height="48">
</p>

# sluice

**Exactly-once side effects for agent tool calls, plus human approval gates that
survive a process crash. Proven by a chaos harness that runs without a model API key.**

> **Status: pre-release scaffold (M0).** The API in [docs/SPEC.md](docs/SPEC.md) is
> designed and frozen for v1; implementation is landing milestone by milestone.
> Nothing below claims to work until its milestone's tests say so — this README
> grows only as fast as the receipts do.

## Why

Agents retry. Transports redeliver. Processes crash mid-call. When the tool call is
`send_email` or `create_charge`, "at-least-once" is an incident. sluice wraps
side-effecting tool calls in:

- **Idempotent execution** — duplicate deliveries collapse to one side effect,
  with the result replayed to every caller.
- **Honest failure states** — `failed` (provably did not happen) is not the same
  state as `indeterminate` (we do not know). sluice refuses to collapse them, and
  fails closed on indeterminate by default.
- **Durable human approval gates** — a pending approval survives process death and
  resumes exactly once, from any process.
- **A tamper-evident audit trail** — hash-chained events, verifiable offline.

Zero runtime dependencies. No LLM anywhere. No telemetry.

<!-- chaos:begin -->
_Chaos-harness numbers land here at M5 (generated, CI-drift-checked — never
hand-written)._
<!-- chaos:end -->

## Monorepo

| Package | Purpose |
|---|---|
| `@jamessuuu/sluice` | Core: effects, gates, audit. Zero deps. |
| `@jamessuuu/sluice-store-postgres` | Neon/Postgres store (Drizzle, forward-only migrations). |
| `@jamessuuu/sluice-testkit` | Deterministic chaos harness + store conformance suite. |

The npm scope is `@jamessuuu` because the unscoped name is an abandoned 2013
package; the CLI binary and this repo are the identity.

## Non-goals

No domain logic (no senders, schedulers, incident models). No LLM calls. No
policy DSL / content guardrails. Not a workflow engine — sluice runs *inside*
one step of yours. No telemetry, ever.

---

Part of the [Agent James](https://agentjames.vercel.app) portfolio.
Built by James Lorenz Santos. Code MIT; brand assets excluded (see LICENSE).
