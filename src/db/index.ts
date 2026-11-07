import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { createDatabase } from "./connect";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type Executor = Database;

type Holder = { db?: Promise<Database> };
const g = globalThis as unknown as { __pauDb?: Holder };
const holder: Holder = (g.__pauDb ??= {});

/**
 * Single shared connection per server process (survives Next.js dev hot reloads).
 * Production: PostgreSQL via DATABASE_URL. Development without DATABASE_URL: embedded PGlite.
 */
export function getDb(): Promise<Database> {
  holder.db ??= createDatabase({
    databaseUrl: process.env.DATABASE_URL,
    pgliteDir: process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite"),
    autoMigrate: process.env.DATABASE_URL ? process.env.DB_AUTO_MIGRATE === "true" : true,
  }).catch((err) => {
    holder.db = undefined;
    throw err;
  });
  return holder.db;
}

export { schema };
