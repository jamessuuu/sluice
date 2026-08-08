/**
 * `sluice gates ls|show|approve|reject` — operate on the CLI's local
 * ephemeral store (state-file.ts). See that file for why this is
 * MemoryStore-backed rather than a Postgres connection.
 */
import { createSluice } from "../sluice.js";
import { MemoryStore } from "../memory-store.js";
import type { GateStatus } from "../types.js";
import { loadState, saveState } from "./state-file.js";

export interface GatesCommandOptions {
  statePath: string;
  namespace?: string;
  status?: GateStatus;
  decidedBy?: string;
  reason?: string;
}

function open(statePath: string) {
  const state = loadState(statePath);
  const store = new MemoryStore(state);
  const sluice = createSluice({ store, namespace: "default", owner: "cli" });
  return { store, sluice };
}

function persist(statePath: string, store: MemoryStore): void {
  saveState(statePath, store.exportState());
}

export async function gatesLs(o: GatesCommandOptions): Promise<string> {
  const { store, sluice } = open(o.statePath);
  const namespace = o.namespace ?? "default";
  await sluice.gates.sweepTimeouts(); // a listing is a read — expired gates resolve first
  const gates =
    o.status === undefined
      ? await store.listGates({ namespace, limit: 100 })
      : await store.listGates({ namespace, status: o.status, limit: 100 });
  persist(o.statePath, store);
  if (gates.length === 0) return "no gates.";
  return gates
    .map((g) => `${g.id}  ${g.status.padEnd(10)} ${g.key}  (namespace: ${g.namespace})`)
    .join("\n");
}

export async function gatesShow(id: string, o: GatesCommandOptions): Promise<string> {
  const { store, sluice } = open(o.statePath);
  const gate = await sluice.gates.get(id);
  persist(o.statePath, store);
  if (gate === null) return `no such gate: ${id}`;
  return JSON.stringify(gate, null, 2);
}

export async function gatesDecide(
  id: string,
  decision: "approve" | "reject",
  o: GatesCommandOptions
): Promise<string> {
  const { store, sluice } = open(o.statePath);
  const decided = await sluice.gates.decide({
    id,
    decision,
    decidedBy: o.decidedBy ?? "cli",
    ...(o.reason === undefined ? {} : { reason: o.reason }),
  });
  persist(o.statePath, store);
  return `${decided.id}  ${decided.status}  ${decided.key}`;
}
