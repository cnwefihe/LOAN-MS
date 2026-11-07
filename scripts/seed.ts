/**
 * npm run db:seed              → base reference data (roles, permissions, templates, settings, placeholder terms)
 * npm run db:seed -- --fixtures → also development fixtures (refused when NODE_ENV=production)
 */
import "./env";
import { createDatabase } from "../src/db/connect";
import { seedBase, seedFixtures } from "../src/server/seed";

async function main() {
  const db = await createDatabase({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite", autoMigrate: true });
  await db.transaction(async (tx) => {
    await seedBase(tx);
    if (process.argv.includes("--fixtures")) {
      const r = await seedFixtures(tx);
      console.log(`Development fixtures seeded (${Object.keys(r.ids).length} fixture users).`);
    }
  });
  console.log("Base reference data seeded.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
