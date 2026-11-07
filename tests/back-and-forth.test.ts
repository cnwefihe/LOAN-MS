/**
 * The workflow's return paths, end to end, on one application that keeps a single reference:
 * a guarantor declines and is replaced, HR returns it for correction, the Bursar refers it back to
 * HR, the Line Manager returns it to the applicant; each approval stage is then taken in turn
 * by a different person; the loan is paid out; a repayment claim is rejected; and the corrected
 * entry goes through.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, asc, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lms-back-forth-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor, grantRole } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { saveDraft, submitApplication, replaceGuarantor } from "@/server/services/applications";
import { respondToGuarantee } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import { storeDocument } from "@/server/services/documents";
import { recordDisbursement, submitRepaymentClaim, rejectRepaymentClaim, confirmRepaymentClaim } from "@/server/services/loans";
import { REFERENCE_PATTERN } from "@/server/references";
import { dec, m } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";

let db: Database;
let productId: string;
const ids: Record<string, string> = {};
const A = async (k: string): Promise<Actor> => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
let appId = "";
let reference = "";
const status = async () => (await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId)))[0].status;
const hrBase = { employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, monthlyBasic: "300000", monthlyGross: "450000", monthlyNet: "380000", notes: "Checked against the personnel file and payroll." };
const assessAll = async () => (await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, appId), eq(s.applicationGuarantors.status, "accepted"))))
  .map((g) => ({ guaranteeId: g.id, outcome: "capable" as const }));

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    Object.assign(ids, r.ids);
  });
});

describe("workflow return paths", () => {
  it("allows two guarantors only", async () => {
    await expect(saveDraft(db, await A("applicant"), { productId, requestedAmount: "600000", tenorMonths: 12, purpose: "Three guarantors attempt", guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng", "kunle.adeyemi.dev@example.edu.ng"] }))
      .rejects.toThrow(/two guarantors only/);
  });

  it("a guarantor declines and the applicant nominates a replacement", async () => {
    const a = await A("applicant");
    const d = await saveDraft(db, a, { productId, requestedAmount: "600000", tenorMonths: 12, purpose: "Return paths test application", guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"] });
    appId = d.id;
    reference = d.reference;
    expect(reference).toMatch(REFERENCE_PATTERN);
    await storeDocument(db, a, { buffer: PDF, fileName: "payslip.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: appId, requirementCode: "PAYSLIP" });
    await submitApplication(db, a, appId, { termsAccepted: true });
    const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, appId));
    const ngozi = gs.find((g) => g.guarantorId === ids.guarantor2)!;
    await respondToGuarantee(db, await A("guarantor2"), ngozi.id, { decision: "decline", reason: "I am already guaranteeing another colleague." });
    expect(await status()).toBe("pending_guarantor");
    await replaceGuarantor(db, a, ngozi.id, "emeka.nwosu.dev@example.edu.ng");
    const live = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, appId), eq(s.applicationGuarantors.status, "pending")));
    expect(live).toHaveLength(2);
    await respondToGuarantee(db, await A("guarantor1"), live.find((g) => g.guarantorId === ids.guarantor1)!.id, { decision: "accept", typedName: "Tunde Bello", confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    await respondToGuarantee(db, await A("admin"), live.find((g) => g.guarantorId === ids.admin)!.id, { decision: "accept", typedName: "Emeka Nwosu", confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    expect(await status()).toBe("pending_hr");
  });

  it("HR returns it for correction; the applicant resubmits without asking guarantors again", async () => {
    await recordHrDecision(db, await A("hradmin"), appId, { ...hrBase, outcome: "returned", notes: "Please upload your latest payslip.", guarantorAssessments: [] });
    expect(await status()).toBe("returned");
    await submitApplication(db, await A("applicant"), appId, { termsAccepted: true });
    expect(await status()).toBe("pending_hr");
  });

  it("HR verifies; the Bursar refers it back to HR; the Line Manager returns it to the applicant", async () => {
    const clear = async () => reviewByBursary(db, await A("bursary"), appId, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
    await recordHrDecision(db, await A("hradmin"), appId, { ...hrBase, outcome: "verified", guarantorAssessments: await assessAll() });
    expect(await status()).toBe("pending_bursary");
    await expect(reviewByBursary(db, await A("bursary"), appId, { decision: "cleared", fundsAvailable: false, comments: "Funds available; take-home pay check met." })).rejects.toThrow(/funds are available/);
    await clear();
    expect(await status()).toBe("pending_approval");
    await expect(decideApplication(db, await A("hod"), appId, { decision: "refer_hr", comments: "Heads cannot refer to HR." })).rejects.toThrow(/Only the Bursar can refer/);
    await decideApplication(db, await A("hod"), appId, { decision: "approved", comments: "Supported by the department." });
    await decideApplication(db, await A("hrdirector"), appId, { decision: "approved", comments: "Employment in good standing." });
    await decideApplication(db, await A("accadmin"), appId, { decision: "refer_hr", comments: "Please confirm the employment date." });
    expect(await status()).toBe("pending_hr");
    // Emeka is a guarantor on this application, so even as an HR Administrator he is blocked from reviewing it.
    await grantRole(db, ids.admin, "HR_ADMIN", await A("admin"));
    await expect(recordHrDecision(db, await A("admin"), appId, { ...hrBase, outcome: "verified", guarantorAssessments: await assessAll() })).rejects.toThrow(/conflict of interest/);
    await recordHrDecision(db, await A("hradmin"), appId, { ...hrBase, outcome: "verified", guarantorAssessments: await assessAll() });
    await expect(decideApplication(db, await A("hod"), appId, { decision: "approved", comments: "Too early." })).rejects.toThrow(/not awaiting approval/);
    await clear();
    await decideApplication(db, await A("hod"), appId, { decision: "returned", comments: "Please state the purpose in more detail." });
    expect(await status()).toBe("returned");
    await submitApplication(db, await A("applicant"), appId, { termsAccepted: true });
    await recordHrDecision(db, await A("hradmin"), appId, { ...hrBase, outcome: "verified", guarantorAssessments: await assessAll() });
    await clear();
    expect(await status()).toBe("pending_approval");
  });

  it("each stage is a different person's decision, and the loan keeps the application's reference", async () => {
    // Even with the HR Director role, the Line Manager cannot approve a second stage.
    await grantRole(db, ids.hod, "HR_DIRECTOR", await A("admin"));
    await decideApplication(db, await A("hod"), appId, { decision: "approved", comments: "Supported by the department." });
    await expect(decideApplication(db, await A("hod"), appId, { decision: "approved", comments: "Same person again." })).rejects.toThrow(/different person must approve/);
    await decideApplication(db, await A("hrdirector"), appId, { decision: "approved", comments: "Employment in good standing." });
    await expect(decideApplication(db, await A("bursary"), appId, { decision: "approved", comments: "The Bursary Officer is not the Bursar." })).rejects.toThrow(/Only the Bursar/);
    const r = await decideApplication(db, await A("accadmin"), appId, { decision: "approved", comments: "Final approval." });
    expect(r.status).toBe("approved");
    expect(r.loan!.accountNumber).toBe(reference);
  });

  it("the Accounts Payable Officer pays it out", async () => {
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.applicationId, appId));
    await recordDisbursement(db, await A("accounts"), loan.id, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "FT-RIGHT", amountDisbursed: loan.principal, idempotencyKey: "bf-2" });
    expect((await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loan.id)))[0].status).toBe("active");
  });

  it("a rejected repayment claim leaves the balance unchanged; a confirmed one reduces it", async () => {
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.applicationId, appId));
    const before = dec(loan.principalOutstanding).plus(loan.interestOutstanding);
    const a = await A("applicant");
    const bad = await submitRepaymentClaim(db, a, loan.id, { amount: loan.monthlyInstalment, deductionMonth: todayLagos().slice(0, 7), channel: "bank_transfer" });
    await rejectRepaymentClaim(db, await A("bursary"), bad.id, "No matching credit on the bank statement.");
    const [same] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loan.id));
    expect(m(dec(same.principalOutstanding).plus(same.interestOutstanding))).toBe(m(before));
    const good = await submitRepaymentClaim(db, a, loan.id, { amount: loan.monthlyInstalment, deductionMonth: todayLagos().slice(0, 7), channel: "bank_transfer", payerReference: "TRF-2" });
    const txn = await confirmRepaymentClaim(db, await A("bursary"), good.id, { amount: loan.monthlyInstalment, valueDate: todayLagos(), bankReference: "BANK-OK" });
    expect((txn as { reference: string }).reference).toMatch(REFERENCE_PATTERN);
    const [after] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loan.id));
    expect(dec(after.principalOutstanding).plus(after.interestOutstanding).lessThan(before)).toBe(true);
  });

  it("records every step, in order, against the one reference", async () => {
    const steps = await db.select({ action: s.workflowTransitions.action, to: s.workflowTransitions.toStatus }).from(s.workflowTransitions).where(eq(s.workflowTransitions.applicationId, appId)).orderBy(asc(s.workflowTransitions.createdAt), asc(s.workflowTransitions.id));
    const tos = steps.map((x) => x.to);
    expect(tos[0]).toBe("draft");
    for (const st of ["pending_guarantor", "pending_hr", "returned", "pending_approval", "approved"]) expect(tos).toContain(st);
    expect(tos.at(-1)).toBe("approved");
    expect(tos.filter((t) => t === "returned")).toHaveLength(2);
  });
});
