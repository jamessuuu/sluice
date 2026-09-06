import Link from "next/link";
import { ChaosTable } from "@/components/chaos-table";
import { DiagramFigure } from "@/components/diagram-figure";
import { FailureModesTable } from "@/components/failure-modes-table";
import { GateDemo } from "@/components/gate-demo";
import { BASELINE, Instrument, fmt, pct } from "@/components/instrument";
import { ProjectGlyph } from "@/components/project-glyph";
import { Readout } from "@/components/readout";
import { Icon } from "@/components/substrate-sprite";
import identity from "../../../identity.json" with { type: "json" };

// SPEC §9: "/" is FULLY STATIC — no client component, no fetch, no state. It renders
// with JavaScript disabled and during any platform pause (D3): there is nothing here
// that can be paused, because nothing here runs.
//
// PORTFOLIO-DESIGN-DNA.md §4.2 sets the page shape, and it is not negotiable per
// project: READOUT, INSTRUMENT, MECHANISM, EVIDENCE, LIMITS, INSTALL + COLOPHON, in
// that order, six bands, alternating --sub-0/--sub-1 with an --edge-lo hairline
// between them. Band 5 carries the same visual weight as band 4 on purpose — giving
// limitations the same weight as evidence is native to this portfolio's argument and
// is not a footnote.
//
// What this replaced: a max-w-3xl column of h2 + paragraph + component, repeated six
// times, in the browser's default sans-serif. The 666 -> 0 comparison was a stat card
// in the middle of it. It is now the first screen, drawn from the artifact.

const LIMITS = [
  {
    title: "TTL is a memory horizon, not a correctness knob",
    body: "retentionMs (default 7 days) controls how long a terminal effect record stays around for replay and dedup — not a promise about correctness. Set it shorter than your real redelivery window and the same key executes again from scratch. This is the one way sluice can be made to shoot you in the foot.",
  },
  {
    title: "Roughly hundreds of events per second, per namespace",
    body: "sluice_event appends are serialized per namespace by a cursor row lock — the mechanism that makes the hash chain tamper-evident in a single SQL statement. Fine for approval and audit volume; not a general-purpose event bus. Above that, use more namespaces, not a bigger one.",
  },
  {
    title: "Breaker state is eventually consistent across instances",
    body: "Circuit state is read-through cached one second in process, so two instances can disagree about whether a circuit is open for up to that long. Half-open's single-probe admission is still correctly serialized under the cache; the window only affects how fast an instance notices.",
  },
  {
    title: "The figures above are virtual-clock time, not wall clock",
    body: "The harness advances simulated time to the next due timer, which is what makes a suite spanning hours of gate timeouts finish in milliseconds and run in CI on every push. Those p50/p99 numbers describe scheduling behaviour, not network or database latency. Production p99 adds real I/O on top.",
  },
];

export default function LandingPage() {
  return (
    <>
      {/* ── 1. READOUT ─────────────────────────────────────────────────────────── */}
      <section className="band border-t-0" data-tone="1" data-hero="" aria-labelledby="wordmark">
        <div className="band-inner grid grid-cols-1 gap-x-6 gap-y-10 xl:grid-cols-12 xl:items-end">
          <div className="min-w-0 xl:col-span-5">
            <ProjectGlyph size={44} className="text-ink" />
            <h1 id="wordmark" className="t-h1 mt-4 text-ink">
              sluice
            </h1>
            <p className="t-label mt-3 text-ink-3">
              Exactly-once side effects for agent tool calls
            </p>
            <p className="t-lead mt-6 text-ink-2">{identity.voice}</p>
          </div>
          <div className="min-w-0 xl:col-span-7">
            <Readout />
          </div>
        </div>
      </section>

      {/* ── 2. INSTRUMENT ──────────────────────────────────────────────────────── */}
      <section className="band" data-hero="" aria-labelledby="instrument-label">
        <div className="band-inner">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h2 id="instrument-label" className="t-label text-ink">
              The delivery state machine
            </h2>
            <p className="t-micro text-ink-3">
              {fmt(BASELINE.intents)} intents &middot; {fmt(BASELINE.deliveries)} deliveries
              &middot; {pct(BASELINE.injectedFailureRate)} injected fault &middot; one schedule
            </p>
          </div>
          {/* G10: the instrument declares the repo-relative file it was generated
              from, and every rendered value is recomputable by `pnpm chaos`. */}
          <figure
            className="raised chamfer-tr mt-5 border border-edge-lo px-4 py-6 sm:px-8 sm:py-8"
            data-source="chaos/results/latest.json"
          >
            <Instrument />
          </figure>
          <p className="t-body-s mt-5 max-w-[68ch] text-ink-2">
            Same fault schedule, two branches. The naive loop retries every failure up to
            three times, including timeouts — which is exactly how an unknown outcome becomes a
            second charge. sluice commits {pct(BASELINE.sluiceSuccessRate)} of intents exactly
            once and parks {pct(BASELINE.sluiceFailClosedRate)} as{" "}
            <code>indeterminate</code> rather than re-firing them, and it reaches that with{" "}
            {fmt(BASELINE.sluiceAttempts)} downstream attempts against{" "}
            {fmt(BASELINE.naiveAttempts)}.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/playground" className="btn">
              Try the playground
              <Icon name="arrow-right" size={18} />
            </Link>
            <Link href="/gate" className="btn btn-quiet">
              Walk through a gate (&lt;30s)
              <Icon name="arrow-right" size={18} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── 3. MECHANISM ───────────────────────────────────────────────────────── */}
      <section className="band" data-tone="1" aria-labelledby="mechanism-label">
        <div className="band-inner">
          <h2 id="mechanism-label" className="t-label text-ink">
            Mechanism &middot; honest failure states
          </h2>
          <div className="mt-6 grid grid-cols-1 gap-8 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-5">
              <p className="t-body text-ink-2">
                <code>failed</code> means the effect provably did not happen.{" "}
                <code>indeterminate</code> means sluice does not know — a timeout after the call
                landed, or a crash before the result was persisted. Conflating the two is the bug
                this library exists to prevent.
              </p>
              <p className="t-body mt-4 text-ink-2">
                The one edge that matters is the one drawn in the signal hue below: reaching{" "}
                <code>indeterminate</code> never auto-retries. Leaving it takes an explicit
                reclaim or a human decision through a gate.
              </p>
              <p className="t-body-s mt-5">
                <Link href="/docs/concepts" className="link-signal">
                  Read the full argument
                </Link>
              </p>
            </div>
            <div className="min-w-0 xl:col-span-7">
              <DiagramFigure />
            </div>
          </div>
        </div>
      </section>

      {/* ── 4. EVIDENCE ────────────────────────────────────────────────────────── */}
      <section className="band" aria-labelledby="evidence-label">
        <div className="band-inner">
          <h2 id="evidence-label" className="t-label text-ink">
            Evidence &middot; every number, and the command that regenerates it
          </h2>

          <div className="mt-6">
            <ChaosTable />
          </div>

          <h3 className="t-h3 mt-14 text-ink">The gate, recorded</h3>
          <p className="t-body-s mt-2 max-w-[68ch] text-ink-2">
            A pending approval survives process death and resumes exactly once, from any process.
            Recorded against the deployed site, not a local dev server.
          </p>
          <div className="mt-5 grid grid-cols-1 gap-8 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-7">
              <GateDemo />
            </div>
            <div className="min-w-0 xl:col-span-5">
              <h3 className="t-h3 text-ink">Verify it yourself</h3>
              <p className="t-body-s mt-2 text-ink-2">
                One command regenerates every figure on this page, including the readout at the
                top. CI runs it on every push and fails on drift.
              </p>
              <pre className="plate-code mt-4">
                <code>pnpm chaos</code>
              </pre>
              <p className="t-micro mt-3 text-ink-3">
                writes chaos/results/latest.json and chaos/RESULTS.md
              </p>
            </div>
          </div>

          <h3 className="t-h3 mt-14 text-ink">Failure modes F1 through F12</h3>
          <p className="t-body-s mt-2 max-w-[68ch] text-ink-2">
            Every row is asserted by a chaos scenario and a golden fixture, not just documented.
            Full prose for each:{" "}
            <Link href="/docs/failure-modes" className="link-signal">
              /docs/failure-modes
            </Link>
            .
          </p>
          <div className="mt-5">
            <FailureModesTable />
          </div>
        </div>
      </section>

      {/* ── 5. LIMITS ──────────────────────────────────────────────────────────────
          DNA §4.2: designed at the same weight as EVIDENCE. Same band padding, same
          card grammar, same type scale — not a collapsed footnote. */}
      <section className="band" data-tone="1" aria-labelledby="limits-label">
        <div className="band-inner">
          <h2 id="limits-label" className="t-label text-ink">
            Limits &middot; what this cannot do
          </h2>
          <p className="t-lead mt-4 text-ink-2">
            A reliability library that hides its own edges is not one you should trust with a
            charge card.
          </p>
          <ul className="mt-8 grid list-none gap-px bg-edge-lo sm:grid-cols-2">
            {LIMITS.map((limit) => (
              <li key={limit.title} className="raised flex gap-4 p-6">
                <Icon name="close" size={20} className="mt-1 shrink-0 text-fail" />
                <div>
                  <h3 className="t-h3 text-ink">{limit.title}</h3>
                  <p className="t-body-s mt-3 text-ink-2">{limit.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-8 grid grid-cols-1 gap-8 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-6">
              <h3 className="t-h3 text-ink">And no backend, deliberately</h3>
              <p className="t-body-s mt-3 text-ink-2">
                Zero API routes, zero database, zero writes. The playground and the gate
                walkthrough run the real <code>@jamessuuu/sluice</code> core entirely client-side
                against an in-memory store. No unauthenticated write path exists to defend
                because there is no write path; the site is blackout-safe under a function pause
                because there are no functions to pause. What that trades away is in{" "}
                <Link href="/docs/limitations" className="link-signal">
                  the full limitations page
                </Link>
                .
              </p>
            </div>
            <div className="min-w-0 xl:col-span-6">
              <h3 className="t-h3 text-ink">Not on npm</h3>
              <p className="t-body-s mt-3 text-ink-2">
                The three packages are ESM only, Node 22 or newer, and are not published. The
                install below clones the monorepo; there is no <code>npm i</code> path yet, and
                saying otherwise would be the first broken claim on a page about not breaking
                claims.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 6. INSTALL + COLOPHON ──────────────────────────────────────────────── */}
      <section className="band" aria-labelledby="install-label">
        <div className="band-inner">
          <h2 id="install-label" className="t-label text-ink">
            Install &middot; reproduce &middot; colophon
          </h2>
          <div className="mt-6 grid grid-cols-1 gap-8 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-7">
              <pre className="plate-code">
                <code>{`git clone https://github.com/jamessuuu/sluice
cd sluice && pnpm install
pnpm chaos          # regenerates every number on this page
pnpm test:e2e       # the gate walkthrough above, run for real`}</code>
              </pre>
            </div>
            <div className="min-w-0 xl:col-span-5">
              <ul className="t-body-s grid list-none gap-3 text-ink-2">
                <li>
                  <Link className="link-signal" href="/docs/quickstart">
                    Read the docs
                  </Link>
                </li>
                <li>
                  <Link className="link-signal" href="/playground">
                    Try the playground
                  </Link>
                </li>
                <li>
                  <Link className="link-signal" href="/audit">
                    Break the audit chain and watch it get caught
                  </Link>
                </li>
                <li>
                  <a className="link-signal" href="https://github.com/jamessuuu/sluice">
                    Source
                  </a>
                </li>
              </ul>
              <p className="t-micro mt-8 text-ink-3">
                Set in Archivo, Commit Mono and Newsreader. Colour, depth and grid from the
                shared portfolio substrate; signal hue {identity.signal}, lighting{" "}
                {identity.lighting}.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
