import type { MemoryStoreState } from "@jamessuuu/sluice";

/**
 * The store mirror (SPEC §9): every result from the gate worker gets
 * written here, so a REAL page reload (not just a re-render) picks up
 * exactly where the walkthrough left off. sessionStorage, not localStorage
 * — this is demo state scoped to one browser tab's session, not something
 * that should outlive closing the tab.
 */
const KEY = "sluice-gate-demo-v1";

export function loadGateState(): MemoryStoreState | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as MemoryStoreState;
  } catch {
    return null;
  }
}

export function saveGateState(state: MemoryStoreState): void {
  window.sessionStorage.setItem(KEY, JSON.stringify(state));
}

export function clearGateState(): void {
  window.sessionStorage.removeItem(KEY);
}
