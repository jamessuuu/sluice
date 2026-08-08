# Operations

Runbook for `apps/web` — the docs + playground site deployed to Vercel
(project `sluice`, target `sluice.vercel.app`, fallback `sluice-dev.vercel.app`
if the primary name is unavailable at deploy time — see SPEC §12.3). This
document is the "cost ceiling N/A with the reason stated" and "WAF rule
configured + documented" acceptance-criteria items (SPEC §11).

## Cost safety (SPEC §9 D2)

sluice has **no path to a model API call anywhere in the codebase** — core,
testkit, and the demo site. There is no LLM SDK dependency to invoke, no
prompt to send, nothing that could burn a metered token budget. The standing
"no cost ceiling, no ship" gate (PROGRAM.md D2) is therefore **N/A by
construction**, not by a runtime check — grep the dependency tree for an
LLM SDK and find nothing, rather than trust a guard that could have a bug.

The only metered exposure left is **edge requests** — page loads against the
Vercel Hobby plan's 1,000,000/month included allowance.

### Expected load

~2,000 views/month (a portfolio-tier project, not a product with paid
acquisition) ≈ **0.6%** of the Hobby budget. Every route is fully static or a
client component with no server dependency (SPEC §9: zero API routes, zero
database, zero writes) — a page view costs one static asset fetch, not a
function invocation.

### Abuse case

One IP hammering the site as fast as it can, bound only by the single WAF
rate-limit rule below:

- **Rule:** 30 requests / 10 seconds per IP, bound to `/*` (Vercel Firewall →
  Rate Limiting, action: **Block**, algorithm: fixed window).
- **Worst case from one IP:** 30 req/10s × 8,640 ten-second windows/day ≈
  **259,200 edge requests/day** if the rule is somehow bypassed for a full
  day (it isn't — Vercel's edge network + Attack Mode sit in front of this
  rule and would engage well before that). Even the unmitigated worst case
  is ~26% of the *monthly* Hobby budget from a single IP in a single day —
  survivable, not free, which is exactly why the rule exists.
- **Real defence:** Vercel's platform-level DDoS mitigation and Attack Mode,
  not this repo's code. The WAF rule above is the one configuration this
  project is responsible for setting.

### Blackout-safe by design (SPEC §9 D3)

A Hobby overage is a **30-day feature pause**, not a bill — and there are no
features to pause here. The landing page renders fully static (name,
tagline, install snippet, the chaos table baked in at build time) and
renders identically with JavaScript disabled. If Vercel paused every
function on this project tomorrow, `/` would be unaffected because it has no
function to pause; `/playground`, `/gate`, and `/audit` would still load
(they're client components) and would still work (they call no server).
Nothing on this site's core value proposition depends on a running backend,
because there is no backend.

## Configuring the WAF rule

1. Vercel dashboard → project `sluice` → **Firewall** → **Rate Limiting**.
2. New rule: path `/*`, limit **30 requests per 10 seconds**, key by IP
   address, action **Block**.
3. Save and confirm it shows **Active** against the production deployment.

This is a manual dashboard step, not something committed as code — Vercel's
firewall configuration isn't currently expressed in this repo's `vercel.json`
in a way that would make it reproducible from source, so it's documented
here instead and must be re-verified after any project transfer or Vercel
account change.

## Deploying

Not part of this build task — deploys are James's call (PROGRAM.md #7: "James
decides the irreversible"). When it happens: `vercel --prod` from a clean
`main`, or the Vercel Git integration on push to `main` if that's ever wired
up. Either way, run the acceptance checklist (SPEC §11) against the live URL
before calling a deploy done, including the "renders with JS disabled" check
for `/` and the gate walkthrough's real-page-reload survival.

## Monitoring

No first-party observability is wired up (no telemetry, ever — SPEC §1
non-goal #5, which applies to sluice-the-library and extends in spirit to
this demo site: it doesn't phone home either). Use Vercel's own dashboard
(request counts, function invocations — expected to read ~0 given zero API
routes) as the only signal. If `chaos/results/latest.json` ever goes stale
relative to `main`, `scripts/chaos-report.mjs --check` in CI catches it
before it reaches the site.
