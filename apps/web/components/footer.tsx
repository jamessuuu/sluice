import Image from "next/image";
import Link from "next/link";

/**
 * BRAND-KIT.md requirement #3 + D1: chip mark + attribution + backlink +
 * repo link on EVERY page, NO hire-me CTA. This component is rendered once,
 * from the root layout, so "every page" is structural rather than a
 * checklist someone can forget on a new route.
 */
export function Footer() {
  return (
    <footer className="mt-24 border-t border-rule">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-10 text-sm text-ink/70 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Image src="/brand/mark.svg" alt="" width={20} height={20} aria-hidden />
          <span>
            Built by{" "}
            <a
              className="text-ink underline decoration-rule underline-offset-2 hover:decoration-amber"
              href="https://agentjames.vercel.app"
            >
              James Lorenz Santos
            </a>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a
            className="hover:text-ink"
            href="https://github.com/jamessuuu/sluice"
          >
            github.com/jamessuuu/sluice
          </a>
          <Link className="hover:text-ink" href="/docs/limitations">
            limitations
          </Link>
        </div>
      </div>
    </footer>
  );
}
