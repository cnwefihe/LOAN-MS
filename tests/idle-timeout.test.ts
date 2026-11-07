/** Inactivity sign-out: one limit for all users, a separate one for administrators. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-idle-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { updateSettingsGroup } from "@/server/services/admin";
import { idleMinutesFor } from "@/server/settings";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const limit = async (k: string) => idleMinutesFor(db, (await actor(k)).roles);
const save = async (values: Record<string, number>) => updateSettingsGroup(db, await actor("admin"), "Security", values, true);

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await tx.insert(s.systemSettings).values({ key: "security.sessionIdleMinutes", value: 30 as never });
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("inactivity sign-out", () => {
  it("starts at 10 minutes for everyone and retires the old single setting", async () => {
    const roleKeys = Object.keys(ids).filter((k) => k !== "admin");
    expect(roleKeys.length).toBeGreaterThan(3);
    for (const k of [...roleKeys, "admin"]) expect(await limit(k)).toBe(10);
    expect(await db.select().from(s.systemSettings).where(eq(s.systemSettings.key, "security.sessionIdleMinutes"))).toHaveLength(0);
  });

  it("lets administrators keep their own time without changing anyone else's", async () => {
    await save({ "security.idleMinutesAdmin": 30 });
    expect(await limit("admin")).toBe(30);
    for (const k of Object.keys(ids).filter((x) => x !== "admin")) expect(await limit(k)).toBe(10);
  });

  it("applies the users' time to every user but not to administrators", async () => {
    await save({ "security.idleMinutesUsers": 5 });
    expect(await limit("admin")).toBe(30);
    for (const k of Object.keys(ids).filter((x) => x !== "admin")) expect(await limit(k)).toBe(5);
  });

  it("offers 5 minutes to 4 hours and refuses anything else", async () => {
    await save({ "security.idleMinutesAdmin": 60 });
    expect(await limit("admin")).toBe(60);
    await expect(save({ "security.idleMinutesAdmin": 7 })).rejects.toThrow(/listed times/);
    await expect(save({ "security.idleMinutesUsers": 1 })).rejects.toThrow(/listed times/);
  });
});
