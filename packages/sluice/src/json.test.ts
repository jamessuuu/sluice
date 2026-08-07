import { describe, expect, it } from "vitest";
import { canonicalJson } from "./json.js";

describe("canonicalJson", () => {
  it("is key-order independent at every depth", () => {
    const a = canonicalJson({ b: 1, a: { d: [1, 2], c: "x" } });
    const b = canonicalJson({ a: { c: "x", d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it("preserves array order (arrays are positional, not sets)", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("drops undefined object members but rejects undefined in arrays", () => {
    expect(canonicalJson({ a: 1, b: undefined as never })).toBe('{"a":1}');
    expect(() => canonicalJson([1, undefined as never])).toThrow(/undefined in array/);
  });

  it("rejects non-finite numbers loudly", () => {
    expect(() => canonicalJson({ n: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
  });
});
