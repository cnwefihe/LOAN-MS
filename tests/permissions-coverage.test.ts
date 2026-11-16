/**
 * Every permission works on its own: each is checked somewhere, each appears on the role page, and each
 * brings the access it needs (a role holding only "Propose adjustments" can open the loan accounts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-perms-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { createRole, setRolePermissions, setUserRole } from "@/server/services/admin";
import { ALL_PERMISSIONS, IMPLIED_PERMISSIONS, PERMISSION_CATEGORIES, PERMISSIONS, withImplied, type Permission, type RoleCode } from "@/lib/auth/permissions";
import { buildNav } from "@/lib/nav";

let db: Database;
let adminId = "";
let personId = "";

/** All source files except the list of permissions itself. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(e.name) && !p.endsWith(path.join("auth", "permissions.ts")) ? [p] : [];
  });
}

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    adminId = r.ids.admin;
    personId = r.ids.applicant;
  });
});

describe("permissions", () => {
  it("each one is checked somewhere in the system, so turning it on or off always does something", () => {
    const code = sources(path.join(process.cwd(), "src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(ALL_PERMISSIONS.filter((p) => !code.includes(`"${p}"`))).toEqual([]);
  });

  it("each one is in a group shown on the role page, and every group has some", () => {
    expect(ALL_PERMISSIONS.filter((p) => !PERMISSION_CATEGORIES.includes(PERMISSIONS[p].category))).toEqual([]);
    expect(PERMISSION_CATEGORIES.filter((c) => !ALL_PERMISSIONS.some((p) => PERMISSIONS[p].category === c))).toEqual([]);
    expect(PERMISSIONS["finance.overview"].category).toBe("Finance");
  });

  it("bring the access they need, in turn", () => {
    expect([...withImplied(["transaction.adjust"])].sort()).toEqual(["accounts.view", "transaction.adjust"]);
    expect(withImplied(["fund.manage"]).has("fund.view")).toBe(true);
    expect(withImplied(["repayment.confirm"]).has("payroll.view")).toBe(true);
    for (const [p, needs] of Object.entries(IMPLIED_PERMISSIONS)) for (const n of needs!) expect(ALL_PERMISSIONS, `${p} -> ${n}`).toContain(n);
  });

  it("a role holding a single action permission can use it: the person gets its pages and menu", async () => {
    const admin = (await loadActor(db, adminId))!;
    const role = await createRole(db, admin, { name: "Adjustments only", description: "Test" });
    await setRolePermissions(db, admin, role.id, ["transaction.adjust", "fund.manage", "repayment.confirm"]);
    await setUserRole(db, admin, personId, role.code as RoleCode, true);
    const person = (await loadActor(db, personId))!;
    for (const p of ["transaction.adjust", "accounts.view", "fund.manage", "fund.view", "repayment.confirm", "payroll.view"] as Permission[]) expect(person.permissions.has(p), p).toBe(true);
    const menu = (await buildNav(db, person)).sections.flatMap((x) => x.items.map((i) => i.href));
    expect(menu).toEqual(expect.arrayContaining(["/accounts", "/accounts/loans", "/accounts/repayments", "/payroll"]));
    // The role itself stores only what was ticked.
    const stored = await db.select({ code: s.permissions.code }).from(s.rolePermissions).innerJoin(s.permissions, eq(s.permissions.id, s.rolePermissions.permissionId)).where(eq(s.rolePermissions.roleId, role.id));
    expect(stored.map((x) => x.code).sort()).toEqual(["fund.manage", "repayment.confirm", "transaction.adjust"]);
  });
});
