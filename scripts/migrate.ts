/** Apply database migrations (production: DATABASE_URL; development: embedded PGlite). */
import "./env";
import { createDatabase } from "../src/db/connect";

createDatabase({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite", autoMigrate: true })
  .then(() => {
    console.log("Migrations applied.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
