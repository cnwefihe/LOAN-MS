/** The administrator's menu follows the Super Administrator role's permissions: turning one on shows its area at once. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-adminmenu-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { setRolePermission } from "@/server/services/admin";
import { buildNav, homeFor } from "@/lib/nav";
import { notify } from "@/server/notifications";

let db: Database;
let adminId = "";
const admin = async () => (await loadActor(db, adminId))!;
const menu = async () => (await buildNav(db, await admin())).sections.map((x) => `${x.title}: ${x.items.map((i) => i.label).join(", ")}`);
const toggle = async (code: string, on: boolean) => {
  const [role] = await db.select().from(s.roles).where(eq(s.roles.code, "SUPER_ADMIN"));
  const [perm] = await db.select().from(s.permissions).where(eq(s.permissions.code, code));
  await setRolePermission(db, await admin(), role.id, perm.id, on);
};

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => { await seedBase(tx); adminId = (await seedFixtures(tx)).ids.admin; });
});

describe("administrator's menu", () => {
  it("starts with Administration, then the areas the role opens, then Insight; home is the Control centre", async () => {
    const m = await menu();
    expect(m[0]).toMatch(/^Administration: Control centre, Users, Roles/);
    expect(m).toEqual(expect.arrayContaining([expect.stringMatching(/^Bursary.*: Overview, Advances, Reconciliation, Loan accounts$/), expect.stringMatching(/^Insight: Reports/)]));
    expect(m.join("\n")).not.toMatch(/Human Resources|Approvals|Payroll/);
    expect(await homeFor(db, await admin())).toBe("/admin");
  });

  it("shows an area as soon as its permission is turned on, and hides it again when turned off", async () => {
    await toggle("hr.queue.view", true);
    await toggle("approval.queue.view", true);
    await toggle("payroll.view", true);
    const m = (await menu()).join("\n");
    expect(m).toMatch(/Human Resources: Overview, Verification/);
    expect(m).toMatch(/Approvals/);
    expect(m).toMatch(/Payroll: Overview, Early repayments/);
    for (const c of ["hr.queue.view", "approval.queue.view", "payroll.view"]) await toggle(c, false);
    expect((await menu()).join("\n")).not.toMatch(/Human Resources|Approvals|Payroll/);
  });

  it("brings the notices for that work too: an administrator given HR verification is told when an application is ready for it", async () => {
    const told = async () => (await db.select().from(s.notifications).where(eq(s.notifications.userId, adminId))).filter((n) => n.link === "/hr/applications/test").length;
    await notify(db, { template: "application.pending_hr", roles: ["HR_ADMIN"], link: "/hr/applications/test", vars: { reference: "LMS-TEST", applicantName: "Test", amount: "1" } });
    expect(await told()).toBe(0);
    await toggle("hr.verify", true);
    await notify(db, { template: "application.pending_hr", roles: ["HR_ADMIN"], link: "/hr/applications/test", vars: { reference: "LMS-TEST", applicantName: "Test", amount: "1" } });
    expect(await told()).toBe(1);
    await toggle("hr.verify", false);
  });
});
