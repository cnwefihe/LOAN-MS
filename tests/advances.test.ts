/**
 * An advance against 13th month pay, end to end: requested from the staff member's basic salary with no
 * guarantors, approved through the full chain, paid out as a single interest-free deduction, and listed
 * in the advances register with what is still payable to the staff member.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-adv-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { listPolicyVersions } from "@/server/services/policies";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { recordHrDecision } from "@/server/services/hr";
import { reviewByBursary } from "@/server/services/bursary";
import { decideApplication } from "@/server/services/approvals";
import { storeDocument } from "@/server/services/documents";
import { recordDisbursement } from "@/server/services/loans";
import { advancesRegister } from "@/server/services/advances";
import { todayLagos } from "@/lib/finance/dates";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string): Promise<Actor> => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
let productId = "";
let appId = "";

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
  const [product] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, "ADVANCE"));
  productId = product.id;
  // The advance is open from installation.
  expect((await listPolicyVersions(db, productId))[0].status).toBe("active");
});

describe("13th month advance", () => {
  it("needs no guarantors and goes straight to HR", async () => {
    const seun = await actor("freshapplicant");
    await expect(saveDraft(db, seun, { productId, requestedAmount: "100000", tenorMonths: 12, purpose: "Family expenses this month", guarantorEmails: [] }))
      .rejects.toThrow(/salary, your leave allowance|Choose whether/);
    const d = await saveDraft(db, seun, { productId, requestedAmount: "100000", tenorMonths: 12, purpose: "Family expenses this month", guarantorEmails: ["tunde.bello.dev@example.edu.ng"], advanceType: "thirteenth_month" });
    appId = d.id;
    // One deduction, no interest, no guarantors; the whole basic salary is available as 13th month pay.
    expect(d.eligibility.eligible).toBe(true);
    expect(d.eligibility.maxEligibleAmount).toBe("350000.00");
    expect(d.eligibility.quote?.totalInterest).toBe("0.00");
    expect(d.eligibility.advance).toMatchObject({ type: "thirteenth_month", payment: "350000.00", remaining: "250000.00" });
    const [saved] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(saved).toMatchObject({ tenorMonths: 1, nominatedGuarantors: [], advanceType: "thirteenth_month" });
    await storeDocument(db, seun, { buffer: Buffer.from("%PDF-1.4"), fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: seun.userId, applicationId: appId, requirementCode: "PAYSLIP" });
    await submitApplication(db, seun, appId, { termsAccepted: true });
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(app.status).toBe("pending_hr");
  });

  it("is approved through the full chain and paid out as one interest-free deduction", async () => {
    await recordHrDecision(db, await actor("hradmin"), appId, {
      outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true,
      monthlyBasic: "200000", monthlyGross: "200000", monthlyNet: "166400", notes: "Basic salary confirmed against payroll.", guarantorAssessments: [],
    });
    await reviewByBursary(db, await actor("bursary"), appId, { decision: "cleared", fundsAvailable: true, comments: "Within the 13th month pay due." });
    await decideApplication(db, await actor("hod"), appId, { decision: "approved", comments: "Supported." });
    await decideApplication(db, await actor("hrdirector"), appId, { decision: "approved", comments: "Approved." });
    const r = await decideApplication(db, await actor("accadmin"), appId, { decision: "approved", comments: "Final approval." });
    expect(r.loan).toMatchObject({ principal: "100000.00", tenorMonths: 1, totalInterest: "0.00" });
    await recordDisbursement(db, await actor("accounts"), r.loan!.id, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "ADV-001", amountDisbursed: "100000", idempotencyKey: "adv-1" });
  });

  it("appears in the advances register with what is still payable", async () => {
    const [row] = await advancesRegister(db, await actor("accounts"));
    expect(row).toMatchObject({ type: "thirteenth_month", amount: "100000.00", paymentNet: "350000.00", stillPayable: "250000.00", stage: "To be deducted" });
    expect(row.deductOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
