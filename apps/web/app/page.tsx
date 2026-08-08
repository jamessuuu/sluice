import Image from "next/image";
import Link from "next/link";
import { ChaosTable } from "@/components/chaos-table";

// SPEC §9: "/" is FULLY STATIC — no client component, no fetch, no state.
// It renders with JavaScript disabled and during any platform pause (D3):
// there is nothing here that can be paused, because nothing here runs.

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

      <p className="mb-8 max-w-2xl text-lg leading-8 text-ink/90">
        Exactly-once side effects for agent tool calls, plus human approval gates that survive a
        process crash. Proven by a chaos harness that runs without a model API key.
      </p>

      <pre className="mb-10 overflow-x-auto border border-rule bg-ink px-4 py-3 font-mono text-sm text-paper">
        <code>pnpm add @jamessuuu/sluice</code>
      </pre>

      <div className="mb-10 grid gap-4 sm:grid-cols-3">
        <Feature
          title="Idempotent execution"
          body="Duplicate deliveries collapse to one side effect; the result replays to every caller."
        />
        <Feature
          title="Honest failure states"
          body={
            <>
              <code className="font-mono text-[0.9em]">failed</code> (provably did not happen) is
              never conflated with <code className="font-mono text-[0.9em]">indeterminate</code>{" "}
              (we do not know). Fails closed by default.
            </>
          }
        />
        <Feature
          title="Durable approval gates"
          body="A pending approval survives process death and resumes exactly once, from any process."
        />
      </div>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Chaos harness — generated, not written
        </h2>
        <ChaosTable />
      </section>

      <section className="mb-10 border border-rule px-5 py-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink/50">
          Why this site has no backend
        </h2>
        <p className="text-sm leading-6 text-ink/80">
          Zero API routes, zero database, zero writes. The playground and gate walkthrough run
          the real{" "}
          <code className="font-mono text-[0.9em]">@jamessuuu/sluice</code> core, entirely
          client-side, against an in-memory store — nothing here ever talks to a server. That
          gets three things for free: no unauthenticated write path exists to defend, because
          there is no write path; the site is blackout-safe under a Vercel Hobby function pause,
          because there are no functions to pause; and it sidesteps a cold-start database (Neon)
          that would have wrecked the &lt;30s gate walkthrough. See{" "}
          <Link href="/docs/limitations" className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber">
            limitations
          </Link>{" "}
          for what that trades away.
        </p>
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

function Feature({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="border border-rule px-4 py-3">
      <h3 className="mb-1 text-sm font-semibold text-ink">{title}</h3>
      <p className="text-sm leading-6 text-ink/70">{body}</p>
    </div>
  );
}
