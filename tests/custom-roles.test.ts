/** Administrators can add their own roles, give them to staff and delete them when unused. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-roles-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { createRole, deleteRole, setRolePermissions, setUserRole, roleMatrix } from "@/server/services/admin";
import { loadWording, roleTitles } from "@/server/wording";
import type { RoleCode } from "@/lib/auth/permissions";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const roleId = async (code: string) => (await db.select().from(s.roles).where(eq(s.roles.code, code)))[0].id;
const codesOf = async (id: string) => (await db.select({ code: s.permissions.code }).from(s.rolePermissions).innerJoin(s.permissions, eq(s.permissions.id, s.rolePermissions.permissionId)).where(eq(s.rolePermissions.roleId, id))).map((p) => p.code);

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("custom roles", () => {
  it("adds a role from another role's permissions and shows its title", async () => {
    const admin = await actor("admin");
    const role = await createRole(db, admin, { name: "Internal Auditor", description: "Reviews records.", copyFrom: await roleId("HR_DIRECTOR") });
    expect(role.code).toBe("INTERNAL_AUDITOR");
    expect(role.isSystem).toBe(false);
    expect((await codesOf(role.id)).sort()).toEqual((await codesOf(await roleId("HR_DIRECTOR"))).sort());
    const w = await loadWording(db);
    expect(roleTitles(w, ["APPLICANT", "INTERNAL_AUDITOR"])).toEqual(["Internal Auditor"]);
    await expect(createRole(db, admin, { name: "internal auditor", description: "" })).rejects.toThrow(/already called/);
  });

  it("saves a role's whole permission list and gives the holder those permissions", async () => {
    const admin = await actor("admin");
    const id = await roleId("INTERNAL_AUDITOR");
    expect(await setRolePermissions(db, admin, id, ["reports.view", "admin.audit.view"])).toBeGreaterThan(0);
    expect((await codesOf(id)).sort()).toEqual(["admin.audit.view", "reports.view"]);
    expect(await setRolePermissions(db, admin, id, ["reports.view", "admin.audit.view"])).toBe(0);
    await setUserRole(db, admin, ids.applicant, "INTERNAL_AUDITOR" as RoleCode, true);
    expect((await actor("applicant")).permissions.has("admin.audit.view")).toBe(true);
  });

  it("saves the Super Administrator's permissions exactly as ticked: none is locked", async () => {
    const admin = await actor("admin");
    const id = await roleId("SUPER_ADMIN");
    const before = await codesOf(id);
    await setRolePermissions(db, admin, id, before.filter((c) => c !== "reports.export"));
    expect(await codesOf(id)).not.toContain("reports.export");
    await setRolePermissions(db, admin, id, [...before, "transaction.approve"]);
    expect(await codesOf(id)).toEqual(expect.arrayContaining(["reports.export", "transaction.approve"]));
    await setRolePermissions(db, admin, id, before); // as it was
    expect((await codesOf(id)).sort()).toEqual([...before].sort());
  });

  it("deletes custom roles, asking for a two-step code when someone still holds one; built-in roles stay", async () => {
    const admin = await actor("admin");
    const id = await roleId("INTERNAL_AUDITOR");
    await expect(deleteRole(db, admin, await roleId("HR_DIRECTOR"))).rejects.toThrow(/Built-in/);
    await expect(deleteRole(db, admin, id)).rejects.toThrow(/holds this role.*two-step verification code/);
    await setUserRole(db, admin, ids.applicant, "INTERNAL_AUDITOR" as RoleCode, false);
    await deleteRole(db, admin, id);
    expect((await roleMatrix(db, admin)).roles.some((r) => r.id === id)).toBe(false);
    expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.action, "role.deleted"), eq(s.auditLogs.entityId, id)))).toHaveLength(1);
  });

  it("is not open to other staff", async () => {
    await expect(createRole(db, await actor("hradmin"), { name: "Cashier", description: "" })).rejects.toThrow();
  });
});
