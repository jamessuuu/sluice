import { expect, test } from "@playwright/test";

test.describe("/audit — verify chain, tamper, and detect the break", () => {
  test("Verify chain reports ok on the untampered fixture", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByTestId("audit-row").first()).toBeVisible();
    await page.getByTestId("verify-button").click();
    await expect(page.getByTestId("verify-result")).toHaveText(/chain verifies clean/i);
  });

  test("Tamper then Verify chain reports the exact break index", async ({ page }) => {
    await page.goto("/audit");
    await page.getByTestId("tamper-button").click();
    await page.getByTestId("verify-button").click();
    await expect(page.getByTestId("verify-result")).toHaveText(/chain broken at index/i);
    // The tampered row itself is flagged.
    await expect(page.locator('[data-testid="audit-row"][data-broken="true"]')).toHaveCount(1);
  });

  test("Reset fixture clears the tamper and verify state", async ({ page }) => {
    await page.goto("/audit");
    await page.getByTestId("tamper-button").click();
    await page.getByTestId("verify-button").click();
    await expect(page.getByTestId("verify-result")).toHaveText(/broken/i);
    await page.getByRole("button", { name: "Reset fixture" }).click();
    await expect(page.getByTestId("verify-result")).toHaveCount(0);
    await page.getByTestId("verify-button").click();
    await expect(page.getByTestId("verify-result")).toHaveText(/chain verifies clean/i);
  });
});
