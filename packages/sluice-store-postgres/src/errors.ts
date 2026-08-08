/**
 * Driver-error wrapping (hard rule): a caller of `SluiceStore` must never see
 * a raw pg/pglite/Neon driver error or string — only the `types.ts` taxonomy
 * (SPEC §6). Mirrors the `wrapStoreError` pattern in `packages/sluice/src/sluice.ts`.
 */
import { SluiceError } from "@jamessuuu/sluice";

/**
 * Wrap any thrown value from a `db.execute()` call. `SluiceError`s raised
 * deliberately by the store (e.g. `E_LEASE_LOST` from a failed conditional
 * write) pass through unchanged; anything else — a driver exception, a
 * network failure, a constraint violation — becomes `E_STORE`.
 *
 * `indeterminate` matters beyond this package: `sluice.ts`'s own
 * `wrapStoreError` special-cases a store failure at the `completeEffect`
 * call sites as `{ indeterminate: true }` (F11 — "marked indeterminate:true
 * if it fails after the claim") — but ONLY when the store throws something
 * that ISN'T already a `SluiceError`; its very first check is
 * `if (cause instanceof SluiceError) return cause`, trusting a store that
 * already classified its own failure. If this store pre-wrapped every
 * driver error as `retryable:true, indeterminate:false` unconditionally,
 * core's fail-closed override would never run and a completeEffect write
 * failure — which happens strictly after the effect's side effect already
 * ran — would come back looking safely retryable. `claimEffect` (nothing
 * executed yet) correctly defaults to `indeterminate: false`; `completeEffect`
 * passes `indeterminate: true` explicitly at its one call site in store.ts.
 */
export function wrapDbError(
  cause: unknown,
  message: string,
  opts?: { indeterminate?: boolean }
): SluiceError {
  if (cause instanceof SluiceError) return cause;
  const indeterminate = opts?.indeterminate === true;
  return new SluiceError("E_STORE", message, {
    retryable: !indeterminate,
    indeterminate,
    cause,
  });
}
