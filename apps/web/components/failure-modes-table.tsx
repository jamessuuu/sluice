/**
 * F1-F12, condensed. The same twelve rows as README.md's "Failure modes"
 * table and the fuller prose at /docs/failure-modes — kept to one row per
 * fault here because the landing page's job is to prove the table exists
 * and is exhaustive, not to reproduce the full doc. Every row is asserted by
 * a chaos scenario and a golden fixture, not just written down.
 */
const ROWS: { id: string; fault: string; contract: string }[] = [
  { id: "F1", fault: "Duplicate delivery (2–5×, concurrent)", contract: "Exactly one claim wins; losers replay the winner's outcome. Ledger count is 1." },
  { id: "F2", fault: "Timeout, effect landed anyway", contract: "Classified indeterminate; fails closed by default (E_INDETERMINATE), never reported as success, never auto-retried." },
  { id: "F3", fault: "Crash after the side effect, before the result was persisted", contract: "Lease expires; the next claim transitions it to indeterminate — never a silent re-claim." },
  { id: "F4", fault: "Crash before the side effect", contract: "Same indeterminate transition — indistinguishable from F3 by design; 'fail' is the default for exactly this reason." },
  { id: "F5", fault: "Crash mid-gate", contract: "The gate row is durable; resumption via claimDecided runs post-decision work through run() — exactly-once." },
  { id: "F6", fault: "Double decision / approve-reject race", contract: "First writer wins; the second call returns the recorded decision (idempotent, not an error)." },
  { id: "F7", fault: "Retry storm", contract: "Retry budget (10%) + full-jitter backoff + circuit breaker; exhaustion is an immediate E_RETRY_BUDGET." },
  { id: "F8", fault: "Clock skew between workers", contract: "No double execution within leaseMs / 2; beyond it, fails closed to indeterminate rather than risk a double execution." },
  { id: "F9", fault: "Key reuse with different arguments", contract: "fingerprint mismatch throws E_KEY_CONFLICT — never a silent wrong-result replay." },
  { id: "F10", fault: "Result too large (> maxResultBytes)", contract: "Stored as resultOmitted; the type forces every caller to handle it." },
  { id: "F11", fault: "Store unavailable", contract: "E_STORE; indeterminate if after the claim, retryable if before. The effect function never runs without a granted claim." },
  { id: "F12", fault: "Gate timeout", contract: "sweepTimeouts (and any read of an expired gate) resolves it to timed_out, applying onTimeout (default reject)." },
];

export function FailureModesTable() {
  return (
    <>
      {/* >= 600px: the table. At native mobile widths it never overflowed the
          page (it already had its own overflow-x-auto wrapper), but three
          columns of prose sharing ~270px shrank each cell to 3-6 lines of
          near-illegible text instead (ui-audit.md 2026-08-28) — technically
          contained, still unreadable. */}
      <div className="raised hidden overflow-x-auto border border-edge-lo min-[600px]:block">
        <table className="t-body-s w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-edge-lo bg-sub-3">
              <th className="t-label px-3 py-3 text-ink-3">#</th>
              <th className="t-label px-3 py-3 text-ink-3">fault</th>
              <th className="t-label px-3 py-3 text-ink-3">contract</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.id} className="border-t border-edge-lo align-top">
                <td className="t-data-s px-3 py-2 text-signal-ink">{r.id}</td>
                <td className="px-3 py-2 text-ink">{r.fault}</td>
                <td className="px-3 py-2 text-ink-2">{r.contract}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Below 600px: one card per fault, id/fault/contract stacked and free
          to wrap at full width, instead of three columns fighting for a
          viewport too narrow to hold them side by side. */}
      <dl className="raised border border-edge-lo min-[600px]:hidden">
        {ROWS.map((r) => (
          <div key={r.id} className="border-t border-edge-lo px-3 py-3 first:border-t-0">
            <dt className="t-micro mb-1 text-signal-ink">{r.id}</dt>
            <dd className="t-body-s mb-1 text-ink">{r.fault}</dd>
            <dd className="t-body-s text-ink-2">{r.contract}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
