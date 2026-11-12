/** Staff added by an administrator before first sign-in, one at a time or many at once, with department and approver. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-usersetup-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor, provisionEntraUser } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { addUser, importUsers, setUserDepartment } from "@/server/services/user-setup";

let db: Database;
const ids: Record<string, string> = {};
let admin: Actor;
let depts: (typeof s.departments.$inferSelect)[] = [];
const byEmail = async (e: string) => (await db.select().from(s.users).where(sql`lower(${s.users.email}) = ${e}`))[0];
const profile = async (id: string) => (await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, id)))[0];

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    Object.assign(ids, r.ids);
  });
  const [first] = await db.select({ userId: s.userRoles.userId }).from(s.userRoles).innerJoin(s.roles, eq(s.roles.id, s.userRoles.roleId)).where(eq(s.roles.code, "SUPER_ADMIN"));
  admin = (await loadActor(db, first.userId))!;
  depts = await db.select().from(s.departments).where(eq(s.departments.isActive, true)).orderBy(s.departments.name);
});

describe("adding users", () => {
  it("adds one person with a department and makes them its HOD", async () => {
    const d = depts[0];
    const r = await addUser(db, admin, { name: "Ngozi Eze", email: "Ngozi.Eze@example.edu.ng", departmentId: d.id, approver: "hod" });
    expect(r.created).toBe(true);
    const u = await byEmail("ngozi.eze@example.edu.ng");
    expect(u.displayName).toBe("Ngozi Eze");
    expect((await profile(u.id)).departmentId).toBe(d.id);
    const [dept] = await db.select().from(s.departments).where(eq(s.departments.id, d.id));
    expect(dept.headUserId).toBe(u.id);
    expect(dept.approverTitle).toBe("hod");
    await expect(addUser(db, admin, { name: "Someone Else", email: "someone@gmail.com" })).rejects.toThrow(/university email/);
  });

  it("adds many at once, matching departments by name or code and reading the approver", async () => {
    const [a, b] = depts;
    const r = await importUsers(db, admin, [
      "Full name, Email, Department, Role",
      `Kemi Ade, kemi.ade@example.edu.ng, ${a.name}`,
      `Musa Bala\tmusa.bala@example.edu.ng\t${b.code}\tLine Manager`,
      "Ngozi Eze; ngozi.eze@example.edu.ng",
      "No Email Here, Bursary",
      "Lost Person, lost.person@example.edu.ng, No Such Department",
    ].join("\n"));
    expect(r).toMatchObject({ added: 2, updated: 1, approvers: 1 });
    expect(r.skipped).toHaveLength(2);
    const musa = await byEmail("musa.bala@example.edu.ng");
    const [dept] = await db.select().from(s.departments).where(eq(s.departments.id, b.id));
    expect(dept.headUserId).toBe(musa.id);
    expect(dept.approverTitle).toBe("line_manager");
    expect((await profile((await byEmail("kemi.ade@example.edu.ng")).id)).departmentId).toBe(a.id);
  });

  it("keeps everything set here when the person first signs in", async () => {
    const id = await provisionEntraUser({ oid: "oid-kemi", tenantId: "t", email: "kemi.ade@example.edu.ng", displayName: "Kemi Ade" });
    expect(id).toBe((await byEmail("kemi.ade@example.edu.ng")).id);
    expect((await profile(id)).departmentId).toBe(depts[0].id);
    await setUserDepartment(db, admin, id, depts[1].id);
    expect((await profile(id)).departmentId).toBe(depts[1].id);
  });
});
