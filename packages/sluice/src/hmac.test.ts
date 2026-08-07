/**
 * M4 — in-repo HMAC-SHA256 (RFC 2104 over the sha256 primitive, block size
 * 64). Verified against RFC 4231 vectors AND cross-checked against
 * node:crypto (tests may import node builtins; core source may not).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mulberry32 } from "./harness.test-helper.js";
import { base64urlDecode, base64urlEncode, hmacSha256Hex, timingSafeEqualHex } from "./hmac.js";

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("hmacSha256Hex — RFC 4231 test vectors", () => {
  it("case 1: 20×0x0b key, 'Hi There'", () => {
    expect(hmacSha256Hex(bytes(20, 0x0b), "Hi There")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
  });

  it("case 2: 'Jefe', 'what do ya want for nothing?'", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
  });

  it("case 3: 20×0xaa key, 50×0xdd data", () => {
    expect(hmacSha256Hex(bytes(20, 0xaa), bytes(50, 0xdd))).toBe(
      "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"
    );
  });

  it("case 6: key larger than the 64-byte block is hashed first", () => {
    expect(
      hmacSha256Hex(bytes(131, 0xaa), "Test Using Larger Than Block-Size Key - Hash Key First")
    ).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });

  it("matches node:crypto createHmac across random keys and messages", () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 25; i++) {
      const key = new Uint8Array(Math.floor(rng() * 150)).map(() => Math.floor(rng() * 256));
      const msg = new Uint8Array(Math.floor(rng() * 300)).map(() => Math.floor(rng() * 256));
      const expected = createHmac("sha256", key).update(msg).digest("hex");
      expect(hmacSha256Hex(key, msg)).toBe(expected);
    }
  });
});

describe("base64url", () => {
  it("round-trips and matches node's base64url encoding", () => {
    const rng = mulberry32(77);
    for (let len = 0; len <= 32; len++) {
      const data = new Uint8Array(len).map(() => Math.floor(rng() * 256));
      const encoded = base64urlEncode(data);
      expect(encoded).toBe(Buffer.from(data).toString("base64url"));
      expect([...(base64urlDecode(encoded) ?? [])]).toEqual([...data]);
    }
  });

  it("rejects malformed input instead of guessing", () => {
    expect(base64urlDecode("ab+d")).toBeNull(); // '+' is base64, not base64url
    expect(base64urlDecode("ab=")).toBeNull(); // padding is not part of the alphabet
  });
});

describe("timingSafeEqualHex", () => {
  it("compares without early exit semantics", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
    expect(timingSafeEqualHex("deadbeef", "deadbee")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
    expect(timingSafeEqualHex("", "a")).toBe(false);
  });
});
