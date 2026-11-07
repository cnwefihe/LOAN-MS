/** Version updates: ordering, validation, permissions and staff notification. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-releases-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { currentVersion, isLater, publishRelease, listReleases } from "@/server/services/releases";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("version updates", () => {
  it("compares versions numerically", () => {
    expect(isLater("1.10", "1.9")).toBe(true);
    expect(isLater("1.1", "1.1.0")).toBe(false);
    expect(isLater("2.0", "1.99.9")).toBe(true);
  });

  it("starts every installation at version 1.0, once", async () => {
    await seedBase(db);
    expect(await currentVersion(db)).toBe("1.0");
    expect(await listReleases(db)).toHaveLength(1);
  });

  it("only administrators publish, versions must move forward, and all active staff are notified in-app", async () => {
    await expect(publishRelease(db, await actor("accounts"), { version: "1.1", title: "x", notes: "Something changed." })).rejects.toThrow(/not authorised/);
    const admin = await actor("admin");
    await expect(publishRelease(db, admin, { version: "one", title: "Bad", notes: "Something changed." })).rejects.toThrow(/numbers/);
    await expect(publishRelease(db, admin, { version: "1.0", title: "Same", notes: "Something changed." })).rejects.toThrow(/later than the current version/);
    const r = await publishRelease(db, admin, { version: "v1.1", title: "Reports", notes: "Paginated lists.\nNew reports." });
    expect(r.release.version).toBe("1.1");
    expect(await currentVersion(db)).toBe("1.1");
    const active = await db.select().from(s.users).where(eq(s.users.isActive, true));
    const notes = await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "system.release"));
    expect(notes).toHaveLength(active.length);
    expect(notes[0]).toMatchObject({ title: "Version 1.1: Reports", link: "/whats-new" });
    const audit = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "release.published"));
    expect(audit).toHaveLength(1);
  });
});
