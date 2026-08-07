import { describe, expect, it } from "vitest";
import { SLUICE_VERSION } from "./index.js";

describe("package surface (M0)", () => {
  it("exports a semver version", () => {
    expect(SLUICE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/);
  });
});
