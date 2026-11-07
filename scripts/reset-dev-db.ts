/** Delete the local PGlite database and document store, then re-create with base data + fixtures. Development only. */
import "./env";
import fs from "node:fs";
import { execSync } from "node:child_process";

if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL) {
  console.error("db:reset only works on the embedded development database.");
  process.exit(1);
}
fs.rmSync(".data/pglite", { recursive: true, force: true });
fs.rmSync("storage", { recursive: true, force: true });
execSync("npx tsx scripts/seed.ts --fixtures", { stdio: "inherit" });
execSync("npx tsx scripts/open-sample-products.ts", { stdio: "inherit" });
