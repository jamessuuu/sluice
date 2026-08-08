/**
 * The /gate walkthrough's scripted scenario (SPEC §9): a "dogwatch publish"
 * opens a gate, survives the opening worker being killed, gets approved,
 * and resumes through `run()` so the guarded side effect fires exactly
 * once — no matter how many times the flow is replayed afterward. Shared
 * between the worker (which executes it) and nothing else — this file is
 * the whole scenario, kept separate from worker.ts purely so it's testable
 * without a Worker global.
 */
import { createSluice, MemoryStore, type MemoryStoreState } from "@jamessuuu/sluice";
import type { GateCommand, GateView } from "./protocol";

export const NAMESPACE = "gate-demo";
export const GATE_KEY = "publish-weekly-digest";
export const RESUME_KEY = "publish-weekly-digest-effect";

function buildSluice(state: MemoryStoreState | null, owner: string) {
  const store = new MemoryStore(state ?? undefined);
  const sluice = createSluice({ store, namespace: NAMESPACE, owner });
  return { store, sluice };
}

async function computeView(store: MemoryStore, sluice: ReturnType<typeof buildSluice>["sluice"]): Promise<GateView> {
  const gates = await sluice.gates.pending({ namespace: NAMESPACE });
  const all = await store.listGates({ namespace: NAMESPACE, limit: 10 });
  const gate = all.find((g) => g.key === GATE_KEY) ?? gates[0] ?? null;
  const events = await store.readEvents(NAMESPACE, 0, 1000);
  const publishCount = events.filter(
    (e) => e.subjectKey === RESUME_KEY && e.type === "effect.succeeded"
  ).length;
  return { gate, publishCount, events };
}

export interface ScenarioResult {
  state: MemoryStoreState;
  view: GateView;
  log: string;
}

export async function runCommand(
  command: GateCommand,
  state: MemoryStoreState | null,
  owner: string
): Promise<ScenarioResult> {
  const { store, sluice } = buildSluice(state, owner);

  let log: string;
  switch (command) {
    case "status": {
      // No mutation — this is how a real page reload re-derives what's on
      // screen: read the persisted state, don't act on it.
      log = "worker: status — read the persisted state, no action taken.";
      break;
    }
    case "open": {
      const gate = await sluice.gates.open({
        key: GATE_KEY,
        action: { kind: "publish", tool: "publish_digest", args: { digest: "weekly" } },
        presentation: {
          title: 'Publish the weekly digest?',
          summary: "Sends to the full subscriber list. Cannot be recalled once sent.",
        },
        requester: { actor: "dogwatch-agent", runId: "run_demo" },
        approvers: ["you"],
        timeoutMs: 15 * 60_000,
        onTimeout: "reject",
        resumeContext: { effectKey: RESUME_KEY },
      });
      log = `worker: opened gate "${gate.key}" (${gate.id.slice(0, 8)}…) — status ${gate.status}`;
      break;
    }
    case "approve":
    case "reject": {
      const view = await computeView(store, sluice);
      if (view.gate === null) throw new Error("no gate to decide — open one first");
      const decided = await sluice.gates.decide({
        id: view.gate.id,
        decision: command === "approve" ? "approve" : "reject",
        decidedBy: "visitor",
      });
      log = `worker: decided "${decided.key}" -> ${decided.status}`;
      break;
    }
    case "resume": {
      const claims = await sluice.gates.claimDecided({ limit: 10 });
      if (claims.length === 0) {
        log = "worker: claimDecided() returned nothing — already processed (or nothing approved yet).";
        break;
      }
      const lines: string[] = [];
      for (const claim of claims) {
        if (claim.gate.status === "approved") {
          const outcome = await sluice.run({ key: RESUME_KEY, fingerprint: { gate: claim.gate.id } }, () =>
            Promise.resolve({ published: true, at: Date.now() })
          );
          lines.push(`ran the guarded effect -> ${outcome.status}`);
        } else {
          lines.push(`gate resolved to "${claim.gate.status}" — skipping the side effect`);
        }
        await claim.ack();
      }
      log = `worker: resumed from resumeContext — ${lines.join("; ")}`;
      break;
    }
    case "replay": {
      // Prove idempotency end to end: re-open (idempotent), re-decide
      // (idempotent, first-writer-wins), re-claim (should be empty — already
      // processed), AND a direct re-run of the guarded effect (must replay,
      // never re-execute).
      const before = await computeView(store, sluice);
      if (before.gate === null) {
        log = "worker: nothing to replay — open the gate first.";
        break;
      }
      const reopened = await sluice.gates.open({
        key: GATE_KEY,
        action: { kind: "publish", tool: "publish_digest", args: { digest: "weekly" } },
        requester: { actor: "dogwatch-agent", runId: "run_demo" },
        timeoutMs: 15 * 60_000,
        resumeContext: { effectKey: RESUME_KEY },
      });
      const reclaims = await sluice.gates.claimDecided({ limit: 10 });
      let effectLine = "the gate was never approved, so no effect to replay";
      if (reopened.status === "approved") {
        const outcome = await sluice.run(
          { key: RESUME_KEY, fingerprint: { gate: reopened.id } },
          () => Promise.resolve({ published: true, at: Date.now() })
        );
        effectLine = `run() -> ${outcome.status}${outcome.status === "replayed" ? " (no new side effect)" : ""}`;
      }
      log = `worker: replay — gate re-open is idempotent (status ${reopened.status}); claimDecided() found ${String(reclaims.length)} unprocessed gate(s); ${effectLine}.`;
      break;
    }
  }

  const view = await computeView(store, sluice);
  return { state: store.exportState(), view, log };
}
