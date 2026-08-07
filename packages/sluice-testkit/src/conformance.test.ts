/**
 * The store contract suite against MemoryStore (SPEC §5/§8). The Postgres
 * adapter consumes the same suite at M6 — identical assertions, different
 * factory. A failure here is a contract change, not a flake.
 */
import { MemoryStore } from "@jamessuuu/sluice";
import { describe, expect, it } from "vitest";
import { runStoreConformance } from "./conformance.js";

describe("runStoreConformance(MemoryStore)", () => {
  it("passes every contract case", async () => {
    const report = await runStoreConformance(() => new MemoryStore());
    expect(
      report.failed,
      report.failed.map((f) => `${f.name}: ${f.message}`).join("\n")
    ).toEqual([]);
    expect(report.passed).toBe(report.total);
    expect(report.total).toBeGreaterThanOrEqual(15);
  });
});
