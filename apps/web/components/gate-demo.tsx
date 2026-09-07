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
        className="raised block w-full border border-edge-lo motion-reduce:hidden"
        autoPlay
        muted
        loop
        playsInline
        tabIndex={-1}
        aria-hidden="true"
        poster="/demo/sluice-poster.png"
        data-testid="gate-demo-video"
      >
        {/*
          H.264/mp4 listed FIRST, on purpose: Safari/WebKit's video-resource-
          selection step never resolves for this recording's VP8/webm encode
          (confirmed: it neither plays nor errors — it hangs indefinitely),
          which keeps document.readyState stuck at "interactive" and
          window.load never fires, even though the rest of the page is fully
          rendered. Browsers pick the first <source> whose type they can
          play, so listing mp4 first makes WebKit resolve immediately while
          Chromium (which plays either format) is unaffected. See
          e2e/webkit-video-load.test.mjs for the regression pin.
        */}
        <source src="/demo/sluice-demo.mp4" type="video/mp4" />
        <source src="/demo/sluice-demo.webm" type="video/webm" />
      </video>
      <div className="hidden border border-edge-lo motion-reduce:block" data-testid="gate-demo-reduced-motion">
        {/* A static image element pointing at the poster PNG, not an optimized remote asset — matches how the video's own poster attribute references the same file.
            This is the ONLY thing a reduced-motion visitor sees of the demo, so
            it carries real alt text: alt="" would have hidden the entire
            demonstration from a screen reader (WCAG 1.1.1, Level A). The file
            itself used to be a screenshot of this very landing page, which
            showed none of what the caption below promises; it is now a real
            frame of the recording at the moment the gate resolves. */}
        <img
          src="/demo/sluice-poster.png"
          width={1120}
          height={700}
          alt="The gate walkthrough at the end of the recording: the worker is marked crashed (killed by the browser) with the note that the gate is still here, the &quot;Publish the weekly digest?&quot; gate reads status approved and published — side effect fired 1 time, and the audit trail below lists gate.opened, gate.decided, gate.claimed, effect.claimed, effect.succeeded and gate.resumed."
          className="block w-full"
        />
        <p className="t-body-s px-5 py-3 text-ink-2">
          Your browser is set to reduce motion, so the recording is not playing automatically.{" "}
          <a
            className="link-signal"
            href="/demo/sluice-demo.webm"
          >
            Watch the recording
          </a>
          .
        </p>
      </div>
      <p className="t-body-s mt-4 max-w-[68ch] text-ink-2">
        What it shows: a worker opens a real approval gate for &quot;publish the weekly digest,&quot;
        then gets killed two seconds later. The pending approval survives a real reload of the
        page — a fresh navigation, not React state — because it was never held in memory.
        Approving it resumes the publish through <code className="font-mono text-[0.9em]">run()</code>,
        which fires the side effect once; the audit trail records every step. Try it yourself at{" "}
        <a
          className="link-signal"
          href="/gate"
        >
          /gate
        </a>
        .
      </p>
    </div>
  );
}
