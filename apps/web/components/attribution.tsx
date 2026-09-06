/**
 * attribution-kit v1 — React. Vendored from ~/.claude/harness-dist/attribution/Attribution.tsx; re-copy, do not
 * hand-edit. Server-component safe (no hooks, no client state), so Next.js renders it into the HTML the crawler sees.
 *
 * Needs the six rules in attribution.css in the project's stylesheet. The mark draws in `currentColor` and takes
 * its amber from `--aj-attribution-signal` (#B45309 on light ground, #F59E0B on dark). The block is inline text on
 * purpose: the links stay display:inline (the WCAG 2.5.8 inline-text exemption), so do not turn it into a flex row.
 */

export const ATTRIBUTION = {
  name: "James Lorenz Santos",
  portfolio: "https://agentjames.vercel.app",
  linkedin: "https://www.linkedin.com/in/james-lorenz-santos-720776251/",
} as const;

/** The Agent James chip mark. Two drawings of one identity: below 40px the mark-16 drawing, at 40px and up the full one. */
export function AgentJamesMark({ size = 20, className }: { size?: number; className?: string }) {
  const cls = ["aj-attribution__mark", size >= 40 ? "aj-attribution__mark--full" : "", className ?? ""].filter(Boolean).join(" ");
  const signal = "var(--aj-attribution-signal, #B45309)";
  if (size < 40) {
    return (
      <svg className={cls} viewBox="0 0 32 32" width={size} height={size} role="img" aria-label="Agent James">
        <path fill="currentColor" d="M1 10h3v4H1zM28 10h3v4h-3zM10 1h4v3h-4zM10 28h4v3h-4zM1 18h3v4H1zM28 18h3v4h-3zM18 1h4v3h-4zM18 28h4v3h-4z" />
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M5 4h22a1 1 0 0 1 1 1v22a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM18.3 9h3.4v8a5.7 5.7 0 0 1-5.7 5.7H12v-3.4h4a2.3 2.3 0 0 0 2.3-2.3z"
        />
        <rect x="6.5" y="6.5" width="3.5" height="3.5" fill={signal} />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="Agent James">
      <path
        fill="currentColor"
        d="M5.76 19.74h8v3.008h-8zM50.24 19.74h8v3.008h-8zM19.74 5.76h3.008v8H19.74zM19.74 50.24h3.008v8H19.74zM5.76 26.91h8v3.008h-8zM50.24 26.91h8v3.008h-8zM26.91 5.76h3.008v8H26.91zM26.91 50.24h3.008v8H26.91zM5.76 34.08h8v3.008h-8zM50.24 34.08h8v3.008h-8zM34.08 5.76h3.008v8H34.08zM34.08 50.24h3.008v8H34.08zM5.76 41.25h8v3.008h-8zM50.24 41.25h8v3.008h-8zM41.25 5.76h3.008v8H41.25zM41.25 50.24h3.008v8H41.25z"
      />
      <rect x="14.08" y="14.08" width="35.84" height="35.84" fill="none" stroke="currentColor" strokeWidth="3.008" />
      <path d="M37.73 20.89 V35.58 a7.88 7.88 0 0 1 -7.88 7.88 H26.27" fill="none" stroke="currentColor" strokeWidth="3.968" strokeLinecap="butt" />
      <rect x="17.31" y="17.31" width="4.66" height="4.66" fill={signal} />
    </svg>
  );
}

export function Attribution({
  size = 20,
  className,
  linkClassName,
}: {
  size?: number;
  className?: string;
  /** extra classes for both links (a Tailwind project's underline/hover utilities, for example) */
  linkClassName?: string;
}) {
  const rootCls = ["aj-attribution", className ?? ""].filter(Boolean).join(" ");
  return (
    <p className={rootCls}>
      <AgentJamesMark size={size} />
      Built by{" "}
      <a href={ATTRIBUTION.portfolio} rel="me noopener" className={linkClassName}>
        {ATTRIBUTION.name}
      </a>
      <span className="aj-attribution__sep" aria-hidden="true">
        &middot;
      </span>
      <a href={ATTRIBUTION.linkedin} rel="me noopener" target="_blank" className={linkClassName}>
        LinkedIn
      </a>
    </p>
  );
}
