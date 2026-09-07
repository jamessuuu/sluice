// Regression pin for the WebKit "window.load never fires" defect
// (DEFECT-LEDGER-2026-09-06.md, cross-site summary item 3).
//
// Root cause: gate-demo.tsx's <video> only offered a VP8/webm <source>.
// WebKit's video-resource-selection step never resolves for that encode (it
// neither plays nor errors, it just hangs), which keeps
// document.readyState stuck at "interactive" and window.load pending
// forever, even though the rest of the page renders fine. Chromium plays
// webm natively so it never showed the symptom. The fix: list an
// H.264/mp4 <source> FIRST so WebKit picks that candidate instead
// (browsers use the first <source> whose type they can play).
//
// This is a standalone script (not wired into `pnpm test:e2e`, which only
// exercises the chromium project against a full `next build && next start`)
// so it can pin the exact regression fast and deterministically: a plain
// static file server, the real production /public assets, and a minimal
// fixture that mirrors gate-demo.tsx's fixed <video> markup. Keep the
// fixture's <video>/<source> block in sync with gate-demo.tsx if that
// component's video markup changes.
//
// Run: node e2e/webkit-video-load.test.mjs
// Requires: WebKit installed for this Playwright version (already true here
// since @playwright/test and its cached browser binaries are shared via the
// machine's ms-playwright cache).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webkit } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const LOAD_TIMEOUT_MS = 15000;

const FIXTURE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>webkit-video-load fixture</title></head>
<body>
  <video
    autoplay
    muted
    loop
    playsinline
    tabindex="-1"
    aria-hidden="true"
    poster="/demo/sluice-poster.png"
    data-testid="gate-demo-video"
  >
    <source src="/demo/sluice-demo.mp4" type="video/mp4" />
    <source src="/demo/sluice-demo.webm" type="video/webm" />
  </video>
</body>
</html>
`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

function startServer(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/" || urlPath === "/fixture.html") {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(FIXTURE_HTML);
      return;
    }
    const filePath = path.join(publicDir, urlPath);
    // Guard against escaping publicDir.
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found: " + urlPath);
        return;
      }
      const ext = path.extname(filePath);
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
      const range = req.headers.range;
      if (range && (ext === ".webm" || ext === ".mp4")) {
        const size = data.length;
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = match ? parseInt(match[1], 10) : 0;
        const end = match && match[2] ? parseInt(match[2], 10) : size - 1;
        res.writeHead(206, {
          ...headers,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": end - start + 1,
        });
        res.end(data.slice(start, end + 1));
        return;
      }
      if (ext === ".webm" || ext === ".mp4") headers["Accept-Ranges"] = "bytes";
      res.writeHead(200, headers);
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => resolve(server));
  });
}

export async function run() {
  for (const asset of ["demo/sluice-demo.mp4", "demo/sluice-demo.webm", "demo/sluice-poster.png"]) {
    if (!fs.existsSync(path.join(publicDir, asset))) {
      throw new Error(`fixture asset missing: public/${asset} — did the mp4 transcode get committed?`);
    }
  }

  const port = 8532;
  const server = await startServer(port);
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/fixture.html`, {
      waitUntil: "load",
      timeout: LOAD_TIMEOUT_MS,
    });
    const elapsed = Date.now() - t0;
    const readyState = await page.evaluate(() => document.readyState);
    if (readyState !== "complete") {
      throw new Error(`window.load fired but readyState is "${readyState}", expected "complete"`);
    }
    console.log(`PASS: window.load fired in WebKit after ${elapsed}ms (limit ${LOAD_TIMEOUT_MS}ms), readyState=complete`);
    return true;
  } finally {
    await browser.close();
    server.close();
  }
}

// Only auto-run (and set an exit code) when this file is executed directly,
// not when imported by another test runner.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error("FAIL:", err.message);
      process.exitCode = 1;
    });
}
