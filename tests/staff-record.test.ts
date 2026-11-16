/** Human Resources keeps one staff record: saving it confirms the payslip details, changed or not. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-staffrec-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { hrUpdateStaffRecord, payslipDetailsConfirmed } from "@/server/services/staff";

let db: Database;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => { await seedBase(tx); Object.assign(ids, (await seedFixtures(tx)).ids); });
});

describe("staff record", () => {
  it("saving it, even unchanged, confirms the payslip details the staff member entered", async () => {
    const hr = (await loadActor(db, ids.hradmin))!;
    // The staff member has just changed their details, so they wait for Human Resources.
    await db.update(s.staffProfiles).set({ payslipDetailsUpdatedAt: new Date(Date.now() + 1000), payslipDetailsConfirmedAt: null }).where(eq(s.staffProfiles.userId, ids.applicant));
    const before = (await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, ids.applicant)))[0];
    expect(payslipDetailsConfirmed(before)).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    await hrUpdateStaffRecord(db, hr, ids.applicant, { staffNumber: before.staffNumber, payGrade: before.payGrade, designation: before.designation }, "Checked against the personnel record");
    const after = (await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, ids.applicant)))[0];
    expect(payslipDetailsConfirmed(after)).toBe(true);
    expect(after.payslipDetailsConfirmedBy).toBe(ids.hradmin);
  });
});
