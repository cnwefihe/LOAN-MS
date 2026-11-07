/**
 * Connection factory shared by the web app, CLI scripts and tests (no "server-only" import here
 * so that tsx scripts and Vitest can use it).
 */
import path from "node:path";
import fs from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface ConnectOptions {
  databaseUrl?: string;
  /** Directory for embedded PGlite; "memory://" for an in-memory database (tests). */
  pgliteDir?: string;
  autoMigrate?: boolean;
}

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export async function createDatabase(opts: ConnectOptions): Promise<Database> {
  if (opts.databaseUrl) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({
      connectionString: opts.databaseUrl,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === "disable" ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" },
    });
    const db = drizzle(pool, { schema }) as unknown as Database;
    if (opts.autoMigrate) {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    }
    return db;
  }

  if (process.env.NODE_ENV === "production" && process.env.ALLOW_EMBEDDED_DB !== "true") {
    throw new Error("DATABASE_URL is required in production. The embedded PGlite database is for development and tests only.");
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dir = opts.pgliteDir ?? "memory://";
  if (!dir.startsWith("memory://")) fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Database;
  if (opts.autoMigrate !== false) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  return db;
}
