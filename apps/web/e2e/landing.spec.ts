import { expect, test } from "@playwright/test";

// SPEC §9 / §11: "/" renders with JS disabled — the fully-static landing
// requirement (D3 blackout-safe) proven against the real built app, not
// asserted in prose.
test.describe("landing — renders with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("name, tagline, install snippet, and the chaos table are all present", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.ok()).toBe(true);

    await expect(page.getByRole("heading", { name: "sluice", exact: true })).toBeVisible();
    await expect(page.getByText("Exactly-once side effects for agent tool calls", { exact: false })).toBeVisible();
    await expect(page.getByText("pnpm add @jamessuuu/sluice")).toBeVisible();
    // The chaos table is read from chaos/results/latest.json at build time —
    // its presence (not its exact numbers, which drift) is what this proves.
    await expect(page.getByText("duplicate side effects")).toBeVisible();
    await expect(page.getByText("invariant violations")).toBeVisible();
  });

  test("footer attribution + repo link + no hire-me CTA", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator("footer");
    await expect(footer.getByText("Built by")).toBeVisible();
    await expect(footer.getByText("James Lorenz Santos")).toBeVisible();
    await expect(footer.getByRole("link", { name: /agentjames\.vercel\.app|James Lorenz Santos/ })).toHaveAttribute(
      "href",
      "https://agentjames.vercel.app"
    );
    await expect(footer.getByRole("link", { name: "github.com/jamessuuu/sluice" })).toHaveAttribute(
      "href",
      "https://github.com/jamessuuu/sluice"
    );
    // D1: no hire-me / services CTA anywhere on the page.
    const bodyText = await page.locator("body").innerText();
    for (const banned of ["hire me", "book a call", "available for hire", "get in touch", "contact me"]) {
      expect(bodyText.toLowerCase()).not.toContain(banned);
    }
  });
});

test.describe("landing — with JavaScript enabled", () => {
  test("favicon link points at the chip mark", async ({ page }) => {
    await page.goto("/");
    const icon = page.locator('link[rel="icon"]');
    await expect(icon).toHaveAttribute("href", "/brand/favicon.svg");
  });

  test("links to docs, playground, and gate walkthrough", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Read the docs/ })).toHaveAttribute("href", "/docs/quickstart");
    await expect(page.getByRole("link", { name: /Try the playground/ })).toHaveAttribute("href", "/playground");
    await expect(page.getByRole("link", { name: /Walk through a gate/ })).toHaveAttribute("href", "/gate");
  });
});

test.describe("docs", () => {
  test("quickstart page renders with footer + favicon (BRAND-KIT: every page)", async ({ page }) => {
    await page.goto("/docs/quickstart");
    await expect(page.getByRole("heading", { name: "Quickstart" })).toBeVisible();
    await expect(page.locator("footer").getByText("Built by")).toBeVisible();
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/brand/favicon.svg");
  });

  test("failure-modes page renders the full F1-F12 table", async ({ page }) => {
    await page.goto("/docs/failure-modes");
    await expect(page.getByText("F1")).toBeVisible();
    await expect(page.getByText("F12")).toBeVisible();
    await expect(page.getByText("E_KEY_CONFLICT").first()).toBeVisible();
  });
});
