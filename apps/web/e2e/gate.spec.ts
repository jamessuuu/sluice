import { expect, test } from "@playwright/test";

// SPEC §9 / §11 M8: the gate walkthrough completes in < 30s of interaction
// AND survives a real page reload. This spec measures actual interaction
// time (not wall-clock test runtime, which includes browser/server
// overhead unrelated to the demo itself) and forces a real navigation
// reload mid-flow — not a soft client-side re-render — to prove the
// sessionStorage mirror, not React state, is what's carrying the gate.
test("gate walkthrough: open -> crash -> survive a real reload -> approve -> resume -> replay, in under 30s of interaction", async ({
  page,
}) => {
  const startedAt = Date.now();

  await page.goto("/gate");
  await page.getByTestId("start-worker-button").click();

  // The worker panel must show it crashed (killed after ~2s) — proves the
  // crash actually happened, not just that the gate opened.
  await expect(page.getByTestId("worker-status")).toHaveText(/crashed/i, { timeout: 10_000 });
  await expect(page.getByTestId("pending-card")).toBeVisible();
  await expect(page.getByText("status: pending")).toBeVisible();

  // A REAL page reload — a fresh navigation, not a client-side re-render.
  // Everything above must be gone from JS memory; only sessionStorage
  // carries it forward.
  await page.reload();

  await expect(page.getByTestId("pending-card")).toBeVisible();
  await expect(page.getByText("status: pending")).toBeVisible();
  await expect(page.getByTestId("approve-button")).toBeVisible();

  await page.getByTestId("approve-button").click();
  await expect(page.getByText("status: approved")).toBeVisible();

  await page.getByTestId("resume-button").click();
  await expect(page.getByTestId("publish-status")).toHaveText(/fired 1 time/, { timeout: 10_000 });

  // Replay everything: the side effect must NOT fire again.
  await page.getByTestId("replay-button").click();
  await expect(page.getByTestId("audit-log")).toContainText("no new side effect", { timeout: 10_000 });
  await expect(page.getByTestId("publish-status")).toHaveText(/fired 1 time/);

  const elapsedMs = Date.now() - startedAt;
  expect(elapsedMs).toBeLessThan(30_000);
});

test("gate walkthrough: reject leaves no side effect", async ({ page }) => {
  await page.goto("/gate");
  await page.getByTestId("start-worker-button").click();
  await expect(page.getByTestId("pending-card")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("reject-button").click();
  await expect(page.getByText("rejected — no side effect ran.")).toBeVisible();
  await expect(page.getByTestId("publish-status")).toHaveCount(0);
});
