/**
 * Demo recorder — drives the REAL deployed site with Playwright and records it.
 *
 * Why against the deployed site and not a local dev server: a recording made
 * from localhost can drift from what a visitor actually gets, and then the
 * video becomes a claim with no receipt — the exact failure these projects
 * exist to prevent. If the site is broken in production, the recording is
 * broken too, which is the correct behaviour.
 *
 * Output: webm (Playwright's native format) plus a poster frame PNG, written
 * into the target repo's apps/web/public/demo/.
 *
 * Usage:
 *   node record-demo.mjs --project=sluice --out=C:/Users/admin/sluice/apps/web/public/demo
 *
 * Requires playwright to be resolvable from cwd (run it from a repo that has it).
 */
// @playwright/test re-exports the browser drivers, and it is what the repos
// already depend on — importing "playwright" directly would add a dependency
// none of them have.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const SITES = {
  sluice: "https://sluice-iota.vercel.app",
  snapgauge: "https://snapgauge.vercel.app",
  chaff: "https://chaff-xi.vercel.app",
  tiltmeter: "https://tiltmeter.vercel.app",
  dogwatch: "https://dogwatch-two.vercel.app",
};

/** 16:10, retina-ish. Big enough to read code, small enough to embed. */
const VIEWPORT = { width: 1120, height: 700 };

const pause = (p, ms) => p.waitForTimeout(ms);

/**
 * Click by visible text if present; returns whether it fired. Never throws.
 *
 * Prefers a role="button" match and only falls back to a plain text match
 * when no button matches — an unconditional `getByRole(...).or(getByText(...))`
 * resolves in DOM order, and on a page whose own prose repeats a button's
 * label (sluice's /gate copy literally says "Approve it, resume it..." above
 * the Approve button), `.first()` silently grabs the inert paragraph instead
 * of the control, and the click no-ops with no error. Root-caused by
 * recording sluice's demo and finding the Approve click never landed.
 */
async function tryClick(page, text, timeout = 4000) {
  try {
    const byRole = page.getByRole("button", { name: text });
    const el = ((await byRole.count()) > 0 ? byRole : page.getByText(text, { exact: false })).first();
    await el.waitFor({ state: "visible", timeout });
    await el.scrollIntoViewIfNeeded();
    await el.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Each scenario is a short, honest walk through the ONE thing the project
 * claims. No filler scrolling, no cursor wandering. If a step's target is not
 * on the page, the step is skipped rather than faked — a recording that shows
 * a control which does not exist is worse than a shorter recording.
 */
const SCENARIOS = {
  async sluice(page, base) {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await pause(page, 1200);
    // The claim lives on the landing page: 666 duplicates vs 0.
    await page.mouse.wheel(0, 480);
    await pause(page, 1800);
    // Then the thing you cannot show with a number: a gate surviving a crash.
    await page.goto(`${base}/gate`, { waitUntil: "domcontentloaded" });
    await pause(page, 1400);
    await tryClick(page, "Start");
    await pause(page, 2600); // the scripted crash lands here
    // DESIGN-DIRECTION.md's sequence is open, crash, RELOAD, approve, resume —
    // the reload is the point: the pending gate must survive a real
    // navigation (sessionStorage), not just React state that a client-side
    // re-render would have kept alive anyway. See e2e/gate.spec.ts.
    await page.reload({ waitUntil: "domcontentloaded" });
    await pause(page, 1400);
    await tryClick(page, "Approve");
    await pause(page, 1600);
    await tryClick(page, "Start worker");
    await pause(page, 2200);
    await page.mouse.wheel(0, 400);
    await pause(page, 1800);
  },

  async chaff(page, base) {
    await page.goto(`${base}/analyze`, { waitUntil: "domcontentloaded" });
    await pause(page, 1400);
    const ta = page.locator("textarea").first();
    if (await ta.count()) {
      await ta.click();
      // A small, real context file with one genuinely broken import.
      await ta.fill(
        [
          "# Project memory",
          "",
          "@./docs/conventions.md",
          "@./docs/does-not-exist.md",
          "",
          "## Rules",
          "",
          "Always run the gate before committing.",
          "Prefer false negatives over false positives.",
        ].join("\n"),
      );
      await pause(page, 900);
    }
    await tryClick(page, "Analyze");
    await pause(page, 2600);
    await page.mouse.wheel(0, 420);
    await pause(page, 2200);
  },

  async snapgauge(page, base) {
    await page.goto(`${base}/demo`, { waitUntil: "domcontentloaded" });
    await pause(page, 1400);
    await tryClick(page, "drift-breaking");
    await pause(page, 700);
    await tryClick(page, "Run");
    await pause(page, 2400);
    await page.mouse.wheel(0, 420);
    await pause(page, 2200);
  },

  async tiltmeter(page, base) {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await pause(page, 1600);
    await page.mouse.wheel(0, 400);
    await pause(page, 1600);
    // The death-condition guard is the point: no leaderboard anywhere.
    await page.goto(`${base}/models`, { waitUntil: "domcontentloaded" });
    await pause(page, 2000);
    await page.goto(`${base}/methodology`, { waitUntil: "domcontentloaded" });
    await pause(page, 1400);
    await page.mouse.wheel(0, 500);
    await pause(page, 1800);
  },

  async dogwatch(page, base) {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await pause(page, 1500);
    await page.goto(`${base}/runs`, { waitUntil: "domcontentloaded" });
    await pause(page, 1500);
    const firstRun = page.locator('a[href*="/runs/"]').first();
    if (await firstRun.count()) {
      await firstRun.click();
      await pause(page, 2000);
      await page.mouse.wheel(0, 500);
      await pause(page, 2000);
      await page.mouse.wheel(0, 500);
      await pause(page, 1800);
    }
  },
};

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    }),
  );
  const project = args.project;
  const outDir = args.out;
  if (!project || !SCENARIOS[project]) {
    console.error(`record-demo: --project must be one of ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
  if (!outDir) {
    console.error("record-demo: --out=<dir> is required");
    process.exit(2);
  }

  const base = args.base ?? SITES[project];
  const tmp = join(outDir, "__rec");
  mkdirSync(tmp, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: tmp, size: VIEWPORT },
    // Deterministic-ish: no animations from reduced-motion users' perspective
    // is a different recording; we record the default experience.
    colorScheme: "light",
  });
  const page = await context.newPage();

  // Poster frame: the first meaningful paint of the scenario's entry page.
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await pause(page, 1200);
  await page.screenshot({ path: join(outDir, `${project}-poster.png`) });

  await SCENARIOS[project](page, base);

  await context.close();
  await browser.close();

  const rec = readdirSync(tmp).find((f) => f.endsWith(".webm"));
  if (!rec) {
    console.error("record-demo: no video produced");
    process.exit(1);
  }
  const finalPath = join(outDir, `${project}-demo.webm`);
  if (existsSync(finalPath)) rmSync(finalPath);
  renameSync(join(tmp, rec), finalPath);
  rmSync(tmp, { recursive: true, force: true });

  console.log(`record-demo: ${project} -> ${finalPath}`);
  console.log(`record-demo: poster -> ${join(outDir, `${project}-poster.png`)}`);
}

await main();
