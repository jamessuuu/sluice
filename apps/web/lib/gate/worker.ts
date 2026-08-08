/**
 * The /gate walkthrough's worker. Every command is a fresh, short-lived
 * worker instance (main thread creates one, posts a command, terminates it
 * on response) — EXCEPT "open", which deliberately keeps running after
 * posting its result: it simulates the agent process that opened the gate
 * continuing to "work" for a couple of seconds before the main thread kills
 * it (`worker.terminate()`) to demonstrate the crash. The gate itself is
 * already durably persisted (mirrored to sessionStorage by the main thread
 * the instant the "opened" message arrives) — the kill proves the pending
 * card does not depend on this worker surviving.
 */
import { runCommand } from "./scenario";
import type { GateWorkerRequest, GateWorkerResponse } from "./protocol";

const ctx = self as unknown as Worker;

ctx.onmessage = (ev: MessageEvent<GateWorkerRequest>) => {
  const { command, state } = ev.data;
  void runCommand(command, state, `worker-${Math.random().toString(36).slice(2, 8)}`)
    .then((result) => {
      const response: GateWorkerResponse = { kind: "result", ...result };
      ctx.postMessage(response);
      if (command === "open") {
        // Simulate the opener continuing to run — never resolves; the main
        // thread terminates this worker externally after ~2s (the crash).
        return new Promise<void>(() => undefined);
      }
      return undefined;
    })
    .catch((err: unknown) => {
      const response: GateWorkerResponse = {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      ctx.postMessage(response);
    });
};
