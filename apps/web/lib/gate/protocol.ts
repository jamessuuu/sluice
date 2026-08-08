import type { AuditEvent, GateRecord, MemoryStoreState } from "@jamessuuu/sluice";

/**
 * Message protocol for the /gate walkthrough's Web Worker (SPEC §9: Web
 * Worker, sessionStorage persistence, kill/restart). Every command is
 * handled by a FRESH, short-lived worker constructed from the last
 * persisted `MemoryStoreState` — "kill/restart" per action is the point,
 * not an implementation shortcut: it's what proves the gate/effect state
 * lives in the (session-mirrored) store, not in any one worker's memory.
 */
export type GateCommand = "status" | "open" | "approve" | "reject" | "resume" | "replay";

export interface GateWorkerRequest {
  command: GateCommand;
  /** null only for the very first "open" call, before any state exists. */
  state: MemoryStoreState | null;
}

export interface GateView {
  gate: GateRecord | null;
  /** How many times the guarded side effect has actually fired — proof of "exactly once". */
  publishCount: number;
  events: AuditEvent[];
}

export type GateWorkerResponse =
  | { kind: "result"; state: MemoryStoreState; view: GateView; log: string }
  | { kind: "error"; message: string };
