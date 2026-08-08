import Link from "next/link";

const NAV: { href: string; label: string }[] = [
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/idempotency-keys", label: "Idempotency keys" },
  { href: "/docs/retries-and-breaker", label: "Retries & breaker" },
  { href: "/docs/gates", label: "Gates" },
  { href: "/docs/stores-and-migrations", label: "Stores & migrations" },
  { href: "/docs/chaos-harness", label: "Chaos harness" },
  { href: "/docs/failure-modes", label: "Failure modes" },
  { href: "/docs/limitations", label: "Limitations" },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-4xl gap-10 px-6 py-12">
      <nav aria-label="Docs" className="sticky top-12 hidden w-44 shrink-0 self-start sm:block">
        <ul className="space-y-1 text-sm">
          {NAV.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="block py-1 text-ink/70 hover:text-ink">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="min-w-0 flex-1">{children}</article>
    </div>
  );
}
