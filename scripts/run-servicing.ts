/** Daily servicing job (schedule via cron / Azure WebJob / Container Apps job): statuses, reminders, email dispatch. */
import "./env";
import { createDatabase } from "../src/db/connect";

async function main() {
  const db = await createDatabase({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite", autoMigrate: false });
  (globalThis as { __pauDb?: { db?: Promise<unknown> } }).__pauDb = { db: Promise.resolve(db) };
  const { runServicing } = await import("../src/server/services/loans");
  const { processOutbox } = await import("../src/server/email");
  const result = await runServicing(db, null);
  console.log(JSON.stringify(result, null, 2));
  console.log("Email outbox:", await processOutbox(500));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
