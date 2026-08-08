/**
 * The CLI's ephemeral store (SPEC §2: "MemoryStore ... the CLI's ephemeral
 * mode"): a plain-JSON `MemoryStoreState` (memory-store.ts) persisted to a
 * local file between invocations. This is deliberately NOT a Postgres
 * connection — @jamessuuu/sluice has zero runtime dependencies and the CLI
 * ships from this same package, so it cannot depend on
 * `@jamessuuu/sluice-store-postgres` (that would both break the zero-dep
 * guarantee for every consumer, including the browser bundle, and create a
 * circular package dependency, since sluice-store-postgres already depends
 * on sluice). For real production gates, point your own script at your own
 * Postgres store; this CLI is for local dogfooding, demos, and CI chaos
 * runs — the same MemoryStore the tests and the browser playground use.
 *
 * Node-only (SPEC §2's CLI carve-out) — see eslint.config.mjs's
 * `src/cli/**` exemption from the core's no-node-builtins rule.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStoreState } from "../memory-store.js";

export const DEFAULT_STATE_PATH = ".sluice/state.json";

export function loadState(path: string): MemoryStoreState | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as MemoryStoreState;
  } catch (cause) {
    if (isEnoent(cause)) return undefined;
    throw cause;
  }
}

export function saveState(path: string, state: MemoryStoreState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function isEnoent(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}
