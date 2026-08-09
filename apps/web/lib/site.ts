// Shared site-level constants used by both app/layout.tsx (metadata) and
// app/manifest.ts (PWA manifest). Layout.tsx cannot export this itself —
// Next.js App Router only permits a fixed set of named exports from a
// layout/page file, and an extra export like this fails the generated
// route-type check (`.next/types/app/layout.ts`).
export const SITE_TITLE = "sluice — exactly-once side effects for agent tool calls";
export const SITE_DESCRIPTION =
  "Idempotent execution, retries with a circuit breaker, durable human approval gates, and a tamper-evident audit trail. Zero runtime dependencies. Proven by a deterministic chaos harness.";
