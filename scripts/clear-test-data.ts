/**
 * Clear every application, loan and payment entered while testing, before the system goes into use:
 *   node scripts/clear-test-data.cjs            (shows what would be removed; nothing changes)
 *   node scripts/clear-test-data.cjs --confirm  (removes it; this cannot be undone)
 * Users, roles, departments, products, terms, settings, branding and the guarantor list are kept.
 * See src/server/services/cleanup.ts.
 */
import "./env";
import { createDatabase } from "../src/db/connect";
import { clearAllTestData } from "../src/server/services/cleanup";

async function main() {
  const confirm = process.argv.slice(2).includes("--confirm");
  const db = await createDatabase({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite", autoMigrate: false });
  const counts = await clearAllTestData(db, { confirm });
  for (const [label, n] of counts) console.log(`  ${label}: ${n}`);
  console.log(confirm ? "Removed. The next application will be numbered 001." : "Nothing removed. Run again with --confirm to remove it.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
