/**
 * db:migrate — apply `migrations/` to a real Postgres (set `DATABASE_URL`)
 * or, with nothing set, to a local pglite data directory. This is what makes
 * "a reviewer gets a working local instance" (SPEC §3, §12.4) true even with
 * no Docker and no network database: pglite IS Postgres (compiled to WASM),
 * not a mock of it — the same migrations, the same SQL, the same engine
 * family this package's own conformance suite runs against.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, "..", "migrations");

function redact(url: string): string {
  return url.replace(/:[^:@/]*@/, ":***@");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const db = drizzle(pool);
      console.log(`sluice-store-postgres: migrating ${redact(databaseUrl)}`);
      await migrate(db, { migrationsFolder });
      console.log("sluice-store-postgres: migrations applied.");
    } finally {
      await pool.end();
    }
    return;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dataDir = path.join(here, "..", ".pglite-data");
  const client = new PGlite(dataDir);
  try {
    const db = drizzle(client);
    console.log(
      `sluice-store-postgres: DATABASE_URL not set — migrating local pglite instance at ${dataDir}`
    );
    await migrate(db, { migrationsFolder });
    console.log(
      "sluice-store-postgres: migrations applied. Set DATABASE_URL to target a real Postgres/Neon instance instead."
    );
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
