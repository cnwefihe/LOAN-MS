/** Role titles and workflow wording are set by administrators, without a code change. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-wording-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { updateRoleDetails, updateSettingsGroup } from "@/server/services/admin";
import { loadWording, roleTitles, approvalStageName } from "@/server/wording";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const roleId = async (code: string) => (await db.select().from(s.roles).where(eq(s.roles.code, code)))[0].id;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("role titles and workflow wording", () => {
  it("starts with the agreed titles", async () => {
    const w = await loadWording(db);
    expect(w.role.ACCOUNTS_OFFICER.name).toBe("Accounts Payable Officer");
    expect(w.role.ACCOUNTS_ADMIN.name).toBe("Bursar");
    expect(w.role.BURSARY_OFFICER.name).toBe("Bursary Officer");
    expect(w.role.HR_DIRECTOR.name).toBe("HR Director");
    expect([w.stage.hod, w.stage.hrDirector, w.stage.approval]).toEqual(["HOD approval", "HR Director approval", "Bursar's final approval"]);
    // The first approval is named after whoever is in charge of the department.
    expect([approvalStageName(w, 1, "hod"), approvalStageName(w, 1, "line_manager")]).toEqual(["HOD approval", "Line Manager approval"]);
    expect(roleTitles(w, ["APPLICANT", "ACCOUNTS_ADMIN", "HR_ADMIN"])).toEqual(["HR Administrator", "Bursar"]);
    // The old HR Officer and Management roles are gone.
    expect(await db.select().from(s.roles).where(eq(s.roles.code, "FINAL_APPROVER"))).toHaveLength(0);
  });

  it("an administrator renames a role; the role keeps its permissions and the change is audited", async () => {
    const admin = await actor("admin");
    const id = await roleId("HR_DIRECTOR");
    const before = (await db.select().from(s.rolePermissions).where(eq(s.rolePermissions.roleId, id))).length;
    await updateRoleDetails(db, admin, id, { name: "  Director of  People ", description: "Approves staff loans after the Line Manager." });
    const w = await loadWording(db);
    expect(w.role.HR_DIRECTOR).toEqual({ name: "Director of People", description: "Approves staff loans after the Line Manager." });
    expect((await db.select().from(s.rolePermissions).where(eq(s.rolePermissions.roleId, id))).length).toBe(before);
    expect((await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "role.renamed"))).length).toBe(1);
  });

  it("refuses duplicate or empty titles, and staff without the permission", async () => {
    const admin = await actor("admin");
    await expect(updateRoleDetails(db, admin, await roleId("ACCOUNTS_OFFICER"), { name: "bursar", description: "" })).rejects.toThrow(/already called/);
    await expect(updateRoleDetails(db, admin, await roleId("ACCOUNTS_OFFICER"), { name: " ", description: "" })).rejects.toThrow(/2 to 60/);
    await expect(updateRoleDetails(db, await actor("hradmin"), await roleId("ACCOUNTS_OFFICER"), { name: "Cashier", description: "" })).rejects.toThrow();
  });

  it("re-seeding never overwrites an administrator's title", async () => {
    await seedBase(db);
    expect((await loadWording(db)).role.HR_DIRECTOR.name).toBe("Director of People");
  });

  it("stage and menu wording come from settings", async () => {
    await updateSettingsGroup(db, await actor("admin"), "Workflow wording", { "wording.stageBursary": "Fund availability review", "wording.sectionBursary": "Finance" }, false);
    const w = await loadWording(db);
    expect(w.stage.bursary).toBe("Fund availability review");
    expect(w.section.bursary).toBe("Finance");
  });
});
