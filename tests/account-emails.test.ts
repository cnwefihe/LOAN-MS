/** Staff are emailed when their account is created and when their roles or access change. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-account-mail-"));
process.env.APP_BASE_URL = "https://loans.example.edu.ng";
process.env.ALLOWED_EMAIL_DOMAINS = "example.edu.ng";

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor, provisionEntraUser } from "@/server/services/identity";
import { clearDepartmentApprover, deleteOrgItem, setDepartmentApprover, setUserActive, setUserRole } from "@/server/services/admin";
import { composeEmail } from "@/server/email";
import { getBranding } from "@/server/branding";
import { hrUpdateStaffRecord } from "@/server/services/staff";

let db: Database;
const ids: Record<string, string> = {};
const admin = async () => (await loadActor(db, ids.admin, { ip: "127.0.0.1", userAgent: "vitest" }))!;
const mail = async (to: string) => db.select().from(s.emailOutbox).where(eq(s.emailOutbox.toAddress, to));
const person = { oid: "new-staff-oid", tenantId: "tenant", email: "ada.new@example.edu.ng", displayName: "Ada New", jobTitle: null, department: null, employeeId: null, mobilePhone: null };

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("account emails", () => {
  it("welcomes someone once, at their first sign-in", async () => {
    await provisionEntraUser(person);
    await provisionEntraUser(person);
    const sent = await mail(person.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Welcome to the Loan Management System");
    expect(sent[0].body).toContain("Dear Ada,");
    expect(sent[0].body).toContain("Email: ada.new@example.edu.ng");
    expect(sent[0].body).toContain("Access: Applicant");
    expect(sent[0].body).toContain("https://loans.example.edu.ng/home");
  });

  it("tells someone when a role is given and removed, but not when nothing changes", async () => {
    const [u] = await db.select().from(s.users).where(eq(s.users.email, person.email));
    await setUserRole(db, await admin(), u.id, "BURSARY_OFFICER", true);
    await setUserRole(db, await admin(), u.id, "BURSARY_OFFICER", true);
    await setUserRole(db, await admin(), u.id, "BURSARY_OFFICER", false);
    const subjects = (await mail(person.email)).map((m) => m.subject);
    expect(subjects.filter((x) => x === "You now have the Bursary Officer role")).toHaveLength(1);
    expect(subjects.filter((x) => x === "Your Bursary Officer role has been removed")).toHaveLength(1);
  });

  it("tells someone when their account is deactivated and reactivated", async () => {
    const [u] = await db.select().from(s.users).where(eq(s.users.email, person.email));
    await setUserActive(db, await admin(), u.id, false);
    await setUserActive(db, await admin(), u.id, true);
    const sent = await mail(person.email);
    const subjects = sent.map((m) => m.subject);
    expect(subjects).toContain("Your account has been deactivated");
    const off = sent.find((m) => m.subject === "Your account has been deactivated")!;
    expect(off.body).toContain("contact the Administrator.");
    expect(off.body).not.toContain("support team");
    expect(subjects).toContain("Your account has been reactivated");
  });

  it("lays the email out with a header, details table, button and footer", async () => {
    const b = await getBranding(db);
    const { html, text } = composeEmail(b, "Welcome", "Dear Ada,\n\nName: Ada New\nEmail: a@example.edu.ng\n\nA note: this one stays a sentence.\n\nOpen: https://loans.example.edu.ng/home", true);
    expect(html).toContain("Name</td>");
    expect(html).toContain("Ada New</td>");
    expect(html).toContain("A note: this one stays a sentence.</p>");
    expect(html).toContain(">Open</a>");
    expect(html).toContain("Kind regards,");
    expect(html).toContain("Loan Management System · Pan-Atlantic University");
    expect(html).not.toContain("CONFIDENTIAL");
    expect(text).toContain("Kind regards,");
  });
});

describe("administrators and staff records", () => {
  it("lets a Super Administrator edit another person's record, but not their own", async () => {
    const a = await admin();
    expect(a.permissions.has("hr.staff.edit")).toBe(true);
    await expect(hrUpdateStaffRecord(db, a, ids.admin, { designation: "Own change" } as never, "Test")).rejects.toThrow(/your own/);
  });
});

describe("organisation: delete and approvers", () => {
  it("deletes an unused school but refuses one still in use", async () => {
    const a = await admin();
    const [spare] = await db.insert(s.schools).values({ code: "TMP", name: "Temporary School", isActive: true }).returning();
    await deleteOrgItem(db, a, "school", spare.id);
    expect(await db.select().from(s.schools).where(eq(s.schools.id, spare.id))).toHaveLength(0);
    const [used] = await db.select().from(s.departments).where(eq(s.departments.code, "SST-CS"));
    await expect(deleteOrgItem(db, a, "school", used.schoolId!)).rejects.toThrow(/inactive instead/);
    await expect(deleteOrgItem(db, a, "department", used.id)).rejects.toThrow(/staff record/);
  });

  it("makes someone the HOD of a department, then removes them", async () => {
    const a = await admin();
    const [u] = await db.select().from(s.users).where(eq(s.users.email, person.email));
    const [dept] = await db.select().from(s.departments).where(eq(s.departments.code, "SST-CS"));
    await setDepartmentApprover(db, a, dept.id, u.id, "hod");
    let [now] = await db.select().from(s.departments).where(eq(s.departments.id, dept.id));
    expect([now.headUserId, now.approverTitle]).toEqual([u.id, "hod"]);
    await clearDepartmentApprover(db, a, dept.id, u.id);
    [now] = await db.select().from(s.departments).where(eq(s.departments.id, dept.id));
    expect(now.headUserId).toBeNull();
  });
});
