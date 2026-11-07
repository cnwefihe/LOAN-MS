/**
 * Set one system setting from the command line (development and test set-up only):
 *   npx tsx scripts/set-setting.ts security.mfaRequired true
 * In normal use, settings are changed by an administrator under Admin > Settings, which is audited.
 */
import "./env";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/connect";
import { systemSettings } from "../src/db/schema";
import { SETTINGS, type SettingKey } from "../src/server/settings";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Use Admin > Settings in production.");
  const [key, raw] = process.argv.slice(2) as [SettingKey, string];
  const def = SETTINGS[key];
  if (!def || raw === undefined) throw new Error("Usage: set-setting.ts <key> <value>");
  const value = def.schema.parse(raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? Number(raw) : raw);
  const db = await createDatabase({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite", autoMigrate: true });
  await db.update(systemSettings).set({ value: value as never }).where(eq(systemSettings.key, key));
  console.log(`${key} = ${JSON.stringify(value)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
