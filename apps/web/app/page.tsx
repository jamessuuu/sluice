import Image from "next/image";
import Link from "next/link";
import { ChaosTable } from "@/components/chaos-table";
import { DiagramFigure } from "@/components/diagram-figure";
import { EvidenceHero } from "@/components/evidence-hero";
import { FailureModesTable } from "@/components/failure-modes-table";
import { GateDemo } from "@/components/gate-demo";

// SPEC §9: "/" is FULLY STATIC — no client component, no fetch, no state.
// It renders with JavaScript disabled and during any platform pause (D3):
// there is nothing here that can be paused, because nothing here runs.
//
// DESIGN-DIRECTION.md's governing idea: every claim sits next to its proof.
// Page order below is deliberate — claim, then the evidence for that exact
// claim, immediately: the 666->0 number and its full chaos table; the
// mechanism diagram, which IS the honest-failure-states argument; the demo
// recording, which IS the durable-gate argument; the failure-mode table;
// then install and the exact command to reproduce all of it yourself. A
// three-card feature grid used to sit above all of this restating the same
// three claims with no adjacent proof — removed, because a claim without a
// receipt next to it is exactly the noise this project exists to cut.

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-8 flex items-center gap-4">
        <Image src="/brand/glyph.svg" alt="sluice" width={48} height={48} priority />
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-ink">sluice</h1>
          <p className="text-sm text-ink/60">by James Lorenz Santos — Agent James portfolio</p>
        </div>
      </div>

      <p className="mb-6 max-w-2xl text-lg leading-8 text-ink/90">
        Exactly-once side effects for agent tool calls, plus human approval gates that survive a
        process crash. Proven by a chaos harness that runs without a model API key.
      </p>

      <pre className="mb-12 overflow-x-auto border border-rule bg-ink px-4 py-3 font-mono text-sm text-paper">
        <code>pnpm add @jamessuuu/sluice</code>
      </pre>

      <section className="mb-16">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Idempotent execution — duplicate deliveries collapse to one side effect
        </h2>
        <p className="mb-4 text-sm leading-6 text-ink/70">
          200 intents, delivered 2–5× each under 30% injected failure — a naive retry loop and
          sluice, given the identical fault schedule.
        </p>
        <div className="mb-4">
          <EvidenceHero />
        </div>
        {/* The site's only in-browser proof of the "sluice" number above had no
            button pointing at it — the sole actionable element on the page was
            a copy-paste install command (ui-audit.md 2026-08-28). House button:
            0-2px radius (the global reset already zeroes radius), ~42px tall,
            amber solid fill — same pattern as the gate page's Approve button. */}
        <div className="mb-6">
          <Link
            href="/playground"
            className="inline-flex items-center border border-amber bg-amber px-5 py-2.5 text-sm font-semibold text-paper hover:bg-amber/90"
          >
            Try the playground
          </Link>
        </div>
        <ChaosTable />
      </section>

      <section className="mb-16">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Honest failure states — the mechanism
        </h2>
        <p className="mb-4 text-sm leading-6 text-ink/70">
          <code className="font-mono text-[0.9em]">failed</code> means the effect provably did not
          happen. <code className="font-mono text-[0.9em]">indeterminate</code> means sluice does
          not know — a timeout after the call landed, or a crash before the result was persisted.
          Conflating the two is the bug this library exists to prevent. The amber edge below is
          the one that matters: reaching <code className="font-mono text-[0.9em]">indeterminate</code>{" "}
          never auto-retries. Leaving it takes an explicit reclaim or a human decision through a
          gate — see{" "}
          <Link
            href="/docs/concepts"
            className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
          >
            the concept page
          </Link>{" "}
          for the full argument.
        </p>
        <DiagramFigure />
      </section>

      <section className="mb-16" id="durable-approval-gates">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Durable approval gates — the gate, live
        </h2>
        <p className="mb-4 text-sm leading-6 text-ink/70">
          A pending approval survives process death and resumes exactly once, from any process.
          Recorded against this exact deployed site, not a local dev server — see{" "}
          <a
            className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
            href="https://github.com/jamessuuu/sluice/blob/main/scripts/record-demo.mjs"
          >
            scripts/record-demo.mjs
          </a>
          .
        </p>
        <GateDemo />
      </section>

      <section className="mb-16">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Failure modes — F1 through F12
        </h2>
        <p className="mb-4 text-sm leading-6 text-ink/70">
          Every row is asserted by a chaos scenario and a golden fixture, not just documented. Full
          prose for each: <Link
            href="/docs/failure-modes"
            className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
          >
            /docs/failure-modes
          </Link>
          .
        </p>
        <FailureModesTable />
      </section>

      <section className="mb-16 border border-rule px-5 py-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Why this site has no backend
        </h2>
        <p className="text-sm leading-6 text-ink/80">
          Zero API routes, zero database, zero writes. The playground and gate walkthrough run the
          real <code className="font-mono text-[0.9em]">@jamessuuu/sluice</code> core, entirely
          client-side, against an in-memory store — nothing here ever talks to a server. That gets
          three things for free: no unauthenticated write path exists to defend, because there is
          no write path; the site is blackout-safe under a Vercel Hobby function pause, because
          there are no functions to pause; and it sidesteps a cold-start database (Neon) that would
          have wrecked the &lt;30s gate walkthrough. See{" "}
          <Link href="/docs/limitations" className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber">
            limitations
          </Link>{" "}
          for what that trades away.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Install &amp; reproduce
        </h2>
        <pre className="overflow-x-auto border border-rule bg-ink px-4 py-3 font-mono text-sm text-paper">
          <code>{`git clone https://github.com/jamessuuu/sluice
cd sluice && pnpm install
pnpm chaos        # regenerates the numbers on this page
pnpm test:e2e      # the gate walkthrough above, run for real`}</code>
        </pre>
      </section>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber" href="/docs/quickstart">
          Read the docs →
        </Link>
        <Link className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber" href="/playground">
          Try the playground →
        </Link>
        <Link className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber" href="/gate">
          Walk through a gate (&lt;30s) →
        </Link>
        <a
          className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
          href="https://github.com/jamessuuu/sluice"
        >
          Source →
        </a>
      </div>
    </div>
  );
}
