# Security

sluice is a library, not a service — most of what would normally live here
(auth, rate limiting, network exposure) is your application's responsibility,
not sluice's. This document covers the parts that are sluice's responsibility:
the one auth primitive it does ship, the hosted demo's threat model, and how
to report a problem.

## Scope

`@jamessuuu/sluice`, `@jamessuuu/sluice-store-postgres`, and
`@jamessuuu/sluice-testkit` — the three published packages — and the demo
site at `apps/web` (sluice-iota.vercel.app).

Out of scope: your application code, your database credentials, your
downstream services. sluice performs no identity resolution and has no
concept of "user" — approvers in the gate system are opaque strings you
supply, not accounts sluice manages.

## The approval-token threat model

`sluice.gates.mintToken()` issues a **single-use, time-limited, HMAC-SHA256**
token (`base64url(gateId.exp.nonce).mac`) so an emailed approval link can
decide a gate without a session. Threats considered and how they're closed:

| Threat | Mitigation |
|---|---|
| Token guessing / brute force | 256-bit HMAC over a 16-byte random nonce plus the gate id and expiry — not feasible to forge or guess. |
| Token replay (the link is used twice, or forwarded after use) | Single use comes from the **gate's own state machine**, not from a nonce lookup: `decideGate`'s conditional update is `WHERE status = 'pending'`, so a second use of the same token finds the gate already decided and returns the recorded decision rather than re-deciding. The nonce exists to make the token unguessable, not to be checked against a store — there is deliberately no nonce table to keep the whole path a single statement. |
| Timing attack on MAC comparison | `timingSafeEqualHex` — constant-time comparison, not `===`. |
| Expired token reuse | Expiry (`exp`) is checked; `E_BAD_TOKEN` on any failure — the error deliberately does not distinguish "expired" from "forged" from "malformed", so an attacker learns nothing from the response shape. |
| Token leakage via `approvalSecret` compromise | `approvalSecret` is your process's own secret (`createSluice({ approvalSecret })`) — sluice never stores it, logs it, or transmits it. Rotate it like any other application secret; existing outstanding tokens signed with the old secret stop verifying immediately. |
| Gate hijack via `resumeContext` | `resumeContext` is opaque `Json` you supply and read back yourself (≤ 32 KiB). sluice does not execute, interpret, or trust its contents — treat it exactly like you'd treat data you round-tripped through any other datastore. |

`mintToken`/token-based `decide()` are entirely **optional** — nothing about
core gate functionality (open/get/waitFor/decide/cancel/claimDecided)
requires `approvalSecret`. Skip the token path if your approvers already
authenticate through your own system and call `gates.decide()` directly with
`decidedBy` set to your own verified identity.

## Structured errors, never a stack

Every error sluice throws is a `SluiceError { code, retryable, indeterminate,
context }`. `context` carries structured facts (namespace, key, gate id) —
never a stack trace, never a raw driver error message, never a query string.
This is deliberate: sluice errors are safe to log, return to a caller, or
surface in an agent's tool-call response without a redaction pass.

## The hosted demo

`apps/web` (the docs + playground site) has **no server-side write path at
all** — zero API routes, zero database (see [SPEC §9](docs/SPEC.md#9-demo-site-appsweb)
and the [homepage](https://sluice-iota.vercel.app)'s "why this site has no
backend" section). The playground and gate walkthrough run the real core
entirely client-side against an in-memory store; nothing a visitor does ever
reaches a server sluice controls. The quality bar "no unauthenticated write
path, ever" is met structurally, not by an access-control check that could
have a bug.

Metered exposure is therefore limited to edge requests (page loads), not API
calls or database writes. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for
the WAF rule and abuse-case numbers.

## Migrations

`packages/sluice-store-postgres/migrations/` is forward-only and
additive-only by repo policy: no column drops, no type narrowing, no
destructive backfills, ever committed. A migration that needs to remove or
narrow something ships as a *new* additive migration plus an application-level
read-path change, never an edit to a migration that already shipped.

## Dependencies

`@jamessuuu/sluice` (the core) has **zero runtime dependencies** — this is
both a credibility feature and a security one: there is no transitive
supply-chain surface in the package your production side effects run
through. `@jamessuuu/sluice-store-postgres` depends on `drizzle-orm` only
(you bring your own Postgres driver). `@jamessuuu/sluice-testkit` depends on
`@jamessuuu/sluice` only.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/jamessuuu/sluice/security/advisories/new)
on the repo, or email the address on the maintainer's GitHub profile
(github.com/jamessuuu) if the advisory form isn't suitable. Please include a
minimal reproduction. This is a solo-maintained open-source project — there
is no SLA, but reports are read.

## Brand assets

Everything under `apps/web/public/brand/` is © James Lorenz Santos, all
rights reserved, and is **not** covered by the MIT code license (see
[LICENSE](LICENSE)). Do not reuse it to identify a different project.
