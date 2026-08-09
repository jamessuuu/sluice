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
    <div className="overflow-x-auto border border-rule">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-rule bg-ink/5">
            <th className="px-3 py-2 font-semibold text-ink">#</th>
            <th className="px-3 py-2 font-semibold text-ink">fault</th>
            <th className="px-3 py-2 font-semibold text-ink">contract</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.id} className="border-t border-rule align-top">
              <td className="px-3 py-2 font-mono text-ink/60">{r.id}</td>
              <td className="px-3 py-2 text-ink/90">{r.fault}</td>
              <td className="px-3 py-2 text-ink/80">{r.contract}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
