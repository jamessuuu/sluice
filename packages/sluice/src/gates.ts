/**
 * Gate state machine (SPEC §3 sluice_gate + §5 gates API): durable human
 * approval that survives a process crash. Opening is idempotent on
 * (namespace, key); deciding is conditional first-writer-wins; timeouts
 * resolve lazily on ANY read and via sweepTimeouts (F12); resumption is a
 * leased claimDecided (F5); tokens are single-use HMAC-SHA256 (auth model).
 */
import { base64urlDecode, base64urlEncode, hmacSha256Hex, timingSafeEqualHex, utf8Decode } from "./hmac.js";
import { canonicalJson } from "./json.js";
import { sha256Hex } from "./sha256.js";
import { uuidv7 } from "./uuid.js";
import {
  SluiceError,
  type AuditEvent,
  type AuditInput,
  type Clock,
  type GateClaim,
  type GateRecord,
  type GateSpec,
  type SluiceStore,
} from "./types.js";

const MAX_KEY_LENGTH = 200;
/** SPEC §3: resume_context ≤ 32 KiB. */
const MAX_RESUME_CONTEXT_BYTES = 32 * 1024;
/** waitFor poll backoff: 1s → ×1.5 → cap 60s (SPEC §5 resumption delivery). */
const POLL_INITIAL_MS = 1_000;
const POLL_FACTOR = 1.5;
const POLL_CAP_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 10;

export interface GatesApi {
  open(spec: GateSpec): Promise<GateRecord>;
  get(id: string): Promise<GateRecord | null>;
  waitFor(
    id: string,
    o?: { maxWaitMs?: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<GateRecord>;
  decide(i: {
    id: string;
    decision: "approve" | "reject";
    decidedBy: string;
    reason?: string;
    token?: string;
  }): Promise<GateRecord>;
  cancel(id: string, by: string, reason?: string): Promise<GateRecord>;
  mintToken(id: string, o?: { ttlMs?: number }): string;
  pending(q?: { namespace?: string; limit?: number }): Promise<GateRecord[]>;
  claimDecided(o?: { leaseMs?: number; limit?: number }): Promise<GateClaim[]>;
  sweepTimeouts(now?: number): Promise<number>;
}

export interface GatesDeps {
  store: SluiceStore;
  namespace: string;
  owner: string;
  clock: Clock;
  random: () => number;
  approvalSecret: string | undefined;
  emit: (e: AuditInput) => Promise<AuditEvent>;
}

export function createGates(deps: GatesDeps): GatesApi {
  const { store, namespace, owner, clock, random, approvalSecret, emit } = deps;

  function wrapStore(cause: unknown, message: string): SluiceError {
    if (cause instanceof SluiceError) return cause;
    return new SluiceError("E_STORE", message, { retryable: true, cause });
  }

  /**
   * F12: sweepTimeouts AND any read of an expired gate resolve it, applying
   * onTimeout (default 'reject', fail closed). The resolver emits the events.
   */
  async function sweepTimeouts(now?: number): Promise<number> {
    let transitioned: GateRecord[];
    try {
      transitioned = await store.expireGates(now ?? clock.now());
    } catch (cause) {
      throw wrapStore(cause, "expireGates failed");
    }
    for (const gate of transitioned) {
      await emit({
        namespace: gate.namespace,
        subjectType: "gate",
        subjectKey: gate.key,
        type: "gate.timed_out",
        data: { id: gate.id, onTimeout: gate.onTimeout, resolvedTo: gate.status },
      });
    }
    return transitioned.length;
  }

  /** Lazy timeout resolution on read. */
  async function resolveIfExpired(record: GateRecord): Promise<GateRecord> {
    if (record.status !== "pending" || record.expiresAt > clock.now()) return record;
    await sweepTimeouts();
    const fresh = await store.readGate(record.id).catch((cause: unknown) => {
      throw wrapStore(cause, "readGate failed");
    });
    return fresh ?? record;
  }

  async function open(spec: GateSpec): Promise<GateRecord> {
    if (spec.key.length === 0 || spec.key.length > MAX_KEY_LENGTH) {
      throw new SluiceError("E_CONFIG", `gate key must be 1..${String(MAX_KEY_LENGTH)} chars`, {
        context: { keyLength: spec.key.length },
      });
    }
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
      throw new SluiceError("E_CONFIG", "timeoutMs is required — there is no unbounded gate", {
        context: { key: spec.key },
      });
    }
    const resumeContext = spec.resumeContext ?? null;
    if (resumeContext !== null) {
      const size = utf8Length(canonicalJson(resumeContext));
      if (size > MAX_RESUME_CONTEXT_BYTES) {
        throw new SluiceError(
          "E_RESULT_TOO_LARGE",
          `resumeContext is ${String(size)} bytes; the limit is 32 KiB`,
          { context: { key: spec.key, size, limit: MAX_RESUME_CONTEXT_BYTES } }
        );
      }
    }
    const ns = spec.namespace ?? namespace;
    const now = clock.now();
    const candidate: GateRecord = {
      id: uuidv7(now, random),
      namespace: ns,
      key: spec.key,
      status: "pending",
      action: spec.action,
      presentation: spec.presentation ?? null,
      requester: { actor: spec.requester.actor, runId: spec.requester.runId ?? null },
      approvers: spec.approvers ?? [],
      onTimeout: spec.onTimeout ?? "reject",
      resumeContext,
      createdAt: now,
      expiresAt: now + spec.timeoutMs,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      tokenHash: null,
      tokenNonce: null,
      claimOwner: null,
      claimExpiresAt: null,
      processedAt: null,
    };
    let opened;
    try {
      opened = await store.openGate(candidate);
    } catch (cause) {
      throw wrapStore(cause, "openGate failed");
    }
    if (opened.created) {
      await emit({
        namespace: ns,
        subjectType: "gate",
        subjectKey: spec.key,
        type: "gate.opened",
        actor: spec.requester.actor,
        data: { id: opened.record.id, timeoutMs: spec.timeoutMs, kind: spec.action.kind },
      });
      return opened.record;
    }
    // Idempotent open — and an idempotent open of an expired gate is a read,
    // so it resolves the timeout (F12).
    return resolveIfExpired(opened.record);
  }

  async function get(id: string): Promise<GateRecord | null> {
    const record = await store.readGate(id).catch((cause: unknown) => {
      throw wrapStore(cause, "readGate failed");
    });
    if (record === null) return null;
    return resolveIfExpired(record);
  }

  async function waitFor(
    id: string,
    o?: { maxWaitMs?: number; pollMs?: number; signal?: AbortSignal }
  ): Promise<GateRecord> {
    const startedAt = clock.now();
    const maxWaitMs = o?.maxWaitMs;
    let pollMs = o?.pollMs ?? POLL_INITIAL_MS;
    for (;;) {
      const record = await get(id);
      if (record === null) {
        throw new SluiceError("E_CONFIG", "unknown gate id", { context: { id } });
      }
      if (record.status !== "pending") return record;
      const elapsed = clock.now() - startedAt;
      if (maxWaitMs !== undefined && elapsed >= maxWaitMs) {
        throw new SluiceError("E_WAIT_TIMEOUT", "gate is still pending after maxWaitMs", {
          retryable: true,
          context: { id, maxWaitMs },
        });
      }
      // Never sleep past the wait budget — the timeout fires at maxWaitMs,
      // not at the next backoff boundary.
      const sleepMs =
        maxWaitMs === undefined ? pollMs : Math.min(pollMs, Math.max(1, maxWaitMs - elapsed));
      await clock.sleep(sleepMs, o?.signal);
      pollMs = Math.min(POLL_CAP_MS, pollMs * POLL_FACTOR);
    }
  }

  async function applyDecision(
    id: string,
    status: "approved" | "rejected" | "cancelled",
    decidedBy: string,
    reason: string | null,
    token: { hash: string; nonce: string } | null
  ): Promise<GateRecord> {
    // Read first: an expired-pending gate must resolve to its timeout BEFORE
    // a decision can be attempted against it (F12 beats a late decision).
    const current = await get(id);
    if (current === null) {
      throw new SluiceError("E_CONFIG", "unknown gate id", { context: { id } });
    }
    let result;
    try {
      result = await store.decideGate({
        id,
        status,
        decidedBy,
        reason,
        tokenHash: token === null ? null : token.hash,
        tokenNonce: token === null ? null : token.nonce,
        now: clock.now(),
      });
    } catch (cause) {
      throw wrapStore(cause, "decideGate failed");
    }
    const record = result.record ?? current;
    // F6: audit records BOTH attempts — the applied one and the loser.
    await emit({
      namespace: record.namespace,
      subjectType: "gate",
      subjectKey: record.key,
      type: "gate.decided",
      actor: decidedBy,
      data: {
        id,
        requested: status,
        applied: result.applied,
        decidedBy: record.decidedBy,
        recordedStatus: record.status,
        ...(token === null ? {} : { viaToken: true }),
      },
    });
    // Second decide returns the recorded decision — idempotent, not an error.
    return record;
  }

  async function decide(i: {
    id: string;
    decision: "approve" | "reject";
    decidedBy: string;
    reason?: string;
    token?: string;
  }): Promise<GateRecord> {
    let tokenFields: { hash: string; nonce: string } | null = null;
    if (i.token !== undefined) {
      const verified = verifyToken(i.token, approvalSecret, clock.now());
      if (verified.gateId !== i.id) {
        throw new SluiceError("E_BAD_TOKEN", "approval token does not match this gate", {
          context: { id: i.id },
        });
      }
      tokenFields = { hash: sha256Hex(i.token), nonce: verified.nonce };
    }
    return applyDecision(
      i.id,
      i.decision === "approve" ? "approved" : "rejected",
      i.decidedBy,
      i.reason ?? null,
      tokenFields
    );
  }

  function mintToken(id: string, o?: { ttlMs?: number }): string {
    if (approvalSecret === undefined) {
      throw new SluiceError("E_CONFIG", "approvalSecret is required to mint approval tokens", {
        context: { id },
      });
    }
    const exp = clock.now() + (o?.ttlMs ?? DEFAULT_TOKEN_TTL_MS);
    let nonce = "";
    for (let i = 0; i < 8; i++) {
      nonce += (Math.floor(random() * 0x10000) & 0xffff).toString(16).padStart(4, "0");
    }
    const payload = base64urlEncode(`${id}.${String(exp)}.${nonce}`);
    const mac = hmacSha256Hex(approvalSecret, payload);
    return `${payload}.${mac}`;
  }

  async function claimDecided(o?: { leaseMs?: number; limit?: number }): Promise<GateClaim[]> {
    let claimed: GateRecord[];
    try {
      claimed = await store.claimDecidedGates({
        owner,
        leaseMs: o?.leaseMs ?? DEFAULT_CLAIM_LEASE_MS,
        limit: o?.limit ?? DEFAULT_CLAIM_LIMIT,
        now: clock.now(),
      });
    } catch (cause) {
      throw wrapStore(cause, "claimDecidedGates failed");
    }
    const claims: GateClaim[] = [];
    for (const gate of claimed) {
      await emit({
        namespace: gate.namespace,
        subjectType: "gate",
        subjectKey: gate.key,
        type: "gate.claimed",
        data: { id: gate.id, status: gate.status, claimOwner: owner },
      });
      claims.push({
        gate,
        ack: async () => {
          const ok = await store
            .ackGate({ id: gate.id, owner, now: clock.now() })
            .catch((cause: unknown) => {
              throw wrapStore(cause, "ackGate failed");
            });
          if (!ok) {
            throw new SluiceError("E_LEASE_LOST", "gate claim no longer held", {
              context: { id: gate.id },
            });
          }
          await emit({
            namespace: gate.namespace,
            subjectType: "gate",
            subjectKey: gate.key,
            type: "gate.resumed",
            data: { id: gate.id, status: gate.status },
          });
        },
      });
    }
    return claims;
  }

  return {
    open,
    get,
    waitFor,
    decide,
    cancel: (id, by, reason) => applyDecision(id, "cancelled", by, reason ?? null, null),
    mintToken,
    pending: async (q) => {
      await sweepTimeouts(); // a listing is a read — expired gates resolve first
      return store
        .listGates({
          namespace: q?.namespace ?? namespace,
          status: "pending",
          ...(q?.limit === undefined ? {} : { limit: q.limit }),
        })
        .catch((cause: unknown) => {
          throw wrapStore(cause, "listGates failed");
        });
    },
    claimDecided,
    sweepTimeouts,
  };
}

/**
 * Verify `base64url(gateId.exp.nonce).mac` (SPEC §5 auth model): timing-safe
 * MAC comparison first, then expiry. E_BAD_TOKEN on ANY mismatch — the error
 * never says which check failed.
 */
export function verifyToken(
  token: string,
  approvalSecret: string | undefined,
  now: number
): { gateId: string; exp: number; nonce: string } {
  if (approvalSecret === undefined) {
    throw new SluiceError("E_CONFIG", "approvalSecret is required to verify approval tokens");
  }
  const bad = (): SluiceError => new SluiceError("E_BAD_TOKEN", "approval token is invalid");
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) throw bad();
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqualHex(hmacSha256Hex(approvalSecret, payload), mac)) throw bad();
  const decoded = base64urlDecode(payload);
  if (decoded === null) throw bad();
  const text = utf8Decode(decoded);
  const parts = text.split(".");
  if (parts.length !== 3) throw bad();
  const [gateId, expStr, nonce] = parts;
  if (gateId === undefined || gateId.length === 0 || nonce === undefined || nonce.length === 0) {
    throw bad();
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) throw bad();
  if (exp < now) throw bad();
  return { gateId, exp, nonce };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
