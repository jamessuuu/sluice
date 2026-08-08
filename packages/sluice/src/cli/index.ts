/**
 * The `sluice` CLI (SPEC §2/§10 M9): `sluice gates ls|show|approve|reject`
 * against the local ephemeral store (state-file.ts), and `sluice chaos
 * --seed <n>` (chaos-command.ts). Node-only — see eslint.config.mjs's
 * `src/cli/**` exemption. `bin/sluice.mjs` is the published entry point
 * (it carries the shebang); this module is plain, testable argv-parsing +
 * dispatch with no `process.exit` calls buried inside it (the shim owns
 * the exit code).
 */
import { gatesDecide, gatesLs, gatesShow } from "./gates-commands.js";
import { runChaosCommand } from "./chaos-command.js";
import { DEFAULT_STATE_PATH } from "./state-file.js";
import type { GateStatus } from "../types.js";

const HELP = `sluice — exactly-once side effects for agent tool calls (CLI)

Usage:
  sluice gates ls [--namespace <ns>] [--status <status>] [--state <path>]
  sluice gates show <id> [--state <path>]
  sluice gates approve <id> [--by <name>] [--reason <text>] [--state <path>]
  sluice gates reject <id> [--by <name>] [--reason <text>] [--state <path>]
  sluice chaos --seed <n>
  sluice --help

Notes:
  --state defaults to "${DEFAULT_STATE_PATH}" — a local JSON MemoryStore
  snapshot (SPEC §2: "the CLI's ephemeral mode"). This is for local
  dogfooding and demos, not a production Postgres connection.
`;

interface Flags {
  positionals: string[];
  options: Record<string, string>;
}

function parseArgv(argv: string[]): Flags {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

const GATE_STATUSES: readonly GateStatus[] = [
  "pending",
  "approved",
  "rejected",
  "timed_out",
  "cancelled",
];

function isGateStatus(s: string): s is GateStatus {
  return (GATE_STATUSES as readonly string[]).includes(s);
}

export async function runCli(argv: string[]): Promise<{ code: number; output: string }> {
  const { positionals, options } = parseArgv(argv);

  if (options.help !== undefined || positionals.length === 0) {
    return { code: 0, output: HELP };
  }

  const statePath = options.state ?? DEFAULT_STATE_PATH;
  const [group, sub, ...rest] = positionals;

  if (group === "gates") {
    const statusOpt = options.status;
    if (statusOpt !== undefined && !isGateStatus(statusOpt)) {
      return { code: 2, output: `unknown --status "${statusOpt}" — expected one of ${GATE_STATUSES.join(", ")}` };
    }
    const gateOpts = {
      statePath,
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      ...(statusOpt === undefined ? {} : { status: statusOpt }),
      ...(options.by === undefined ? {} : { decidedBy: options.by }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    };
    switch (sub) {
      case "ls":
        return { code: 0, output: await gatesLs(gateOpts) };
      case "show": {
        const id = rest[0];
        if (id === undefined) return { code: 2, output: "usage: sluice gates show <id>" };
        return { code: 0, output: await gatesShow(id, gateOpts) };
      }
      case "approve":
      case "reject": {
        const id = rest[0];
        if (id === undefined) return { code: 2, output: `usage: sluice gates ${sub} <id>` };
        return { code: 0, output: await gatesDecide(id, sub, gateOpts) };
      }
      default:
        return { code: 2, output: `unknown "sluice gates" subcommand: ${sub ?? "(none)"}\n\n${HELP}` };
    }
  }

  if (group === "chaos") {
    const seedRaw = options.seed;
    const seed = seedRaw === undefined ? NaN : Number(seedRaw);
    if (!Number.isFinite(seed)) {
      return { code: 2, output: "usage: sluice chaos --seed <n>" };
    }
    return runChaosCommand(seed);
  }

  return { code: 2, output: `unknown command: ${String(group)}\n\n${HELP}` };
}
