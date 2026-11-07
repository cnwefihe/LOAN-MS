/**
 * End-to-end lifecycle against a real Postgres engine (PGlite, in-memory) with all migrations
 * and integrity triggers applied:
 * application → guarantors → HR → Bursary Officer → Line Manager → HR Director → Bursar →
 * payout by the Accounts Payable Officer → repayments confirmed by the Bursary Officer →
 * reversal → overdue monitoring → restructure → early settlement → closure.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { sql, eq, and } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-test-"));
process.env.ALLOWED_EMAIL_DOMAINS = "example.edu.ng";

import { recordSamplePayslip } from "@/server/services/payslips";
import { samplePayslip } from "@/lib/finance/payslip-pdf";
import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import type { Actor } from "@/server/actor";
import { saveDraft, submitApplication, postMessage, getApplicationDetail, computeEligibilityFor } from "@/server/services/applications";
import { setStaffConfirmation } from "@/server/services/staff";
import { respondToGuarantee, guarantorExposure } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import { storeDocument } from "@/server/services/documents";
import {
  recordDisbursement, submitRepaymentClaim, confirmRepaymentClaim, recordRepayment, approvePendingTransaction,
  proposeEarlySettlement, runServicing, requestRestructure, decideRestructure, getLoanDetail,
} from "@/server/services/loans";
import { proposeReversal, settlementQuote, accountBalances } from "@/server/services/ledger";
import { createDraftFrom, updateDraft, submitPolicy, approvePolicy, getActivePolicy } from "@/server/services/policies";
import { dec, m } from "@/lib/finance/money";
import { addMonths, todayLagos } from "@/lib/finance/dates";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";

let db: Database;
const A: Record<string, Actor> = {};
let productId: string;

// 1,100,000 repaid over 12 months; instalments round down to the kobo and the last one takes the remainder.
// ₦1,000,000 over 12 months at 10% a year, reducing balance: Excel =PMT(10%/12, 12, -1000000) = 87,915.89 a month,
// so 12 × 87,915.89 = 1,054,990.68 in all.
const TOTAL = "1054990.68";
const INSTALMENT = "87915.89";
const AFTER_ONE = "967074.79";
const SHARE = m(dec(TOTAL).div(2));

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    for (const [k, id] of Object.entries(r.ids)) A[k] = (await loadActor(tx, id, { ip: "127.0.0.1", userAgent: "vitest" }))!;
  });
});

async function expectErr(p: Promise<unknown>, re: RegExp) {
  await expect(p).rejects.toThrow(re);
}

describe("full loan lifecycle", () => {
  let appId: string;
  let loanId: string;

  it("applicant drafts, uploads documents and submits", async () => {
    const draft = await saveDraft(db, A.applicant, {
      productId, requestedAmount: "1000000", tenorMonths: 12, purpose: "Rent renewal and household relocation costs",
      
      guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"],
    });
    appId = draft.id;
    expect(draft.eligibility.eligible).toBe(true);
    // Flat 10% on 1,000,000 over 12 months = 100,000 interest
    expect(draft.eligibility.quote?.totalRepayable).toBe(TOTAL);

    // The payslip it was assessed on is filed with the application automatically.
    const filed = await db.select().from(s.documents).where(and(eq(s.documents.applicationId, appId), eq(s.documents.requirementCode, "PAYSLIP")));
    expect(filed).toHaveLength(1);
    await storeDocument(db, A.applicant, { buffer: PDF, fileName: "payslip.pdf", mimeType: "application/pdf", category: "applicant_supporting", title: "Payslip", ownerUserId: A.applicant.userId, applicationId: appId, requirementCode: "PAYSLIP" });
    await expectErr(submitApplication(db, A.applicant, appId, { termsAccepted: false }), /accept the loan terms/);
    await submitApplication(db, A.applicant, appId, { termsAccepted: true });

    const d = await getApplicationDetail(db, A.applicant, appId);
    expect(d.app.status).toBe("pending_guarantor");
    expect(d.guarantors).toHaveLength(2);
    expect(d.guarantors.every((g) => g.g.guaranteedAmount === SHARE)).toBe(true);
    const notes = await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "guarantor.invited"));
    expect(notes).toHaveLength(2);
    // Emails greet people by first name only.
    expect(notes.map((n) => n.body.split("\n")[0]).sort()).toEqual(["Dear Ngozi,", "Dear Tunde,"]);
    const outbox = await db.select().from(s.emailOutbox);
    expect(outbox.length).toBeGreaterThan(0);
  });

  it("blocks stage-skipping and unauthorised actors", async () => {
    await expectErr(recordHrDecision(db, A.hradmin, appId, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, notes: "Trying to skip guarantors", guarantorAssessments: [] }), /not awaiting Human Resources/);
    await expectErr(recordHrDecision(db, A.applicant, appId, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, notes: "Self-verification attempt", guarantorAssessments: [] }), /not authorised/);
  });

  it("guarantors accept with electronic acknowledgement, after a clarification round", async () => {
    // Actors are rebuilt per request in the app; nomination granted these users the Guarantor role.
    for (const k of ["guarantor1", "guarantor2"]) A[k] = (await loadActor(db, A[k].userId, { ip: "127.0.0.1", userAgent: "vitest" }))!;
    expect(A.guarantor1.roles).toContain("GUARANTOR");
    const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, appId));
    const g1 = gs.find((g) => g.guarantorId === A.guarantor1.userId)!;
    const g2 = gs.find((g) => g.guarantorId === A.guarantor2.userId)!;
    await expectErr(respondToGuarantee(db, A.guarantor2, g1.id, { decision: "decline", reason: "not mine" }), /not authorised/);
    await expectErr(respondToGuarantee(db, A.guarantor1, g1.id, { decision: "accept", typedName: "Someone Else", confirmations: [true, true], relationship: "Colleague", phone: "08030000000" }), /Type your full name/);
    await respondToGuarantee(db, A.guarantor1, g1.id, { decision: "accept", typedName: "tunde bello", confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    await respondToGuarantee(db, A.guarantor2, g2.id, { decision: "clarify", question: "Is this loan in addition to any existing loan?" });
    await postMessage(db, A.applicant, appId, "clarification", "No, I have no other loans with the University.");
    await respondToGuarantee(db, A.guarantor2, g2.id, { decision: "accept", typedName: "Ngozi Eze", confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });

    const [accepted] = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.id, g1.id));
    expect(accepted.acknowledgementHash).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.agreementVersion).toBe(1);
    expect(accepted.acknowledgedIp).toBe("127.0.0.1");
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(app.status).toBe("pending_hr");
    const exp = await guarantorExposure(db, A.guarantor1.userId);
    expect(exp.total).toBe(SHARE);
  });

  it("HR verifies employment, salary and guarantor capacity", async () => {
    const gs = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, appId), eq(s.applicationGuarantors.status, "accepted")));
    const base = { employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, monthlyBasic: "300000", monthlyGross: "450000", monthlyNet: "380000", notes: "Confirmed against payroll records and personnel file." };
    await expectErr(recordHrDecision(db, A.hradmin, appId, { ...base, outcome: "verified", guarantorAssessments: [] }), /Assess every guarantor/);
    await recordHrDecision(db, A.hradmin, appId, { ...base, outcome: "verified", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })) });
    await expectErr(reviewByBursary(db, A.accadmin, appId, { decision: "cleared", fundsAvailable: true, comments: "The Bursar is not the Bursary Officer." }), /not authorised/);
    await reviewByBursary(db, A.bursary, appId, { decision: "cleared", fundsAvailable: true, comments: "Funds available; take-home pay check met." });
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(app.status).toBe("pending_approval");
    const [prof] = await db.select().from(s.staffProfiles).where(eq(s.staffProfiles.userId, A.applicant.userId));
    expect(prof.salarySource).toBe("hr_verified");
  });

  it("Line Manager, then HR Director, then the Bursar approve, each in turn", async () => {
    // Each stage belongs to one person: nobody can approve ahead of their turn.
    await expectErr(decideApplication(db, A.accadmin, appId, { decision: "approved", comments: "Bursar trying to go first" }), /Line Manager/);
    await expectErr(decideApplication(db, A.hrdirector, appId, { decision: "approved", comments: "HR Director trying to go first" }), /Line Manager/);
    expect((await decideApplication(db, A.hod, appId, { decision: "approved", comments: "Supported by the department." })).status).toBe("pending_approval");
    await expectErr(decideApplication(db, A.hod, appId, { decision: "approved", comments: "Approving twice" }), /Only the HR Director/);
    expect((await decideApplication(db, A.hrdirector, appId, { decision: "approved", comments: "Employment in good standing." })).status).toBe("pending_approval");
    const [app] = await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId));
    expect(app.currentApprovalLevel).toBe(3);
  });

  it("the Bursar's final approval opens a loan account with generated agreements", async () => {
    await expectErr(decideApplication(db, A.accadmin, appId, { decision: "approved", approvedAmount: "2000000", comments: "Too much" }), /cannot exceed/);
    const r = await decideApplication(db, A.accadmin, appId, { decision: "approved", comments: "Approved per policy; HR verification satisfactory." });
    expect(r.status).toBe("approved");
    loanId = r.loan!.id;
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.status).toBe("pending_disbursement");
    expect(loan.totalRepayable).toBe(TOTAL);
    expect(loan.monthlyInstalment).toBe(INSTALMENT);
    const agreements = await db.select().from(s.loanAgreements).where(eq(s.loanAgreements.loanAccountId, loanId));
    expect(agreements.map((a) => a.type).sort()).toEqual(["guarantor", "guarantor", "loan"]);
    const transitions = await db.select().from(s.workflowTransitions).where(eq(s.workflowTransitions.applicationId, appId));
    expect(transitions.map((t) => t.toStatus)).toEqual(["draft", "pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "pending_approval", "pending_approval", "approved"]);
  });

  it("the Accounts Payable Officer's payout activates the loan and posts a balanced ledger", async () => {
    const payDate = todayLagos();
    await expectErr(recordDisbursement(db, A.bursary, loanId, { paymentDate: payDate, paymentMethod: "bank_transfer", transactionReference: "FT-0001", amountDisbursed: "1000000", idempotencyKey: "k0" }), /not authorised/);
    await expectErr(recordDisbursement(db, A.accounts, loanId, { paymentDate: payDate, paymentMethod: "bank_transfer", transactionReference: "FT-0001", amountDisbursed: "999999", idempotencyKey: "k1" }), /must equal the approved amount/);
    const d = await recordDisbursement(db, A.accounts, loanId, { paymentDate: payDate, paymentMethod: "bank_transfer", transactionReference: "FT-0001", amountDisbursed: "1000000", idempotencyKey: "k2" });
    expect(d.status).toBe("pending_confirmation"); // the record as inserted; confirmed in the same transaction
    // Idempotent retry returns the same record
    const again = await recordDisbursement(db, A.accounts, loanId, { paymentDate: payDate, paymentMethod: "bank_transfer", transactionReference: "FT-0001", amountDisbursed: "1000000", idempotencyKey: "k2" });
    expect(again.id).toBe(d.id);
    expect(again.status).toBe("confirmed");

    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.status).toBe("active");
    expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe(TOTAL);
    const detail = await getLoanDetail(db, A.accadmin, loanId);
    expect(detail.schedule!.instalments).toHaveLength(12);
    const res = (await db.execute(sql`select sum(case when direction='debit' then amount else -amount end) as net from ledger_entries`)) as unknown as { rows: { net: string }[] };
    const [bal] = res.rows;
    expect(dec(bal.net).isZero()).toBe(true);
  });

  it("applicant deduction reports do not change balances until the Bursary Officer confirms", async () => {
    const claim = await submitRepaymentClaim(db, A.applicant, loanId, { amount: INSTALMENT, deductionMonth: todayLagos().slice(0, 7), channel: "payroll" });
    let [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe(TOTAL);
    await expectErr(confirmRepaymentClaim(db, A.applicant, claim.id, { amount: INSTALMENT, valueDate: todayLagos(), bankReference: "PAY-1" }), /not authorised/);
    await expectErr(confirmRepaymentClaim(db, A.accounts, claim.id, { amount: INSTALMENT, valueDate: todayLagos(), bankReference: "PAY-1" }), /not authorised/);
    await confirmRepaymentClaim(db, A.bursary, claim.id, { amount: INSTALMENT, valueDate: todayLagos(), bankReference: "PAYROLL-OCT-001" });
    [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe(AFTER_ONE);
    expect(loan.totalRepaid).toBe(INSTALMENT);
    const detail = await getLoanDetail(db, A.applicant, loanId);
    expect(detail.schedule!.instalments[0].status).toBe("paid");
    const [c] = await db.select().from(s.repaymentClaims).where(eq(s.repaymentClaims.id, claim.id));
    expect(c.status).toBe("confirmed");
  });

  it("blocks duplicate payment references", async () => {
    await expectErr(recordRepayment(db, A.bursary, loanId, { amount: INSTALMENT, valueDate: todayLagos(), reference: "PAYROLL-OCT-001", channel: "payroll", idempotencyKey: "dup-1" }), /already been recorded/);
  });

  it("database refuses to modify or delete ledger and audit records", async () => {
    // Drizzle wraps driver errors; the trigger's message is on `cause`.
    const dbErr = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { return String((e as { cause?: Error }).cause?.message ?? (e as Error).message); }
      return "no error";
    };
    expect(await dbErr(db.execute(sql`update ledger_entries set amount = 1`))).toMatch(/append-only/);
    expect(await dbErr(db.execute(sql`delete from audit_logs`))).toMatch(/append-only/);
    expect(await dbErr(db.execute(sql`delete from financial_transactions`))).toMatch(/cannot be deleted/);
    expect(await dbErr(db.execute(sql`update financial_transactions set amount = 1 where status = 'posted'`))).toMatch(/can no longer be modified/);
    expect(await dbErr(db.execute(sql`update workflow_transitions set comment = 'tampered'`))).toMatch(/append-only/);
  });

  it("reversals require checker approval and restore the balance", async () => {
    const txn = await recordRepayment(db, A.bursary, loanId, { amount: "50000", valueDate: todayLagos(), reference: "BANK-REV-TEST", channel: "bank_transfer", idempotencyKey: "rev-src" });
    let [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe(m(dec(AFTER_ONE).minus(50000)));
    const rev = await proposeReversal(db, A.bursary, txn.id, "Receipt bounced: the bank recalled the transfer");
    expect(rev.status).toBe("pending_approval");
    await expectErr(approvePendingTransaction(db, A.bursary, rev.id), /not authorised|cannot approve/);
    await approvePendingTransaction(db, A.accadmin, rev.id);
    [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe(AFTER_ONE);
    await expectErr(proposeReversal(db, A.bursary, txn.id, "Second reversal attempt"), /already has a reversal/);
  });

  it("servicing marks unpaid loans overdue and recovers when brought current", async () => {
    const future = addMonths(todayLagos(), 4);
    const r = await runServicing(db, null, future);
    expect(r.changes.join()).toMatch(/active → (overdue|defaulted)/);
    await runServicing(db, null, todayLagos());
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.status).toBe("active");
  });

  it("policy changes never alter an existing loan", async () => {
    const draft = await createDraftFrom(db, A.admin, productId);
    await updateDraft(db, A.admin, draft.id, { ...DEFAULT_POLICY, annualInterestRate: 20 }, "Raise rate to 20% from next quarter");
    await submitPolicy(db, A.admin, draft.id);
    await approvePolicy(db, A.admin, draft.id); // one administrator drafts and approves
    const active = await getActivePolicy(db, productId);
    expect(active!.params.annualInterestRate).toBe(20);
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.annualInterestRate).toBe("10.0000");
    expect(loan.policyVersionId).not.toBe(active!.id);
  });

  it("restructures the remaining balance onto a new schedule", async () => {
    const req = await requestRestructure(db, A.applicant, loanId, { proposedTenorMonths: 12, reason: "Unexpected medical expenses reduce my take-home pay." });
    const ns = await decideRestructure(db, A.accadmin, req.id, true, "Approved on hardship grounds.");
    expect(ns!.version).toBe(2);
    const detail = await getLoanDetail(db, A.accadmin, loanId);
    expect(detail.schedule!.instalments).toHaveLength(12);
    const bal = await accountBalances(db, loanId);
    const scheduleTotal = detail.schedule!.instalments.reduce((acc, i) => acc.plus(i.totalDue), dec(0));
    expect(m(bal.principal.plus(bal.interest))).toBe(m(scheduleTotal));
  });

  it("early settlement closes the loan and releases guarantors", async () => {
    const q = await settlementQuote(db, loanId);
    expect(dec(q.settlementAmount).greaterThan(0)).toBe(true);
    const t = await proposeEarlySettlement(db, A.bursary, loanId, { amountReceived: q.settlementAmount, valueDate: todayLagos(), reference: "SETTLE-001" });
    expect(t.status).toBe("pending_approval");
    await approvePendingTransaction(db, A.accadmin, t.id);
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.status).toBe("closed");
    expect(m(dec(loan.principalOutstanding).plus(loan.interestOutstanding))).toBe("0.00");
    const exp = await guarantorExposure(db, A.guarantor1.userId);
    expect(exp.total).toBe("0.00");
    const closed = await db.select().from(s.notifications).where(eq(s.notifications.templateCode, "loan.closed"));
    expect(closed.length).toBe(3); // borrower + 2 guarantors
  });

  it("staff below the minimum service are ineligible", async () => {
    const [u] = await db.insert(s.users).values({ email: "recent.joiner.dev@example.edu.ng", displayName: "Recent Joiner", isDevFixture: true }).returning();
    const [role] = await db.select().from(s.roles).where(eq(s.roles.code, "APPLICANT"));
    await db.insert(s.userRoles).values({ userId: u.id, roleId: role.id });
    await db.insert(s.staffProfiles).values({ userId: u.id, staffNumber: "DEV-9001", employmentStatus: "confirmed", employmentDate: addMonths(todayLagos(), -6) });
    const recent = (await loadActor(db, u.id, { ip: "127.0.0.1", userAgent: "vitest" }))!;
    await expectErr(saveDraft(db, recent, { productId, requestedAmount: "100000", tenorMonths: 6, purpose: "Testing eligibility rules", guarantorEmails: [] }), /Upload your latest payslip first/);
    await recordSamplePayslip(db, recent, u.id, samplePayslip({ name: "Recent Joiner", code: "DEV-9001", grade: "Officer", period: todayLagos().slice(0, 7), basic: "300000", medical: "20000", tax: "30000", pension: "24000" }));
    await expectErr(saveDraft(db, recent, { productId, requestedAmount: "100000", tenorMonths: 6, purpose: "Testing eligibility rules", guarantorEmails: [] })
      .then((r) => { if (!r.eligibility.eligible) throw new Error(r.eligibility.reasons.join(" ")); }), /minimum of .* of service/);
  });

  it("HR's Confirmed / Not confirmed switch decides loan eligibility on the server", async () => {
    const policy = (await getActivePolicy(db, productId))!.params;
    const check = async () => (await computeEligibilityFor(db, A.guarantor2.userId, policy, { requestedAmount: "100000", tenorMonths: 12 })).reasons.join(" ");
    await expectErr(setStaffConfirmation(db, A.guarantor2, A.guarantor1.userId, false), /not authorised/);
    await setStaffConfirmation(db, A.hradmin, A.guarantor2.userId, false);
    expect(await check()).toMatch(/does not show you as confirmed/);
    await setStaffConfirmation(db, A.hradmin, A.guarantor2.userId, true);
    expect(await check()).not.toMatch(/confirmed/);
  });
});
