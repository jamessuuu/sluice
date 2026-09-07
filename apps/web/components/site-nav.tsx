import Link from "next/link";

import { ProjectGlyph } from "./project-glyph";

const LINKS = [
  { href: "/docs/quickstart", label: "docs" },
  { href: "/playground", label: "playground" },
  { href: "/gate", label: "gate" },
  { href: "/audit", label: "audit" },
];

export function SiteNav() {
  return (
    <header className="border-b border-edge-lo bg-sub-1">
      {/* Same 1240px measure and gutters as every band (.band-inner), so the nav's
          left edge lines up with the wordmark and the instrument frame below it
          instead of sitting on its own narrower rail. */}
      <div className="band-inner flex items-center justify-between gap-6 py-4">
        {/* min-h-6 on every nav target: `t-label` sets a 1.3 line-height on
            13px type, which drew a 15.6px-tall box. SC 2.5.8's inline-text
            exemption does not reach a standalone nav link, so the box has to
            carry the 24px itself. The row is already `items-center`, so the
            extra height lands symmetrically and nothing moves. */}
        <Link href="/" className="flex min-h-6 items-center gap-2 text-ink">
          <ProjectGlyph size={22} decorative />
          <span className="t-label">sluice</span>
        </Link>
        <nav className="flex items-center gap-5">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="t-label inline-flex min-h-6 items-center text-ink-2 hover:text-ink">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
