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
  // BRAND-KIT.md "Icon hierarchy": the favicon is sluice's own glyph (a weir
  // gate), not the chip — the chip stays the maker's mark in the footer.
  // Scoped to the SVG icon link specifically: metadata.icons also emits
  // three PNG fallback sizes at the same rel, so an unscoped
  // `link[rel="icon"]` locator now matches more than one element.
  test("favicon link points at sluice's own glyph, not the chip", async ({ page }) => {
    await page.goto("/");
    const icon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(icon).toHaveAttribute("href", "/brand/favicon.svg");
  });

  test("links to docs, playground, and gate walkthrough", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Read the docs/ })).toHaveAttribute("href", "/docs/quickstart");
    // Two links carry this name on purpose: the primary CTA under the hero stat and the footer text link.
    const playground = page.getByRole("link", { name: /Try the playground/ });
    await expect(playground).toHaveCount(2);
    for (const link of await playground.all()) await expect(link).toHaveAttribute("href", "/playground");
    await expect(page.getByRole("link", { name: /Walk through a gate/ })).toHaveAttribute("href", "/gate");
  });
});

test.describe("docs", () => {
  test("quickstart page renders with footer + favicon (BRAND-KIT: every page)", async ({ page }) => {
    await page.goto("/docs/quickstart");
    await expect(page.getByRole("heading", { name: "Quickstart" })).toBeVisible();
    await expect(page.locator("footer").getByText("Built by")).toBeVisible();
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
      "href",
      "/brand/favicon.svg"
    );
  });

  test("failure-modes page renders the full F1-F12 table", async ({ page }) => {
    await page.goto("/docs/failure-modes");
    await expect(page.getByText("F1")).toBeVisible();
    await expect(page.getByText("F12")).toBeVisible();
    await expect(page.getByText("E_KEY_CONFLICT").first()).toBeVisible();
  });

  test("concepts page renders the diagram and every other docs page is reachable from its nav", async ({
    page,
  }) => {
    await page.goto("/docs/concepts");
    await expect(page.getByRole("heading", { name: "Concepts", exact: true })).toBeVisible();
    // The diagram is inlined SVG (DESIGN-DIRECTION.md), not <img src>, so its
    // title/desc are real accessibility-tree content — assert on that, not a
    // screenshot.
    await expect(page.locator("svg title")).toHaveText(/exactly-once state machine/i);
    await expect(page.locator("svg desc")).toContainText(/no automatic path back|never silently retried/i);

    const nav = page.getByRole("navigation", { name: "Docs" });
    for (const label of ["Quickstart", "Idempotency keys", "Gates", "Failure modes", "Limitations"]) {
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("href", /\/docs\//);
    }
  });
});

test.describe("landing — evidence sections (DESIGN-DIRECTION.md)", () => {
  test("mechanism diagram is inlined SVG with a real title and desc", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("svg title")).toHaveText(/exactly-once state machine/i);
    await expect(page.locator("svg desc")).toContainText(/indeterminate/i);
  });

  test("failure-mode table on the landing page shows F1 through F12", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("F1").first()).toBeVisible();
    await expect(page.getByText("F12").first()).toBeVisible();
  });

  test("demo video has a poster, is muted, and has no visible browser chrome (no controls)", async ({
    page,
  }) => {
    await page.goto("/");
    const video = page.getByTestId("gate-demo-video");
    await expect(video).toHaveAttribute("poster", "/demo/sluice-poster.png");
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).not.toHaveAttribute("controls", "");
  });

  test("reduced motion renders the poster and a link instead of the autoplaying video", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByTestId("gate-demo-video")).toBeHidden();
    const fallback = page.getByTestId("gate-demo-reduced-motion");
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole("link", { name: /watch the recording/i })).toHaveAttribute(
      "href",
      "/demo/sluice-demo.webm"
    );
  });

  test("without a reduced-motion preference, the video is visible and the fallback is hidden", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await expect(page.getByTestId("gate-demo-video")).toBeVisible();
    await expect(page.getByTestId("gate-demo-reduced-motion")).toBeHidden();
  });
});
