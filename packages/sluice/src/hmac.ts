/**
 * HMAC-SHA256 (RFC 2104) built on the in-repo sha256 primitive — the core
 * stays zero-dependency and browser-runnable (SPEC §2/§4). Verified against
 * RFC 4231 vectors and cross-checked with node:crypto in hmac.test.ts
 * (tests may import node builtins; source may not).
 *
 * Also home to base64url and the constant-time comparison used by approval
 * tokens (SPEC §5 auth model).
 */
import { sha256Hex } from "./sha256.js";

/** SHA-256 block size per RFC 2104. */
const BLOCK_SIZE = 64;

export function hmacSha256Hex(key: Uint8Array | string, message: Uint8Array | string): string {
  let k = toBytes(key);
  if (k.length > BLOCK_SIZE) k = hexToBytes(sha256Hex(k));
  const ipad = new Uint8Array(BLOCK_SIZE);
  const opad = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const b = i < k.length ? (k[i] ?? 0) : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const inner = hexToBytes(sha256Hex(concat(ipad, toBytes(message))));
  return sha256Hex(concat(opad, inner));
}

/**
 * Constant-time string comparison — a plain `===` leaks a timing oracle on
 * the MAC prefix. Length difference folds into the accumulator instead of
 * returning early.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (RFC 4648 §5). */
export function base64urlEncode(input: Uint8Array | string): string {
  const bytes = toBytes(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL.charAt(b0 >> 2);
    out += B64URL.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    if (b1 === undefined) break;
    out += B64URL.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    if (b2 === undefined) break;
    out += B64URL.charAt(b2 & 0x3f);
  }
  return out;
}

/** Inverse of base64urlEncode. Returns null on any malformed input. */
export function base64urlDecode(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of s) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

export function utf8Decode(bytes: Uint8Array): string {
  // Token payloads are ASCII (uuid.digits.hex); a hand-rolled decoder keeps
  // TextDecoder out of the platform contract (platform.d.ts).
  let out = "";
  for (const b of bytes) {
    if (b > 0x7f) return ""; // non-ASCII cannot be a valid token payload
    out += String.fromCharCode(b);
  }
  return out;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
