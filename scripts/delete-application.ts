/**
 * Remove an application entered for testing, and everything recorded about it, by its reference:
 *   node scripts/delete-application.cjs LMS-261108-001            (shows what would be removed)
 *   node scripts/delete-application.cjs LMS-261108-001 --confirm  (removes it)
 * See src/server/services/cleanup.ts.
 */
import "./env";
import { createDatabase } from "../src/db/connect";
import { removeTestApplication } from "../src/server/services/cleanup";

async function main() {
  const [reference, flag] = process.argv.slice(2);
  if (!reference) throw new Error("Usage: delete-application <reference> [--confirm]");
  const confirm = flag === "--confirm";
  const db = await createDatabase({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite", autoMigrate: false });
  const counts = await removeTestApplication(db, reference, { confirm });
  console.log(reference);
  for (const [label, n] of counts) console.log(`  ${label}: ${n}`);
  console.log(confirm ? "Removed." : "Nothing removed. Run again with --confirm to remove it.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
