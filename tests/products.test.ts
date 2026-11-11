/** Quarterly repayment, amount-based approval routing, receipts, clearance letters and policy deactivation. */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-prod-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor, grantRole } from "@/server/services/identity";
import { createProduct, saveProductTerms, setProductActive, listPolicyVersions } from "@/server/services/policies";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import { storeDocument } from "@/server/services/documents";
import { updateOwnProfile, getObligations } from "@/server/services/staff";
import { recordDisbursement, recordRepayment, receiptPdf, clearancePdf, proposeEarlySettlement, approvePendingTransaction, getLoanDetail } from "@/server/services/loans";
import { settlementQuote } from "@/server/services/ledger";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { todayLagos } from "@/lib/finance/dates";

let db: Database;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    Object.assign(ids, (await seedFixtures(tx)).ids);
  });
});

describe("quarterly product with amount-based approval routing", () => {
  let productId: string;
  let appId: string;
  let loanId: string;

  it("administrators set up, save and open a quarterly product", async () => {
    const admin = await actor("admin");
    const p = await createProduct(db, admin, { code: "QTR", name: "Quarterly Staff Loan" });
    productId = p.id;
    await saveProductTerms(db, admin, p.id, {
      ...DEFAULT_POLICY, repaymentFrequency: "quarterly", minTenorMonths: 3, maxTenorMonths: 12, maxRestructuredTenorMonths: 12,
      requiredGuarantors: 0,
    });
    await setProductActive(db, admin, p.id, true);
  });

  it("applicant applies; no guarantors needed so it goes straight to HR", async () => {
    const a = await actor("guarantor1"); // Tunde Bello: HR-verified salary in fixtures
    await updateOwnProfile(db, a, { bankName: "Test Bank", bankAccountName: "Tunde Bello", bankAccountNumber: "0123456789" });
    const draft = await saveDraft(db, a, { productId, requestedAmount: "300000", tenorMonths: 12, purpose: "Quarterly product test", guarantorEmails: [] });
    expect(draft.eligibility.quote?.instalmentCount).toBe(4);
    expect(draft.eligibility.quote?.estimatedCompletionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(saveDraft(db, a, { productId, requestedAmount: "300000", tenorMonths: 10, purpose: "Bad tenor test", guarantorEmails: [] }).then((r) => { if (!r.eligibility.eligible) throw new Error(r.eligibility.reasons.join(" ")); })).rejects.toThrow(/multiple of 3 months/);
    appId = draft.id;
    await storeDocument(db, a, { buffer: Buffer.from("%PDF-1.4"), fileName: "p.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: a.userId, applicationId: appId, requirementCode: "PAYSLIP" });
    await submitApplication(db, a, appId, { termsAccepted: true });
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(app.status).toBe("pending_hr");
  });

  it("an HOD's own application skips straight to the HR Director, then the Bursar", async () => {
    // For this test Tunde is the HOD of his own department, Computer Science.
    await db.update(s.departments).set({ headUserId: ids.guarantor1 }).where(eq(s.departments.code, "SST-CS"));
    await recordHrDecision(db, await actor("hradmin"), appId, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, notes: "Verified for routing test.", guarantorAssessments: [] });
    await reviewByBursary(db, await actor("bursary"), appId, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
    // Tunde is the HOD, so there is no one else at that stage to approve.
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(app.currentApprovalLevel).toBe(2);
    await expect(decideApplication(db, await actor("guarantor1"), appId, { decision: "approved", comments: "Approving my own loan." })).rejects.toThrow(/Only the HR Director|own/);
    const first = await decideApplication(db, await actor("hrdirector"), appId, { decision: "approved", comments: "HR Director approval." });
    expect(first.status).toBe("pending_approval");
    const second = await decideApplication(db, await actor("accadmin"), appId, { decision: "approved", comments: "Final approval." });
    expect(second.status).toBe("approved");
    loanId = second.loan!.id;
    expect(second.loan!.repaymentPeriodMonths).toBe(3);
    expect(second.loan!.monthlyInstalment).toBe("79745.36"); // reducing balance: =PMT(10%/12×3, 4, -300000)
  });

  it("disbursement builds a quarterly schedule and obligations are normalised to monthly", async () => {
    await recordDisbursement(db, await actor("accounts"), loanId, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "QTR-FT-1", amountDisbursed: "300000", idempotencyKey: "qtr-1" });
    const detail = await getLoanDetail(db, await actor("accadmin"), loanId);
    const dues = detail.schedule!.instalments.map((i) => i.dueDate);
    expect(dues).toHaveLength(4);
    const months = dues.map((x) => Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7)));
    expect(months.slice(1).map((m, i) => m - months[i])).toEqual([3, 3, 3]);
    expect((await getObligations(db, ids.guarantor1)).monthlyDeductions).toBe("26581.79"); // 79,745.36 a quarter ÷ 3
  });

  it("issues receipts to the borrower but not to unrelated staff", async () => {
    const t = await recordRepayment(db, await actor("payroll"), loanId, { amount: "82500", valueDate: todayLagos(), reference: "QTR-PAY-1", channel: "payroll", idempotencyKey: "qtr-pay-1" });
    const r = await receiptPdf(db, await actor("guarantor1"), t.id);
    expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(receiptPdf(db, await actor("linemanager"), t.id)).rejects.toThrow(/do not have access/);
  });

  it("clearance letter only once the loan is closed", async () => {
    await expect(clearancePdf(db, await actor("guarantor1"), loanId)).rejects.toThrow(/fully settled/);
    const q = await settlementQuote(db, loanId);
    const t = await proposeEarlySettlement(db, await actor("bursary"), loanId, { amountReceived: q.settlementAmount, valueDate: todayLagos(), reference: "QTR-SETTLE" });
    await approvePendingTransaction(db, await actor("accadmin"), t.id);
    const c = await clearancePdf(db, await actor("guarantor1"), loanId);
    expect(c.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("changing the terms or closing the product does not touch existing loans", async () => {
    const [active] = (await listPolicyVersions(db, productId)).filter((v) => v.status === "active");
    await expect(setProductActive(db, await actor("accounts"), productId, false)).rejects.toThrow(/not authorised/);
    await saveProductTerms(db, await actor("admin"), productId, { ...DEFAULT_POLICY, repaymentFrequency: "quarterly", minTenorMonths: 3, maxTenorMonths: 12, maxRestructuredTenorMonths: 12, requiredGuarantors: 0, annualInterestRate: 12 });
    await setProductActive(db, await actor("admin"), productId, false);
    const [product] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.id, productId));
    expect(product.isActive).toBe(false);
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.policyVersionId).toBe(active.id);
    expect(loan.status).toBe("closed");
  });
});
