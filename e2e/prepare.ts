/** Fresh throwaway database + fixtures for the browser tests, plus one loan walked through the lifecycle. */
import fs from "node:fs";
import { execSync } from "node:child_process";

const dir = process.env.PGLITE_DIR;
if (!dir || !dir.includes("e2e")) throw new Error("e2e/prepare.ts must run with PGLITE_DIR pointing at the e2e database.");
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(process.env.STORAGE_DIR ?? ".data/e2e-storage", { recursive: true, force: true });
execSync("npx tsx scripts/seed.ts --fixtures", { stdio: "inherit", env: process.env });
execSync("npx tsx scripts/dev-walkthrough.ts", { stdio: "inherit", env: process.env });
// Two-step verification is off by default; the browser tests run with it on, as at go-live.
execSync("npx tsx scripts/set-setting.ts security.mfaRequired true", { stdio: "inherit", env: process.env });
