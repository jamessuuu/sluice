/**
 * The playground's Web Worker entry point. `self` is typed via `Worker`
 * (the main-thread-facing interface DOM already declares) cast through
 * `unknown` rather than pulling in the `WebWorker` lib — that lib's globals
 * conflict with `DOM`'s (both declare `self`), and apps/web's tsconfig
 * already needs `DOM` for the rest of the app. `Worker.postMessage`/
 * `onmessage` have the right shape for this file's needs either way.
 */
import { runPlayground } from "./engine";
import type { WorkerRequest } from "./protocol";

const ctx = self as unknown as Worker;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  void runPlayground(ev.data.params, (response) => {
    ctx.postMessage(response);
  });
};
