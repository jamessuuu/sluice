"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GateCommand, GateView, GateWorkerRequest, GateWorkerResponse } from "@/lib/gate/protocol";
import { clearGateState, loadGateState, saveGateState } from "@/lib/gate/session-storage";
import type { MemoryStoreState } from "@jamessuuu/sluice";

type CrashPanel = "idle" | "running" | "crashed";
type Step = "start" | "pending" | "approved" | "published" | "rejected" | "timed_out";

const CRASH_AFTER_MS = 2000;

function stepFromView(view: GateView | null): Step {
  if (view?.gate == null) return "start";
  switch (view.gate.status) {
    case "pending":
      return "pending";
    case "approved":
      return view.publishCount > 0 ? "published" : "approved";
    case "rejected":
      return "rejected";
    case "timed_out":
      return "timed_out";
    default:
      return "start";
  }
}

export default function GatePage() {
  const [crashPanel, setCrashPanel] = useState<CrashPanel>("idle");
  const [view, setView] = useState<GateView | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const stateRef = useRef<MemoryStoreState | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const crashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runCommand = useCallback((command: GateCommand, opts?: { keepAlive?: boolean }) => {
    return new Promise<void>((resolve, reject) => {
      setBusy(true);
      setErrorMsg(null);
      const worker = new Worker(new URL("../../lib/gate/worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;

      worker.onmessage = (ev: MessageEvent<GateWorkerResponse>) => {
        const msg = ev.data;
        if (msg.kind === "error") {
          setErrorMsg(msg.message);
          setBusy(false);
          worker.terminate();
          reject(new Error(msg.message));
          return;
        }
        stateRef.current = msg.state;
        saveGateState(msg.state);
        setView(msg.view);
        setLog((prev) => [...prev, msg.log]);
        setBusy(false);
        if (opts?.keepAlive !== true) {
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        }
        resolve();
      };
      worker.onerror = (ev) => {
        setErrorMsg(ev.message);
        setBusy(false);
        reject(new Error(ev.message));
      };
      const req: GateWorkerRequest = { command, state: stateRef.current };
      worker.postMessage(req);
    });
  }, []);

  // Recover from a real page reload: read the mirrored store and re-derive
  // the on-screen state from it — nothing about this depends on any worker
  // (the original one is long gone) or on React state that reload wiped.
  useEffect(() => {
    const saved = loadGateState();
    if (saved !== null) {
      stateRef.current = saved;
      void runCommand("status").then(() => {
        setCrashPanel("crashed");
      });
    }
    return () => {
      workerRef.current?.terminate();
      if (crashTimerRef.current !== null) clearTimeout(crashTimerRef.current);
    };
  }, [runCommand]);

  const handleStartWorker = useCallback(() => {
    setCrashPanel("running");
    void runCommand("open", { keepAlive: true }).then(() => {
      crashTimerRef.current = setTimeout(() => {
        workerRef.current?.terminate();
        workerRef.current = null;
        setCrashPanel("crashed");
      }, CRASH_AFTER_MS);
    });
  }, [runCommand]);

  const handleReset = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    if (crashTimerRef.current !== null) clearTimeout(crashTimerRef.current);
    clearGateState();
    stateRef.current = null;
    setView(null);
    setLog([]);
    setCrashPanel("idle");
    setErrorMsg(null);
  }, []);

  const step = stepFromView(view);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-ink">Gate walkthrough</h1>
      <p className="mb-8 max-w-2xl text-sm leading-6 text-ink/70">
        A scripted &quot;publish the weekly digest&quot; opens a real approval gate — the same{" "}
        <code className="font-mono">gates.open()</code> your code would call. The worker that
        opened it gets killed after two seconds. The gate survives anyway, including a real
        reload of this page (try it). Approve it, resume it, then hit Replay to prove the second
        run does nothing.
      </p>

      {errorMsg !== null && (
        <p className="mb-6 border border-amber px-4 py-2 text-sm text-amber" role="alert">
          {errorMsg}
        </p>
      )}

      <section className="mb-6 border border-rule px-5 py-4" data-testid="worker-panel">
        <h2 className="mb-2 text-sm font-semibold text-ink">Worker</h2>
        {step === "start" && crashPanel === "idle" && (
          <button
            type="button"
            data-testid="start-worker-button"
            onClick={handleStartWorker}
            disabled={busy}
            className="border border-ink bg-ink px-5 py-2 text-sm font-semibold text-paper hover:bg-ink/80 disabled:opacity-50"
          >
            Start worker
          </button>
        )}
        {crashPanel === "running" && (
          <p data-testid="worker-status" className="font-mono text-sm text-ink/70">
            ● running — opening the gate…
          </p>
        )}
        {crashPanel === "crashed" && (
          <p data-testid="worker-status" className="font-mono text-sm text-amber">
            ✕ crashed (killed by the browser) — the gate is still here.
          </p>
        )}
      </section>

      {view?.gate != null && (
        <section className="mb-6 border border-rule px-5 py-4" data-testid="pending-card">
          <h2 className="mb-2 text-sm font-semibold text-ink">{view.gate.presentation?.title ?? view.gate.key}</h2>
          <p className="mb-3 text-sm text-ink/70">{view.gate.presentation?.summary}</p>
          <p className="mb-3 font-mono text-xs text-ink/50">
            status: <span className="text-ink">{view.gate.status}</span>
          </p>
          {step === "pending" && (
            <div className="flex gap-3">
              <button
                type="button"
                data-testid="approve-button"
                disabled={busy}
                onClick={() => void runCommand("approve")}
                className="border border-amber bg-amber px-4 py-2 text-sm font-semibold text-paper hover:bg-amber/90 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                data-testid="reject-button"
                disabled={busy}
                onClick={() => void runCommand("reject")}
                className="border border-rule px-4 py-2 text-sm text-ink hover:border-ink disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}
          {step === "approved" && (
            <button
              type="button"
              data-testid="resume-button"
              disabled={busy}
              onClick={() => void runCommand("resume")}
              className="border border-ink bg-ink px-5 py-2 text-sm font-semibold text-paper hover:bg-ink/80 disabled:opacity-50"
            >
              Start worker (resume from resumeContext)
            </button>
          )}
          {step === "published" && (
            <p data-testid="publish-status" className="font-mono text-sm text-amber">
              ✓ published — side effect fired {view.publishCount} time{view.publishCount === 1 ? "" : "s"}.
            </p>
          )}
          {step === "rejected" && <p className="font-mono text-sm text-ink/70">rejected — no side effect ran.</p>}
        </section>
      )}

      {view?.gate != null && (
        <section className="mb-6">
          <button
            type="button"
            data-testid="replay-button"
            disabled={busy}
            onClick={() => void runCommand("replay")}
            className="border border-rule px-4 py-2 text-sm text-ink hover:border-ink disabled:opacity-50"
          >
            Replay everything
          </button>
          <button
            type="button"
            data-testid="reset-button"
            onClick={handleReset}
            className="ml-3 border border-rule px-4 py-2 text-sm text-ink/60 hover:border-ink hover:text-ink"
          >
            Reset demo
          </button>
        </section>
      )}

      <section className="border border-rule px-5 py-4">
        <h2 className="mb-2 text-sm font-semibold text-ink">Audit trail</h2>
        <ul data-testid="audit-log" className="space-y-1 font-mono text-xs text-ink/70">
          {log.length === 0 && <li className="text-ink/40">Nothing yet.</li>}
          {log.map((line, i) => (
            <li key={`${String(i)}-${line}`}>{line}</li>
          ))}
        </ul>
        {view !== null && view.events.length > 0 && (
          <ul className="mt-3 space-y-0.5 border-t border-rule pt-3 font-mono text-xs text-ink/50">
            {view.events.map((e) => (
              <li key={e.id}>
                #{e.seq} {e.type} ({e.subjectKey})
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
