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
import { addUser, importOrganisation, importUsers, setUserDepartment } from "@/server/services/user-setup";

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
    await expect(addUser(db, admin, { name: "Someone Else", email: "someone@gmail.com" })).rejects.toThrow(/not a staff email address/);
  });

  it("adds many at once, matching departments by name or code and reading the approver", async () => {
    const [a, b] = depts;
    const r = await importUsers(db, admin, [
      "Full name, Email, Department, Role",
      `Kemi Ade, kemi.ade@example.edu.ng, ${a.name}`,
      `Musa Bala\tmusa.bala@example.edu.ng\t${b.code}\tLine Manager`,
      "Ngozi Eze; ngozi.eze@example.edu.ng",
      "No Email Here, Bursary",
      "New Person, new.person@example.edu.ng, Estates and Works, School of Facilities, Line Manager",
      "Second Person, second.person@example.edu.ng, estates and works",
    ].join("\n"));
    expect(r).toMatchObject({ added: 4, updated: 1, approvers: 2, departmentsAdded: 1 });
    expect(r.skipped).toEqual(["No Email Here, Bursary"]);
    const [estates] = await db.select().from(s.departments).where(eq(s.departments.name, "Estates and Works"));
    const [school] = await db.select().from(s.schools).where(eq(s.schools.id, estates.schoolId!));
    expect(school.name).toBe("School of Facilities");
    expect(estates.approverTitle).toBe("line_manager");
    expect(estates.headUserId).toBe((await byEmail("new.person@example.edu.ng")).id);
    expect((await profile((await byEmail("second.person@example.edu.ng")).id)).departmentId).toBe(estates.id); // matched, any case
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

  it("gives an approver added before signing in their employee code from Microsoft, without replacing one already entered", async () => {
    await addUser(db, admin, { name: "Gbenga Ola", email: "gbenga.ola@example.edu.ng", departmentName: depts[0].name, approver: "line_manager" });
    const id = (await byEmail("gbenga.ola@example.edu.ng")).id;
    expect((await profile(id)).staffNumber).toBeNull();
    await provisionEntraUser({ oid: "oid-gbenga", tenantId: "t", email: "gbenga.ola@example.edu.ng", displayName: "Gbenga Ola", employeeId: "PAU/2015/044", mobilePhone: "08030000001" });
    expect((await profile(id)).staffNumber).toBe("PAU/2015/044");
    expect((await profile(id)).phone).toBe("08030000001");
    // A later sign-in with a different directory value keeps what is on record.
    await provisionEntraUser({ oid: "oid-gbenga", tenantId: "t", email: "gbenga.ola@example.edu.ng", displayName: "Gbenga Ola", employeeId: "OTHER-1" });
    expect((await profile(id)).staffNumber).toBe("PAU/2015/044");
  });
});

describe("adding one user with a new department", () => {
  it("creates the department and its school when they are not set up yet, and reuses them next time", async () => {
    const r = await addUser(db, admin, { name: "Ifeoma Nnadi", email: "ifeoma.nnadi@example.edu.ng", departmentName: "Sports Centre", schoolName: "Student Affairs", approver: "hod" });
    expect(r.created).toBe(true);
    const [dept] = await db.select().from(s.departments).where(eq(s.departments.name, "Sports Centre"));
    expect(dept.headUserId).toBe(r.userId);
    const [school] = await db.select().from(s.schools).where(eq(s.schools.name, "Student Affairs"));
    expect(dept.schoolId).toBe(school.id);
    await addUser(db, admin, { name: "Bayo Kalu", email: "bayo.kalu@example.edu.ng", departmentName: "SPORTS CENTRE" });
    expect(await db.select().from(s.departments).where(eq(s.departments.name, "Sports Centre"))).toHaveLength(1);
  });
});

describe("adding departments and schools many at once", () => {
  it("creates departments in their schools, creating schools as needed, and moves a known department", async () => {
    const r = await importOrganisation(db, admin, [
      "Department, School, Approver",
      "Accounting, School of Management and Social Sciences",
      "Marine Biology\tSchool of Ocean Studies",
      "Estates; Central Administration; Line Manager",
      "Computer Science, School of Ocean Studies",
      "Lonely line",
    ].join("\n"));
    expect(r).toMatchObject({ departmentsAdded: 3, departmentsUpdated: 1, schoolsAdded: 1, skipped: ["Lonely line"] });
    const school = async (name: string) => (await db.select().from(s.schools).where(eq(s.schools.name, name)))[0];
    const dept = async (name: string) => (await db.select().from(s.departments).where(eq(s.departments.name, name)))[0];
    const ocean = await school("School of Ocean Studies");
    expect((await dept("Marine Biology")).schoolId).toBe(ocean.id);
    expect((await dept("Computer Science")).schoolId).toBe(ocean.id);
    expect((await dept("Accounting")).schoolId).toBe((await school("School of Management and Social Sciences")).id);
    expect(await dept("Estates")).toMatchObject({ schoolId: (await school("Central Administration")).id, approverTitle: "line_manager" });
    // Running it again changes nothing.
    expect(await importOrganisation(db, admin, "Accounting, School of Management and Social Sciences")).toMatchObject({ departmentsAdded: 0, departmentsUpdated: 0, schoolsAdded: 0 });
  });

  it("is for administrators who manage the organisation", async () => {
    const staff = (await loadActor(db, ids.applicant))!;
    await expect(importOrganisation(db, staff, "Physics, School of Science and Technology")).rejects.toThrow(/not authorised/);
  });
});
