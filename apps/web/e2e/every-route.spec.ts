import { expect, test } from "@playwright/test";

// BRAND-KIT.md requirement: chip mark + attribution + backlink + repo link
// on EVERY page, plus the favicon. Checked across every route this build
// produces, not just the landing page (M8: "footer+favicon on every
// route").
//
// Icon hierarchy (BRAND-KIT.md, "Icon hierarchy — CHANGED 2026-08-09"): the
// favicon is sluice's OWN glyph (a weir gate), not the chip — five identical
// chip favicons are indistinguishable in a tab strip, which is the one job
// a favicon has. The chip stays the maker's mark, footer only.
const ROUTES = [
  "/",
  "/docs/quickstart",
  "/docs/concepts",
  "/docs/idempotency-keys",
  "/docs/retries-and-breaker",
  "/docs/gates",
  "/docs/stores-and-migrations",
  "/docs/chaos-harness",
  "/docs/failure-modes",
  "/docs/limitations",
  "/playground",
  "/gate",
  "/audit",
];

for (const route of ROUTES) {
  test(`footer + favicon present on ${route}`, async ({ page, request }) => {
    const response = await page.goto(route);
    expect(response?.ok()).toBe(true);

    const footer = page.locator("footer");
    await expect(footer.getByText("Built by")).toBeVisible();
    await expect(footer.getByText("James Lorenz Santos")).toBeVisible();
    await expect(footer.getByRole("link", { name: "github.com/jamessuuu/sluice" })).toHaveAttribute(
      "href",
      "https://github.com/jamessuuu/sluice"
    );
    // The footer's mark stays the maker's chip, never the project glyph —
    // association (footer), not identity (favicon). Since attribution-kit v1 the chip
    // is an inline SVG with its own accessible name, not an <img>.
    await expect(footer.locator('svg[aria-label="Agent James"]')).toHaveCount(1);

    // The favicon is sluice's own compact glyph (a gate, not the chip) —
    // assert the primary SVG icon link resolves over real HTTP, not just
    // that the DOM has a plausible-looking <link>.
    const svgIcon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(svgIcon).toHaveAttribute("href", "/brand/favicon.svg");
    const iconResponse = await request.get("/brand/favicon.svg");
    expect(iconResponse.status()).toBe(200);
    expect(iconResponse.headers()["content-type"]).toContain("image/svg+xml");
  });
}

test("apple-touch-icon and web app manifest resolve, and the manifest carries the glyph icons", async ({
  page,
  request,
}) => {
  await page.goto("/");

  const appleIcon = page.locator('link[rel="apple-touch-icon"]');
  await expect(appleIcon).toHaveAttribute("href", "/brand/apple-touch-icon.png");
  const appleResponse = await request.get("/brand/apple-touch-icon.png");
  expect(appleResponse.status()).toBe(200);
  expect(appleResponse.headers()["content-type"]).toContain("image/png");

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.status()).toBe(200);
  const manifestJson = (await manifestResponse.json()) as {
    icons: { src: string; purpose?: string }[];
  };
  expect(manifestJson.icons.length).toBeGreaterThan(0);
  for (const icon of manifestJson.icons) {
    expect(icon.src.startsWith("/brand/icon-")).toBe(true);
  }
});
