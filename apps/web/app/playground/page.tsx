"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  AuditRow,
  LedgerRow,
  PlaygroundParams,
  PlaygroundTotals,
  WorkerResponse,
} from "@/lib/playground/protocol";

const DEFAULT_PARAMS: PlaygroundParams = {
  seed: 1,
  intents: 14,
  duplicateRate: 0.6,
  timeoutRate: 0.15,
  errorRate: 0.15,
  crashEnabled: true,
};

const MAX_ROWS = 40;

export default function PlaygroundPage() {
  const [params, setParams] = useState<PlaygroundParams>(DEFAULT_PARAMS);
  const [running, setRunning] = useState(false);
  const [naiveLedger, setNaiveLedger] = useState<LedgerRow[]>([]);
  const [sluiceLedger, setSluiceLedger] = useState<LedgerRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [totals, setTotals] = useState<PlaygroundTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const run = useCallback(() => {
    setRunning(true);
    setError(null);
    setNaiveLedger([]);
    setSluiceLedger([]);
    setAudit([]);
    setTotals(null);

    workerRef.current?.terminate();
    const worker = new Worker(new URL("../../lib/playground/worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.kind === "intent") {
        setNaiveLedger((prev) => [...prev, ...msg.naiveLedger].slice(-MAX_ROWS));
        setSluiceLedger((prev) => [...prev, ...msg.sluiceLedger].slice(-MAX_ROWS));
        setAudit((prev) => [...prev, ...msg.auditBatch].slice(-MAX_ROWS));
      } else if (msg.kind === "done") {
        setTotals(msg.totals);
        setRunning(false);
        worker.terminate();
      } else {
        setError(msg.message);
        setRunning(false);
        worker.terminate();
      }
    };
    worker.onerror = (ev) => {
      setError(ev.message);
      setRunning(false);
      worker.terminate();
    };
    worker.postMessage({ params });
  }, [params]);

  const naiveDup = totals?.naiveDuplicates ?? 0;
  const sluiceDup = totals?.sluiceDuplicates ?? 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-ink">Playground</h1>
      <p className="mb-8 max-w-2xl text-sm leading-6 text-ink-2">
        Runs the real <code className="font-mono">@jamessuuu/sluice</code> core in a Web Worker
        against an in-memory store and a fault-injecting fake transport — the same primitives the
        chaos harness uses. Nothing here touches a server.
      </p>

      <Controls params={params} onChange={setParams} disabled={running} onRun={run} />

      {error !== null && (
        <p className="mb-6 border border-fail px-4 py-2 text-sm text-fail-ink" role="alert">
          {error}
        </p>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        <Counter
          testId="counter-naive"
          label="duplicate side effects — without sluice"
          value={naiveDup}
          tone="bad"
        />
        <Counter
          testId="counter-sluice"
          label="duplicate side effects — with sluice"
          value={sluiceDup}
          tone="good"
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Panel title="Live effect ledger">
          <LedgerTable naive={naiveLedger} sluice={sluiceLedger} />
        </Panel>
        <Panel title="Audit event stream">
          <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs text-ink-2">
            {audit.length === 0 && <li className="text-ink/40">No events yet — click Run.</li>}
            {audit
              .slice()
              .reverse()
              .map((e) => (
                <li key={e.seq} className="border-b border-edge-lo/60 py-1">
                  <span className="text-ink/40">#{e.seq}</span> {e.type}{" "}
                  <span className="text-ink-3">({e.subjectKey})</span>
                </li>
              ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Controls({
  params,
  onChange,
  disabled,
  onRun,
}: {
  params: PlaygroundParams;
  onChange: (p: PlaygroundParams) => void;
  disabled: boolean;
  onRun: () => void;
}) {
  const set = useMemo(
    () => (patch: Partial<PlaygroundParams>) => {
      onChange({ ...params, ...patch });
    },
    [params, onChange]
  );

  return (
    <div className="mb-8 grid gap-5 border border-edge-lo px-5 py-4 sm:grid-cols-2">
      <Slider
        label={`Duplicate rate — ${String(Math.round(params.duplicateRate * 100))}%`}
        value={params.duplicateRate}
        onChange={(v) => {
          set({ duplicateRate: v });
        }}
      />
      <Slider
        label={`Timeout rate — ${String(Math.round(params.timeoutRate * 100))}%`}
        value={params.timeoutRate}
        max={0.5}
        onChange={(v) => {
          set({ timeoutRate: v });
        }}
      />
      <Slider
        label={`Error rate — ${String(Math.round(params.errorRate * 100))}%`}
        value={params.errorRate}
        max={0.5}
        onChange={(v) => {
          set({ errorRate: v });
        }}
      />
      <div className="flex items-end justify-between gap-4">
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={params.crashEnabled}
            onChange={(e) => {
              set({ crashEnabled: e.target.checked });
            }}
          />
          Crash toggle (simulate a crash mid-effect)
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        Seed
        <input
          type="number"
          className="w-20 border border-edge-lo bg-sub-0 px-2 py-1 font-mono text-sm"
          value={params.seed}
          onChange={(e) => {
            const n = Number(e.target.value);
            set({ seed: Number.isFinite(n) ? n : params.seed });
          }}
        />
      </label>
      <div className="flex items-end justify-end">
        <button
          type="button"
          onClick={onRun}
          disabled={disabled}
          className="border border-signal bg-signal px-5 py-2 text-sm font-semibold text-sub-2 transition hover:bg-signal-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {disabled ? "Running…" : "Run"}
        </button>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  max = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  max?: number;
}) {
  return (
    <label className="block text-sm text-ink-2">
      {label}
      <input
        type="range"
        min={0}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => {
          onChange(Number(e.target.value));
        }}
        className="mt-1 block w-full accent-amber"
      />
    </label>
  );
}

function Counter({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: number;
  tone: "good" | "bad";
  testId: string;
}) {
  return (
    <div className="border border-edge-lo px-5 py-4">
      <p className="mb-1 text-xs uppercase tracking-wide text-ink-3">{label}</p>
      <p
        data-testid={testId}
        className={`font-mono text-4xl font-semibold ${tone === "bad" ? "text-ink" : "text-fail-ink"}`}
      >
        {value}
      </p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-edge-lo px-4 py-3">
      <h2 className="mb-2 text-sm font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

function LedgerTable({ naive, sluice }: { naive: LedgerRow[]; sluice: LedgerRow[] }) {
  const rows = Math.max(naive.length, sluice.length);
  if (rows === 0) {
    return <p className="text-xs text-ink/40">No side effects yet — click Run.</p>;
  }
  const naiveTail = naive.slice(-15).reverse();
  const sluiceTail = sluice.slice(-15).reverse();
  return (
    <div className="grid grid-cols-2 gap-3 text-xs">
      <div>
        <p className="mb-1 font-semibold text-ink-3">without sluice</p>
        <ul className="max-h-72 space-y-1 overflow-y-auto font-mono text-ink-2">
          {naiveTail.map((r, i) => (
            <li key={`${r.intent}-${String(r.attempt)}-${String(i)}`}>
              {r.intent} · attempt {r.attempt}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 font-semibold text-fail-ink">with sluice</p>
        <ul className="max-h-72 space-y-1 overflow-y-auto font-mono text-ink-2">
          {sluiceTail.map((r, i) => (
            <li key={`${r.intent}-${String(r.attempt)}-${String(i)}`}>
              {r.intent} · attempt {r.attempt}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
