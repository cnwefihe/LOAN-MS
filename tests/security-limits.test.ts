/**
 * Security limits set under Settings > Security, each kept separate: wrong two-step codes lock the account,
 * and each person may have only so many sessions at once (more for Super Administrators).
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq, isNull } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-limits-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { updateSetting } from "@/server/services/admin";
import { withCodeLock } from "@/server/code-lock";
import { DomainError } from "@/server/errors";
import { endExtraSessions } from "@/server/session-limit";
import { sha256Hex } from "@/lib/security/crypto";

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

const wrong = () => Promise.reject(new DomainError("That code is not correct.", "wrong_code"));

describe("wrong two-step codes", () => {
  it("lock the account after the number set, say how many tries are left, and a right code clears the count", async () => {
    await updateSetting(db, await actor("admin"), "security.codeFailuresMax", 3);
    const u = ids.applicant;
    await expect(withCodeLock(db, u, wrong)).rejects.toThrow(/2 tries left/);
    await expect(withCodeLock(db, u, async () => "ok")).resolves.toBe("ok"); // cleared
    await expect(withCodeLock(db, u, wrong)).rejects.toThrow(/2 tries left/);
    await expect(withCodeLock(db, u, wrong)).rejects.toThrow(/1 try left/);
    await expect(withCodeLock(db, u, wrong)).rejects.toThrow(/locked for 15 minutes/);
    // Even the right code is refused while locked.
    await expect(withCodeLock(db, u, async () => "ok")).rejects.toThrow(/locked/);
    // Other errors (not a wrong code) are not counted, and another person is not affected.
    await expect(withCodeLock(db, ids.freshapplicant, () => Promise.reject(new DomainError("No set-up is in progress.")))).rejects.toThrow(/No set-up/);
    await expect(withCodeLock(db, ids.freshapplicant, async () => "ok")).resolves.toBe("ok");
  });
});

describe("sessions at the same time", () => {
  const open = async (userId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await db.insert(s.sessions).values({ tokenHash: sha256Hex(`${userId}-${Date.now()}-${i}-${Math.random()}`), userId, authMethod: "dev_fixture", expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date(Date.now() + i) });
      await endExtraSessions(db, userId);
    }
    return db.select().from(s.sessions).where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt)));
  };

  it("one at a time for staff by default: signing in again ends the older one, marked as ended elsewhere", async () => {
    const live = await open(ids.hradmin, 3);
    expect(live).toHaveLength(1);
    const ended = await db.select().from(s.sessions).where(eq(s.sessions.userId, ids.hradmin));
    expect(ended.filter((x) => x.endedReason === "limit")).toHaveLength(2);
  });

  it("Super Administrators may have more, and both numbers are set under Settings > Security", async () => {
    expect(await open(ids.admin, 5)).toHaveLength(3);
    await updateSetting(db, await actor("admin"), "security.maxSessionsUsers", 2);
    expect(await open(ids.payroll, 4)).toHaveLength(2);
    await expect(updateSetting(db, await actor("admin"), "security.maxSessionsUsers", 50)).rejects.toThrow();
  });
});
