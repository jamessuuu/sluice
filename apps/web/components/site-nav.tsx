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
        <Link href="/" className="flex items-center gap-2 text-ink">
          <ProjectGlyph size={22} decorative />
          <span className="t-label">sluice</span>
        </Link>
        <nav className="flex items-center gap-5">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="t-label text-ink-2 hover:text-ink">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
