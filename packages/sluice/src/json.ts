/**
 * Canonical JSON — deterministic serialization used for fingerprints and
 * idempotency keys. Keys sorted lexicographically at every depth; no
 * whitespace; rejects values JSON cannot round-trip (undefined in arrays
 * becomes null per JSON.stringify semantics — we forbid it instead, loudly,
 * because a silently-coerced value would change a fingerprint).
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export function canonicalJson(value: Json): string {
  return serialize(value, []);
}

function serialize(value: Json, path: (string | number)[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `canonicalJson: non-finite number at ${formatPath(path)}`
        );
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        // Runtime reality: callers can hand us `[1, undefined]` despite the
        // Json type — JSON.stringify would coerce it to null and silently
        // change a fingerprint, so we widen the type and reject loudly.
        const parts = value.map((v: Json | undefined, i) => {
          if (v === undefined) {
            throw new TypeError(
              `canonicalJson: undefined in array at ${formatPath([...path, i])}`
            );
          }
          return serialize(v, [...path, i]);
        });
        return `[${parts.join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = value[k];
        if (v === undefined) continue; // absent, not null — consistent with JSON.stringify
        parts.push(`${JSON.stringify(k)}:${serialize(v, [...path, k])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(
        `canonicalJson: unsupported ${typeof value} at ${formatPath(path)}`
      );
  }
}

function formatPath(path: (string | number)[]): string {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}
