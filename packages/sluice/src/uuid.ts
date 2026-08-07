/**
 * UUIDv7-style id generation from the INJECTED clock and random source —
 * no node:crypto (zero-dep core, SPEC §2/§4), and deterministic in tests.
 *
 * Format (RFC 9562 layout): 48-bit big-endian unix milliseconds, 4-bit
 * version (7), 12 random bits, 2 variant bits (10), 62 random bits —
 * rendered as the canonical 8-4-4-4-12 lowercase hex string. Ids sort
 * chronologically by construction. Uniqueness is as good as the injected
 * `random()` — production uses Math.random per instance; tests seed it.
 */
export function uuidv7(nowMs: number, random: () => number): string {
  const bytes = new Uint8Array(16);
  let ts = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  for (let i = 6; i < 16; i++) {
    bytes[i] = Math.floor(random() * 256) & 0xff;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10

  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
