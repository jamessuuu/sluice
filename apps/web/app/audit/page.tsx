"use client";

import { useCallback, useEffect, useState } from "react";
import { verifyEvents, type AuditEvent, type VerifyEventsResult } from "@jamessuuu/sluice";
import { buildFixtureEvents } from "@/lib/audit/fixture";

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [result, setResult] = useState<VerifyEventsResult | null>(null);
  const [tampered, setTampered] = useState(false);

  const load = useCallback(() => {
    setResult(null);
    setTampered(false);
    void buildFixtureEvents().then(setEvents);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const verify = useCallback(() => {
    if (events === null) return;
    // The whole point: this recomputes the chain IN THE BROWSER, from
    // nothing but the exported events — no store, no server, no network.
    setResult(verifyEvents(events));
  }, [events]);

  const tamper = useCallback(() => {
    if (events === null || events.length === 0) return;
    const idx = Math.min(2, events.length - 1);
    const target = events[idx];
    if (target === undefined) return;
    const next = [...events];
    // Flip one byte's worth of content: the event's recorded `data` no
    // longer matches what was hashed at append time. hash/prevHash are left
    // untouched — that's the point (a storage-layer edit wouldn't touch
    // them either).
    next[idx] = { ...target, data: { ...target.data, tampered: true } };
    setEvents(next);
    setTampered(true);
    setResult(null);
  }, [events]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight text-ink">Audit trail</h1>
      <p className="mb-8 max-w-2xl text-sm leading-6 text-ink-2">
        A fixture trail from the real core — hash-chained the same way{" "}
        <code className="font-mono">sluice-store-postgres</code> chains it in SQL. &quot;Verify
        chain&quot; recomputes every hash in this browser tab with the pure, store-free{" "}
        <code className="font-mono">verifyEvents()</code> export. &quot;Tamper&quot; flips one
        event&apos;s content and shows exactly where the chain breaks.
      </p>

      <div className="mb-6 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="verify-button"
          onClick={verify}
          disabled={events === null}
          className="border border-signal bg-signal px-5 py-2 text-sm font-semibold text-sub-2 hover:bg-signal-ink disabled:opacity-50"
        >
          Verify chain
        </button>
        <button
          type="button"
          data-testid="tamper-button"
          onClick={tamper}
          disabled={events === null || tampered}
          className="border border-fail px-5 py-2 text-sm font-semibold text-fail-ink hover:bg-sub-3 disabled:opacity-50"
        >
          Tamper
        </button>
        <button
          type="button"
          onClick={load}
          className="border border-edge-lo px-5 py-2 text-sm text-ink-3 hover:border-signal hover:text-ink"
        >
          Reset fixture
        </button>
      </div>

      {result !== null && (
        <p
          data-testid="verify-result"
          role="status"
          className={`mb-6 border px-4 py-2 text-sm font-semibold ${
            result.ok ? "border-edge-lo text-ink" : "border-fail text-fail-ink"
          }`}
        >
          {result.ok
            ? `✓ chain verifies clean — ${String(result.checked)} events checked.`
            : `✕ chain broken at index ${String(result.brokenAt ?? -1)} (checked ${String(result.checked)} before the break).`}
        </p>
      )}

      <div className="overflow-x-auto border border-edge-lo">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-edge-lo bg-sub-3">
              <th className="px-3 py-2 font-semibold text-ink">seq</th>
              <th className="px-3 py-2 font-semibold text-ink">type</th>
              <th className="px-3 py-2 font-semibold text-ink">subject</th>
              <th className="px-3 py-2 font-semibold text-ink">prevHash</th>
              <th className="px-3 py-2 font-semibold text-ink">hash</th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((e, i) => {
              const broken = result !== null && !result.ok && result.brokenAt === i;
              return (
                <tr
                  key={e.id}
                  data-testid="audit-row"
                  data-broken={broken}
                  className={`border-t border-edge-lo font-mono ${broken ? "bg-sub-3" : ""}`}
                >
                  <td className="px-3 py-1.5 text-ink-2">{e.seq}</td>
                  <td className="px-3 py-1.5 text-ink">{e.type}</td>
                  <td className="px-3 py-1.5 text-ink-2">{e.subjectKey}</td>
                  <td className="px-3 py-1.5 text-ink-3">{shortHash(e.prevHash)}</td>
                  <td className={`px-3 py-1.5 ${broken ? "text-fail-ink" : "text-ink-3"}`}>
                    {shortHash(e.hash)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function shortHash(h: string | null): string {
  if (h === null) return "∅ (genesis)";
  return `${h.slice(0, 10)}…`;
}
