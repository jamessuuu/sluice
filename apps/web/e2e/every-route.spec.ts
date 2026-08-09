import { expect, test } from "@playwright/test";

// BRAND-KIT.md requirement: chip mark + attribution + backlink + repo link
// on EVERY page, plus the chip favicon. Checked across every route this
// build produces, not just the landing page (M8: "footer+favicon on every
// route").
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
  test(`footer + favicon present on ${route}`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.ok()).toBe(true);

    const footer = page.locator("footer");
    await expect(footer.getByText("Built by")).toBeVisible();
    await expect(footer.getByText("James Lorenz Santos")).toBeVisible();
    await expect(footer.getByRole("link", { name: "github.com/jamessuuu/sluice" })).toHaveAttribute(
      "href",
      "https://github.com/jamessuuu/sluice"
    );

    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/brand/favicon.svg");
  });
}
