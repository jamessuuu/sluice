/**
 * The gate walkthrough recording — DESIGN-DIRECTION.md item 3. Recorded by
 * scripts/record-demo.mjs against the real deployed site (see its header
 * comment for why: a localhost recording can drift from what a visitor
 * actually gets).
 *
 * Reduced motion is handled with CSS alone (`motion-reduce:`/`motion-safe:`
 * Tailwind variants over `prefers-reduced-motion`), not a client component —
 * SPEC §9 requires "/" to stay fully static (no client component, no fetch,
 * no state), and a media query does the swap without any JavaScript at all,
 * so it still works with JS disabled.
 */
export function GateDemo() {
  return (
    <div>
      <video
        className="block w-full border border-rule motion-reduce:hidden"
        autoPlay
        muted
        loop
        playsInline
        tabIndex={-1}
        aria-hidden="true"
        poster="/demo/sluice-poster.png"
        data-testid="gate-demo-video"
      >
        <source src="/demo/sluice-demo.webm" type="video/webm" />
      </video>
      <div className="hidden border border-rule motion-reduce:block" data-testid="gate-demo-reduced-motion">
        {/* A static <img> to the poster PNG, not an optimized remote asset — matches how the video's own poster attribute references the same file. */}
        <img src="/demo/sluice-poster.png" alt="" className="block w-full" />
        <p className="px-5 py-3 text-sm text-ink/70">
          Your browser is set to reduce motion, so the recording is not playing automatically.{" "}
          <a
            className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
            href="/demo/sluice-demo.webm"
          >
            Watch the recording
          </a>
          .
        </p>
      </div>
      <p className="mt-3 text-sm leading-6 text-ink/70">
        What it shows: a worker opens a real approval gate for &quot;publish the weekly digest,&quot;
        then gets killed two seconds later. The pending approval survives a real reload of the
        page — a fresh navigation, not React state — because it was never held in memory.
        Approving it resumes the publish through <code className="font-mono text-[0.9em]">run()</code>,
        which fires the side effect once; the audit trail records every step. Try it yourself at{" "}
        <a
          className="text-amber underline decoration-amber/40 underline-offset-2 hover:decoration-amber"
          href="/gate"
        >
          /gate
        </a>
        .
      </p>
    </div>
  );
}
