/**
 * The administrator can delete what is still in use (a department, school, staff category or custom role),
 * but only with their two-step verification code. Without it they are told what is using it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-override-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { createRole, deleteOrgItem, deleteRole, setUserRole } from "@/server/services/admin";
import { encryptString } from "@/lib/security/crypto";
import { base32Encode, totp } from "@/lib/security/totp";

let db: Database;
let admin: Actor;
const secret = base32Encode(Buffer.from("override-test-secret-0123456789"));

beforeAll(async () => {
  db = await getDb();
  let adminId = "";
  await db.transaction(async (tx) => { await seedBase(tx); adminId = (await seedFixtures(tx)).ids.admin; });
  await db.update(s.users).set({ mfaSecret: encryptString(secret), mfaEnabledAt: new Date() }).where(eq(s.users.id, adminId));
  admin = (await loadActor(db, adminId))!;
});

describe("deleting what is still in use", () => {
  it("a department with staff: refused without a code, a wrong code fails, the right code deletes it and clears their department", async () => {
    const [dept] = await db.insert(s.departments).values({ code: "GOO", name: "Good" }).returning();
    const [someone] = await db.select().from(s.staffProfiles).limit(1);
    await db.update(s.staffProfiles).set({ departmentId: dept.id }).where(eq(s.staffProfiles.userId, someone.userId));

    await expect(deleteOrgItem(db, admin, "department", dept.id)).rejects.toThrow(/Good still has 1 staff record\. To delete it anyway, open it and enter your two-step verification code/);
    await expect(deleteOrgItem(db, admin, "department", dept.id, "000000")).rejects.toThrow(/not correct/);
    await deleteOrgItem(db, admin, "department", dept.id, totp(secret));
    expect(await db.select().from(s.departments).where(eq(s.departments.id, dept.id))).toHaveLength(0);
    expect((await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, someone.userId)))[0].departmentId).toBeNull();
  });

  it("a school with departments, and an unused category, delete as expected", async () => {
    const [school] = await db.insert(s.schools).values({ code: "SCX", name: "School X" }).returning();
    const [dept] = await db.insert(s.departments).values({ code: "DX1", name: "Dept X", schoolId: school.id }).returning();
    await expect(deleteOrgItem(db, admin, "school", school.id)).rejects.toThrow(/two-step verification code/);
    await deleteOrgItem(db, admin, "school", school.id, totp(secret));
    expect((await db.select().from(s.departments).where(eq(s.departments.id, dept.id)))[0].schoolId).toBeNull();
    const [cat] = await db.insert(s.staffCategories).values({ code: "CX", name: "Category X" }).returning();
    await deleteOrgItem(db, admin, "category", cat.id); // unused: no code needed
    expect(await db.select().from(s.staffCategories).where(eq(s.staffCategories.id, cat.id))).toHaveLength(0);
  });

  it("a custom role someone holds: deleted with the code and taken from them; built-in roles stay", async () => {
    const role = await createRole(db, admin, { name: "Temporary checker", description: "Test" });
    const [person] = await db.select().from(s.users).where(eq(s.users.isDevFixture, true)).limit(1);
    await setUserRole(db, admin, person.id, role.code as never, true);
    await expect(deleteRole(db, admin, role.id)).rejects.toThrow(/1 person holds this role/);
    await deleteRole(db, admin, role.id, totp(secret));
    expect(await db.select().from(s.roles).where(eq(s.roles.id, role.id))).toHaveLength(0);
    expect(await db.select().from(s.userRoles).where(and(eq(s.userRoles.userId, person.id), eq(s.userRoles.roleId, role.id)))).toHaveLength(0);
    const [builtIn] = await db.select().from(s.roles).where(eq(s.roles.code, "HR_ADMIN"));
    await expect(deleteRole(db, admin, builtIn.id, totp(secret))).rejects.toThrow(/Built-in roles/);
  });
});
