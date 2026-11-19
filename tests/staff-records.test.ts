/**
 * The administrator's staff records fill each person's employee code, pay grade, employment date and
 * confirmation; staff cannot change them. Also: each school's early repayment account, and product wording
 * written from the terms.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-records-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { applyStaffRecordTo, importStaffRecords, parseCsv, readRows, saveStaffRecord } from "@/server/services/staff-records";
import { hrUpdateStaffRecord, updatePayslipDetails } from "@/server/services/staff";
import { setSchoolRepaymentAccount } from "@/server/services/admin";
import { earlyRepaymentAccount } from "@/server/services/loans";
import { productSummary, whoMayApply } from "@/lib/finance/product-summary";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { parseDayFirst, toDayFirst } from "@/components/date-input";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string): Promise<Actor> => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const profile = async (userId: string) => (await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, userId)))[0];

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("reading the spreadsheet", () => {
  it("finds the columns in any order and reads day-first dates and confirmation words", () => {
    const { rows, skipped } = readRows([
      ["Confirmation", "Employment Date", "Pay Grade", "Employee Code", "Email"],
      ["Confirmed", "15/03/2019", "Lecturer I Step 2", "EX/001", "ada.obi@example.edu.ng"],
      ["Not confirmed", "2024-01-08", "Officer II Step 1", "EX/002", ""],
      ["Yes", new Date(Date.UTC(2020, 5, 15)), "Officer I Step 1", "EX/003", ""],
      ["Maybe", "01/01/2020", "Officer", "EX/004", ""],
      ["Confirmed", "31/02/2020", "Officer", "EX/005", ""],
      ["", "", "", "", ""],
    ]);
    expect(rows.map((r) => [r.employeeCode, r.employmentDate, r.confirmed, r.email])).toEqual([
      ["EX/001", "2019-03-15", true, "ada.obi@example.edu.ng"], ["EX/002", "2024-01-08", false, null], ["EX/003", "2020-06-15", true, null],
    ]);
    expect(skipped).toEqual([{ row: 5, reason: "confirmation not read (use Confirmed or Not confirmed)" }, { row: 6, reason: "employment date not read (use DD/MM/YYYY)" }]);
    expect(() => readRows([["Name", "Grade"]])).toThrow(/first row must name the columns/);
  });

  it("keeps day first when Excel set to US dates has switched the day and month", () => {
    const read = (dates: unknown[]) => readRows([["Employee code", "Pay grade", "Employment date", "Confirmation"], ...dates.map((d, i) => [`EX/${i}`, "Officer", d, "Confirmed"])]);
    // CSV saved by US Excel: typed 02/03/2015 (2 March) came back as 3/2/2015; 15/03/2020 was left as typed.
    expect(read(["15/03/2020", "3/2/2015"]).rows.map((r) => r.employmentDate)).toEqual(["2020-03-15", "2015-03-02"]);
    expect(read(["15/03/2020", "3/2/2015"]).monthFirst).toBe(true);
    // Excel workbook: the switched one is stored as 3 February, the other kept as text.
    expect(read(["15/03/2020", new Date(Date.UTC(2015, 1, 3))]).rows.map((r) => r.employmentDate)).toEqual(["2020-03-15", "2015-03-02"]);
    // Only month first makes sense.
    expect(read(["03/25/2015", "02/03/2015"]).rows.map((r) => r.employmentDate)).toEqual(["2015-03-25", "2015-02-03"]);
    // Day first written throughout, padded or not.
    expect(read(["02/03/2015", "15/03/2020", "1/2/2019"]).rows.map((r) => r.employmentDate)).toEqual(["2015-03-02", "2020-03-15", "2019-02-01"]);
    expect(read(["02/03/2015"]).monthFirst).toBe(false);
    // Month names are never in doubt.
    expect(read(["02 Mar 2015", "2-Mar-15", "March 2, 2015", "2nd March 2015"]).rows.map((r) => r.employmentDate)).toEqual(Array(4).fill("2015-03-02"));
    // Both kinds in one file: the ones that could go either way are not guessed.
    const mixed = read(["15/03/2020", "03/25/2015", "02/03/2015"]);
    expect(mixed.rows.map((r) => r.employmentDate)).toEqual(["2020-03-15"]);
    expect(mixed.skipped.map((s) => s.reason)).toEqual(["employment date not read (use DD/MM/YYYY)", "employment date could be day or month first; write it as 02 Mar 2015"]);
  });

  it("date boxes are typed day first", () => {
    expect(parseDayFirst("02/03/2015")).toBe("2015-03-02");
    expect(parseDayFirst("2/3/2015")).toBe("2015-03-02");
    expect(parseDayFirst("2015-03-02")).toBe("2015-03-02");
    expect(parseDayFirst("31/02/2015")).toBeNull();
    expect(parseDayFirst("03/25/2015")).toBeNull();
    expect(toDayFirst("2015-03-02")).toBe("02/03/2015");
  });

  it("reads CSV with quoted fields and semicolons", () => {
    expect(parseCsv('Employee code;Pay grade\r\n"EX/1";"Officer I; Step 1"\r\n')).toEqual([["Employee code", "Pay grade"], ["EX/1", "Officer I; Step 1"]]);
  });
});

describe("staff records", () => {
  it("an upload fills the profiles of staff by employee code or email; others wait for their first sign-in", async () => {
    const admin = await actor("admin");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Staff");
    ws.addRow(["Employee code", "Pay grade", "Employment date", "Confirmation", "Email"]);
    ws.addRow(["DEV-1005", "Senior Lecturer Step 3", "10/09/2024", "Not confirmed", ""]); // Seun Bakare, by code
    ws.addRow(["NEW/777", "Officer I Step 1", "01/02/2018", "Confirmed", "new.person.dev@example.edu.ng"]); // not signed in yet
    ws.addRow(["DEV-1005", "Repeat", "01/01/2020", "Confirmed", ""]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await importStaffRecords(db, admin, { buffer, name: "staff.xlsx" });
    expect(r).toMatchObject({ added: 2, updated: 0, linked: 1 });
    expect(r.skipped).toEqual([{ row: 4, reason: "employee code repeated in the file" }]);
    const seun = await profile(ids.freshapplicant);
    expect(seun).toMatchObject({ staffNumber: "DEV-1005", payGrade: "Senior Lecturer Step 3", employmentDate: "2024-09-10", employmentStatus: "probation" });
    expect(seun.payslipDetailsConfirmedAt).not.toBeNull();
    await expect(importStaffRecords(db, await actor("applicant"), { buffer, name: "staff.xlsx" })).rejects.toThrow();

    // The person not yet signed in gets their details at sign-in, matched by work email.
    const [u] = await db.insert(s.users).values({ email: "new.person.dev@example.edu.ng", displayName: "New Person" }).returning();
    await applyStaffRecordTo(db, u.id);
    expect(await profile(u.id)).toMatchObject({ staffNumber: "NEW/777", payGrade: "Officer I Step 1", employmentDate: "2018-02-01", employmentStatus: "confirmed" });
  });

  it("the administrator corrects one record and the profile follows; staff cannot change their code or pay grade", async () => {
    const admin = await actor("admin");
    const [rec] = await db.select().from(s.staffRecords).where(eq(s.staffRecords.employeeCode, "DEV-1005"));
    await saveStaffRecord(db, admin, { id: rec.id, employeeCode: "DEV-1005", payGrade: "Senior Lecturer Step 3", employmentDate: "2019-09-10", confirmed: true });
    expect(await profile(ids.freshapplicant)).toMatchObject({ employmentDate: "2019-09-10", employmentStatus: "confirmed" });

    const seun = await actor("freshapplicant");
    await expect(updatePayslipDetails(db, seun, { name: "Seun Bakare", staffNumber: "X-1", payGrade: "Anything" })).rejects.toThrow(/updated by Human Resources/);
    expect(await updatePayslipDetails(db, seun, { name: "Seun A. Bakare" })).toBe(true);
    expect(await profile(ids.freshapplicant)).toMatchObject({ payslipName: "Seun A. Bakare", staffNumber: "DEV-1005" });
    // Human Resources is not notified of profile changes.
    const hr = await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "staff.payslip_details"));
    expect(hr).toHaveLength(0);
  });
});

describe("latest change holds", () => {
  it("a change by Human Resources updates the Register, and sign-in does not undo it", async () => {
    await hrUpdateStaffRecord(db, await actor("hradmin"), ids.freshapplicant, { employmentDate: "2018-01-15", payGrade: "Senior Lecturer Step 4" }, "Corrected from the personnel file");
    const [rec] = await db.select().from(s.staffRecords).where(eq(s.staffRecords.employeeCode, "DEV-1005"));
    expect(rec).toMatchObject({ employmentDate: "2018-01-15", payGrade: "Senior Lecturer Step 4" });
    await applyStaffRecordTo(db, ids.freshapplicant);
    expect(await profile(ids.freshapplicant)).toMatchObject({ employmentDate: "2018-01-15", payGrade: "Senior Lecturer Step 4" });
    // A later change by the administrator holds in turn.
    await saveStaffRecord(db, await actor("admin"), { id: rec.id, employeeCode: "DEV-1005", payGrade: "Senior Lecturer Step 5", employmentDate: "2018-01-15", confirmed: true });
    expect(await profile(ids.freshapplicant)).toMatchObject({ payGrade: "Senior Lecturer Step 5" });
  });
});

describe("early repayment account by school", () => {
  it("uses the account set for the loan's school under Settings, and none otherwise", async () => {
    const admin = await actor("admin");
    const [school] = await db.select().from(s.schools).limit(1);
    await expect(setSchoolRepaymentAccount(db, admin, school.id, { bank: "Test Bank", accountName: "", accountNumber: "" })).rejects.toThrow(/or leave all three empty/);
    await expect(setSchoolRepaymentAccount(db, await actor("applicant"), school.id, { bank: "Test Bank", accountName: "School Loans", accountNumber: "0123456789" })).rejects.toThrow();
    const [pv] = await db.select().from(s.policyVersions).limit(1);
    const [app] = await db.insert(s.loanApplications).values({ reference: "LMS-TEST-ER", applicantId: ids.applicant, productId: pv.productId, policyVersionId: pv.id, requestedAmount: "100000.00", tenorMonths: 6, purpose: "Test early repayment account", schoolId: school.id, salarySnapshot: {}, quote: {} }).returning();
    const [loan] = await db.insert(s.loanAccounts).values({ accountNumber: "LN-TEST-ER", applicationId: app.id, borrowerId: ids.applicant, productId: pv.productId, policyVersionId: pv.id, principal: "100000.00", interestMethod: "flat", annualInterestRate: "0", totalInterest: "0.00", totalRepayable: "100000.00", monthlyInstalment: "16666.67", tenorMonths: 6, approvedAt: new Date(), status: "active" } as never).returning();
    expect((await earlyRepaymentAccount(db, loan.id)).ready).toBe(false);
    await setSchoolRepaymentAccount(db, admin, school.id, { bank: "Test Bank", accountName: "School Loans", accountNumber: "0123456789" });
    expect(await earlyRepaymentAccount(db, loan.id)).toMatchObject({ bankName: "Test Bank", accountNumber: "0123456789", school: school.name, ready: true });
  });
});

describe("product wording", () => {
  it("is written from the current terms", () => {
    const p = { ...DEFAULT_POLICY, minServiceMonths: 24, maxTenorMonths: 12, minTenorMonths: 1, eligibleEmploymentStatuses: ["confirmed" as const], requiredGuarantors: 2 };
    expect(whoMayApply(p)).toBe("Confirmed members of staff with at least 2 years' service, subject to verification by Human Resources.");
    expect(productSummary(p)).toContain("over up to 12 months. For confirmed members of staff with at least 2 years' service. Two guarantors needed.");
    expect(whoMayApply({ ...p, minServiceMonths: 18 })).toContain("at least 18 months' service");
  });
});
