/** The automatic loan check runs as often as the administrator sets: weekly by default, hourly at most. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-auto-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase } from "@/server/seed";
import { automaticCheckDue } from "@/server/services/loans";
import { getSetting, SETTINGS } from "@/server/settings";
import { durationText, splitMinutes } from "@/lib/duration";

let db: Database;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const ranAt = async (at: Date) => { await db.insert(s.auditLogs).values({ action: "servicing.run", entityType: "system", summary: "test", createdAt: at }); };
const setEvery = async (minutes: number) => {
  await db.insert(s.systemSettings).values({ key: "automation.checkEveryMinutes", value: minutes }).onConflictDoUpdate({ target: s.systemSettings.key, set: { value: minutes } });
};

beforeAll(async () => {
  db = await getDb();
  await db.transaction((tx) => seedBase(tx));
});

describe("automatic check interval", () => {
  it("is weekly by default, shown as 1 week, and may be set from an hour to eight weeks", async () => {
    expect(await getSetting(db, "automation.checkEveryMinutes")).toBe(10080);
    expect(durationText(10080)).toBe("1 week");
    expect(splitMinutes(2 * 10080)).toEqual({ amount: 2, unit: 10080 });
    const schema = SETTINGS["automation.checkEveryMinutes"].schema;
    expect(schema.safeParse(30).success).toBe(false);
    expect(schema.safeParse(60).success).toBe(true);
    expect(schema.safeParse(8 * 10080).success).toBe(true);
    expect(schema.safeParse(9 * 10080).success).toBe(false);
  });

  it("runs the first time, then only when the set time has passed", async () => {
    const now = new Date("2026-11-15T10:00:00Z");
    expect((await automaticCheckDue(db, now)).due).toBe(true);
    await ranAt(new Date(now.getTime() - 3 * DAY));
    expect((await automaticCheckDue(db, now)).due).toBe(false); // weekly: 3 days is too soon
    expect((await automaticCheckDue(db, new Date(now.getTime() + 4 * DAY))).due).toBe(true);
    await setEvery(1440); // daily
    expect((await automaticCheckDue(db, now)).due).toBe(true);
    await ranAt(new Date(now.getTime() - 2 * HOUR));
    expect((await automaticCheckDue(db, now)).due).toBe(false);
    await setEvery(60); // hourly; a few minutes early still counts
    expect((await automaticCheckDue(db, new Date(now.getTime() - 2 * HOUR + 56 * 60_000))).due).toBe(true);
  });
});
