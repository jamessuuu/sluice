/**
 * @jamessuuu/sluice-store-postgres — Drizzle/Neon store adapter for sluice.
 * See docs/SPEC.md §3 (schema) and §5 (store contract). M6: full
 * `SluiceStore` implementation, forward-only migrations, `db:migrate` /
 * `db:seed`, conformance-tested against pglite locally and `postgres:17` in
 * CI (SPEC §8).
 */

export const SLUICE_STORE_POSTGRES_VERSION = "0.1.0-alpha.0";

export { createPostgresStore, type AnyPgDatabase } from "./store.js";
export * as schema from "./schema.js";
