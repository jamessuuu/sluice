import { expect, test } from "@playwright/test";

// SPEC §9 M8: the playground's side-by-side "without sluice / with sluice"
// duplicate-side-effect counters must actually differ once a batch runs
// with a non-zero duplicate rate — the whole point of the demo.
test("playground: without/with duplicate counters differ after a run", async ({ page }) => {
  await page.goto("/playground");

  const withoutCounter = page.getByTestId("counter-naive");
  const withCounter = page.getByTestId("counter-sluice");

  await expect(withoutCounter).toHaveText("0");
  await expect(withCounter).toHaveText("0");

  await page.getByRole("button", { name: "Run" }).click();

  // Default sliders (60% duplicate rate) guarantee at least some duplicates
  // land on the naive side; sluice's must stay at 0.
  await expect(withoutCounter).not.toHaveText("0", { timeout: 15_000 });
  await expect(withCounter).toHaveText("0");

  // The live effect ledger and audit stream actually populated.
  await expect(page.getByText("without sluice", { exact: true })).toBeVisible();
  await expect(page.getByText("with sluice", { exact: true })).toBeVisible();
  await expect(page.locator("li", { hasText: "effect." }).first()).toBeVisible();
});

test("playground: all sliders at 0 (no duplicates, no faults) produces zero duplicates on either side", async ({
  page,
}) => {
  await page.goto("/playground");
  // Duplicate rate AND timeout rate AND error rate all to 0 — a naive
  // delivery can still "duplicate" purely from retrying a single delivery
  // that timed out (the exact bug the demo illustrates), so proving zero
  // duplicates requires zeroing every fault source, not just duplicateRate.
  const sliders = page.locator('input[type="range"]');
  await sliders.nth(0).fill("0");
  await sliders.nth(1).fill("0");
  await sliders.nth(2).fill("0");
  await page.getByRole("button", { name: "Run" }).click();
  await page.waitForTimeout(2_000);

  await expect(page.getByTestId("counter-naive")).toHaveText("0");
  await expect(page.getByTestId("counter-sluice")).toHaveText("0");
});
