import Image from "next/image";
import Link from "next/link";

const LINKS = [
  { href: "/docs/quickstart", label: "docs" },
  { href: "/playground", label: "playground" },
  { href: "/gate", label: "gate" },
  { href: "/audit", label: "audit" },
];

export function SiteNav() {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/brand/glyph.svg" alt="" width={22} height={22} aria-hidden />
          <span className="font-mono text-sm font-semibold tracking-tight text-ink">sluice</span>
        </Link>
        <nav className="flex items-center gap-5 text-sm text-ink/70">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="hover:text-ink">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
