import Link from "next/link";

import { Attribution } from "./attribution";

/**
 * BRAND-KIT.md requirement #3 + D1: chip mark + attribution + backlink +
 * repo link on EVERY page, NO hire-me CTA. This component is rendered once,
 * from the root layout, so "every page" is structural rather than a
 * checklist someone can forget on a new route.
 *
 * The maker line is the shared attribution kit (attribution-kit v1): the chip mark
 * inline in currentColor, the portfolio and LinkedIn links with rel="me".
 */
export function Footer() {
  return (
    <footer className="mt-24 border-t border-rule">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-10 text-sm text-ink/70 sm:flex-row sm:items-center sm:justify-between">
        <Attribution linkClassName="text-ink underline decoration-rule underline-offset-2 hover:decoration-amber" />
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
