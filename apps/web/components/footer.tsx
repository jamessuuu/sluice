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
 *
 * Band 6's other half (PORTFOLIO-DESIGN-DNA.md §4.2, INSTALL + COLOPHON): it takes
 * the same --edge-lo hairline and the same 1240px measure as every band above it.
 */
export function Footer() {
  return (
    <footer className="border-t border-edge-lo bg-sub-1 py-10">
      <div className="band-inner t-body-s flex flex-col gap-3 text-ink-2 sm:flex-row sm:items-center sm:justify-between">
        <Attribution linkClassName="text-ink underline decoration-edge-lo underline-offset-2 hover:decoration-signal" />
        <div className="flex items-center gap-4">
          <a className="hover:text-ink" href="https://github.com/jamessuuu/sluice">
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
