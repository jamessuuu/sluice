/**
 * A small, deterministic hash-chained audit trail for /audit (SPEC §9). Built
 * with the REAL core + MemoryStore + a VirtualClock (fixed start time, no
 * wall-clock dependency) — so the fixture is reproducible run to run, and so
 * "Verify chain" is checking an actual chain sluice produced, not a
 * hand-written stand-in for one.
 */
import { createSluice, MemoryStore, type AuditEvent } from "@jamessuuu/sluice";
import { VirtualClock } from "@jamessuuu/sluice-testkit";

const NAMESPACE = "audit-demo";
const START_MS = 1_700_000_000_000;

export async function buildFixtureEvents(): Promise<AuditEvent[]> {
  const clock = new VirtualClock(START_MS);
  const store = new MemoryStore();
  const sluice = createSluice({
    store,
    namespace: NAMESPACE,
    owner: "demo-worker",
    clock,
    random: () => 0.42,
  });

  await sluice.run({ key: "send-welcome-email", fingerprint: { to: "new-user@example.com" } }, () =>
    Promise.resolve({ messageId: "m-1" })
  );
  await clock.advance(4_000);

  await sluice.run({ key: "charge-card-inv-1029", fingerprint: { amountCents: 4200 } }, () =>
    Promise.resolve({ chargeId: "ch_1" })
  );
  await clock.advance(9_000);

  // A duplicate delivery of the same intent — replays instead of charging twice.
  await sluice.run({ key: "charge-card-inv-1029", fingerprint: { amountCents: 4200 } }, () =>
    Promise.resolve({ chargeId: "ch_1" })
  );
  await clock.advance(2_000);

  const gate = await sluice.gates.open({
    key: "publish-release-notes",
    action: { kind: "publish", tool: "publish_post", args: { slug: "v1-0" } },
    presentation: { title: "Publish v1.0 release notes?" },
    requester: { actor: "agent" },
    timeoutMs: 60_000,
  });
  await clock.advance(1_000);
  await sluice.gates.decide({ id: gate.id, decision: "approve", decidedBy: "reviewer" });

  return store.readEvents(NAMESPACE, 0, 1_000);
}
