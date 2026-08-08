/**
 * drizzle-kit config — generates numbered, forward-only SQL under
 * `migrations/` from `src/schema.ts` (SPEC §3, §12.4). `pnpm db:generate`
 * after any schema change; never hand-edit a checked-in migration file, and
 * never drop/narrow a column (repo policy — see the schema.ts file header).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
