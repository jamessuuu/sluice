import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSluice } from "../sluice.js";
import { MemoryStore } from "../memory-store.js";
import { saveState } from "./state-file.js";
import { runCli } from "./index.js";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sluice-cli-"));
  statePath = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sluice CLI (M9)", () => {
  it("prints help with no args or --help", async () => {
    const noArgs = await runCli([]);
    expect(noArgs.code).toBe(0);
    expect(noArgs.output).toContain("Usage:");

    const helpFlag = await runCli(["--help"]);
    expect(helpFlag.code).toBe(0);
    expect(helpFlag.output).toContain("sluice gates ls");
  });

  it("gates ls on an empty store says so", async () => {
    const result = await runCli(["gates", "ls", "--state", statePath]);
    expect(result.code).toBe(0);
    expect(result.output).toBe("no gates.");
  });

  it("gates ls / show / approve round-trip against a seeded state file", async () => {
    // Seed the state file the way a real caller's application would have
    // (createSluice + MemoryStore, exported), so this test exercises the
    // exact same MemoryStoreState the /gate demo and any real app produce.
    const store = new MemoryStore();
    const sluice = createSluice({ store, namespace: "default", owner: "seed" });
    const gate = await sluice.gates.open({
      key: "publish-x",
      action: { kind: "publish" },
      requester: { actor: "agent" },
      timeoutMs: 60_000,
    });
    saveState(statePath, store.exportState());

    const ls = await runCli(["gates", "ls", "--state", statePath]);
    expect(ls.code).toBe(0);
    expect(ls.output).toContain(gate.id);
    expect(ls.output).toContain("pending");

    const show = await runCli(["gates", "show", gate.id, "--state", statePath]);
    expect(show.code).toBe(0);
    const parsed = JSON.parse(show.output) as { id: string; status: string };
    expect(parsed.id).toBe(gate.id);
    expect(parsed.status).toBe("pending");

    const approve = await runCli(["gates", "approve", gate.id, "--by", "cli-tester", "--state", statePath]);
    expect(approve.code).toBe(0);
    expect(approve.output).toContain("approved");

    // The decision persisted across the process-boundary-like state file —
    // a fresh runCli() call rehydrates from disk exactly like a fresh CLI
    // invocation would.
    const showAgain = await runCli(["gates", "show", gate.id, "--state", statePath]);
    const parsedAgain = JSON.parse(showAgain.output) as { status: string; decidedBy: string };
    expect(parsedAgain.status).toBe("approved");
    expect(parsedAgain.decidedBy).toBe("cli-tester");
  });

  it("gates show on an unknown id reports it clearly", async () => {
    const result = await runCli(["gates", "show", "no-such-id", "--state", statePath]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("no such gate");
  });

  it("gates ls rejects an unknown --status", async () => {
    const result = await runCli(["gates", "ls", "--status", "bogus", "--state", statePath]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("unknown --status");
  });

  it("rejects an unknown top-level command", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("unknown command");
  });

  it("chaos --seed requires a numeric seed", async () => {
    const result = await runCli(["chaos"]);
    expect(result.code).toBe(2);
    expect(result.output).toContain("usage: sluice chaos --seed");
  });

  // Runs under Vitest's TypeScript-aware module loader, which correctly
  // resolves the workspace-local @jamessuuu/sluice-testkit -> src chain
  // (see chaos-command.ts's header comment on why plain Node cannot, and
  // why that's fine — it's a real-consumer-vs-monorepo-dev-loop distinction,
  // not a bug in runChaosCommand's own logic, which is exactly what this
  // test proves end to end).
  it("chaos --seed <n> runs the harness and reports 0 invariant violations", async () => {
    const result = await runCli(["chaos", "--seed", "1"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("OK — 0 invariant violations.");
  }, 20_000);
});
