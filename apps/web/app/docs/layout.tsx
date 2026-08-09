import Link from "next/link";

const NAV: { href: string; label: string }[] = [
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/concepts", label: "Concepts" },
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
    <div className="mx-auto max-w-4xl px-6 py-12 sm:flex sm:gap-10">
      {/*
       * Readable and reachable at 320px (DESIGN-DIRECTION.md): below `sm`
       * this renders as a horizontally-scrollable strip instead of
       * disappearing outright — a docs page with no way to reach the other
       * eight is not "readable", it's a dead end below one breakpoint.
       */}
      <nav aria-label="Docs" className="sticky top-12 mb-8 -mx-6 overflow-x-auto px-6 sm:mx-0 sm:mb-0 sm:w-44 sm:shrink-0 sm:self-start sm:overflow-visible sm:px-0">
        <ul className="flex gap-x-4 whitespace-nowrap text-sm sm:block sm:space-y-1 sm:whitespace-normal">
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
