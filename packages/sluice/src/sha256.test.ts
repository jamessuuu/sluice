import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.js";

// FIPS 180-4 vectors.
const VECTORS: [string, string][] = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
];

describe("sha256Hex", () => {
  it("matches FIPS 180-4 test vectors", () => {
    for (const [input, expected] of VECTORS) {
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it("matches the one-million-a vector", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
  });

  it("cross-checks against node:crypto on varied inputs (incl. multibyte)", () => {
    const inputs = [
      "sluice",
      "héllo wörld",
      "日本語テキスト",
      "🚰".repeat(100),
      "x".repeat(63),
      "x".repeat(64),
      "x".repeat(65),
      "x".repeat(119),
      "x".repeat(120),
      JSON.stringify({ tool: "send_email", args: { to: "a@b.c" } }),
    ];
    for (const input of inputs) {
      const reference = createHash("sha256").update(input, "utf8").digest("hex");
      expect(sha256Hex(input), `input: ${input.slice(0, 24)}`).toBe(reference);
    }
  });
});
