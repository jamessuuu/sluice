// SPEC §2 / §12.1 — verify that `pnpm pack` produces tarballs whose
// package.json exports resolve to dist/, not src/ (publishConfig rewrite).
// Run after `pnpm -r build`. Fails loudly; CI treats a non-zero exit as red.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = [
  "packages/sluice",
  "packages/sluice-store-postgres",
  "packages/sluice-testkit",
];

let failed = false;
for (const pkg of packages) {
  const tmp = mkdtempSync(join(tmpdir(), "sluice-pack-"));
  try {
    const out = execSync(`pnpm pack --pack-destination "${tmp}"`, {
      cwd: pkg,
      encoding: "utf8",
    }).trim();
    const tarball = out.split("\n").at(-1);
    // Extract with a RELATIVE path from inside tmp: GNU tar on Windows
    // interprets "C:" in an absolute path as a remote host ("Cannot connect").
    const tarballName = tarball.replace(/\\/g, "/").split("/").at(-1);
    execSync(`tar -xzf "${tarballName}"`, { cwd: tmp });
    const manifest = JSON.parse(readFileSync(join(tmp, "package", "package.json"), "utf8"));
    const exportsField = JSON.stringify(manifest.exports ?? {});
    if (exportsField.includes("src/")) {
      console.error(`FAIL ${pkg}: packed exports still point at src/ -> ${exportsField}`);
      failed = true;
    } else if (!exportsField.includes("dist/")) {
      console.error(`FAIL ${pkg}: packed exports do not point at dist/ -> ${exportsField}`);
      failed = true;
    } else {
      console.log(`ok   ${pkg}: packed exports -> dist/`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
