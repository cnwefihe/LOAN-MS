/**
 * The fund pool, the Payroll Officer's first-deduction confirmation (after which deductions are recorded
 * automatically on their due dates) and early repayment of the whole balance, confirmed by the Payroll
 * Manager with a two-step verification code.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-payroll-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { respondToGuarantee } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import {
  recordDisbursement, submitRepaymentClaim, confirmRepaymentClaim, runServicing, requestEarlyRepayment, confirmEarlyRepayment, earlyRepaymentQuote,
} from "@/server/services/loans";
import { fundPosition, setFundPool } from "@/server/services/funds";
import { currentSchedule } from "@/server/services/ledger";
import { addMonths, firstOfMonth, todayLagos } from "@/lib/finance/dates";
import { dec } from "@/lib/finance/money";
import { encryptString } from "@/lib/security/crypto";
import { generateSecret, totp } from "@/lib/security/totp";

let db: Database;
let productId = "";
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;
const year = Number(todayLagos().slice(0, 4));
const expectErr = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

/** An application taken through HR, ready for the Bursary Officer. */
async function toBursary(amount: string) {
  const a = await actor("applicant");
  const draft = await saveDraft(db, a, { productId, requestedAmount: amount, tenorMonths: 12, purpose: "Payroll flow test application", guarantorEmails: [(await actor("guarantor1")).email, (await actor("guarantor2")).email] });
  await submitApplication(db, a, draft.id, { termsAccepted: true });
  for (const g of await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, draft.id))) {
    const ga = (await loadActor(db, g.guarantorId))!;
    await respondToGuarantee(db, ga, g.id, { decision: "accept", typedName: ga.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
  }
  const gs = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, draft.id), eq(s.applicationGuarantors.status, "accepted")));
  await recordHrDecision(db, await actor("hradmin"), draft.id, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, notes: "Verified for the payroll test.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })) });
  return draft.id;
}

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => {
    await seedBase(tx);
    const r = await seedFixtures(tx);
    productId = r.productId;
    Object.assign(ids, r.ids);
  });
  // This test sets its own pool.
  await db.delete(s.fundPools);
});

describe("the fund pool", () => {
  let appId = "";
  let loanId = "";

  it("an eligible loan is not cleared until the Head of Account sets the pool, nor when the pool cannot cover it", async () => {
    appId = await toBursary("400000");
    const clear = async () => reviewByBursary(db, await actor("bursary"), appId, { decision: "cleared", fundsAvailable: true, comments: "Funds checked." });
    await expectErr(clear(), /has not set the fund pool/);
    await expectErr(setFundPool(db, await actor("bursary"), { year, amount: "1000000" }), /not authorised/);
    await setFundPool(db, await actor("headofaccount"), { year, amount: "300000" });
    await expectErr(clear(), /Only .* of the \d{4} fund pool is left/);
    await setFundPool(db, await actor("headofaccount"), { year, amount: "1000000" });
    await clear();
    expect((await fundPosition(db)).withApproversCount).toBe(1);
  });

  it("paying out reduces what is left, and repayments start the following month", async () => {
    await decideApplication(db, await actor("hod"), appId, { decision: "approved", comments: "Supported." });
    await decideApplication(db, await actor("hrdirector"), appId, { decision: "approved", comments: "Approved." });
    const { loan } = await decideApplication(db, await actor("accadmin"), appId, { decision: "approved", comments: "Approved." });
    loanId = loan!.id;
    await recordDisbursement(db, await actor("accounts"), loanId, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "PAY-FT-1", amountDisbursed: loan!.principal, idempotencyKey: "pay-1" });
    const pos = await fundPosition(db);
    expect(pos).toMatchObject({ paidOut: "400000.00", available: "600000.00", paidOutCount: 1 });
    await expectErr(setFundPool(db, await actor("headofaccount"), { year, amount: "100000" }), /already been paid out/);
    const [l] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(firstOfMonth(l.firstDueDate!)).toBe(firstOfMonth(addMonths(todayLagos(), 1)));
  });

  describe("salary deductions", () => {
    it("the Payroll Officer, not the Bursary Officer, confirms the first deduction; later ones are then recorded automatically", async () => {
      const [l] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
      const claim = await submitRepaymentClaim(db, await actor("applicant"), loanId, { amount: l.monthlyInstalment, deductionMonth: l.firstDueDate!.slice(0, 7) > todayLagos().slice(0, 7) ? todayLagos().slice(0, 7) : l.firstDueDate!.slice(0, 7), channel: "payroll" });
      await expectErr(confirmRepaymentClaim(db, await actor("bursary"), claim.id, { amount: l.monthlyInstalment, valueDate: todayLagos(), bankReference: "PR-1" }), /not authorised/);
      await confirmRepaymentClaim(db, await actor("payroll"), claim.id, { amount: l.monthlyInstalment, valueDate: todayLagos(), bankReference: "PR-1" });
      const [after] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
      expect(after.deductionsConfirmedAt).not.toBeNull();
      await expectErr(submitRepaymentClaim(db, await actor("applicant"), loanId, { amount: l.monthlyInstalment, deductionMonth: todayLagos().slice(0, 7), channel: "payroll" }), /recorded automatically/);
    });

    it("records each later instalment on its due date, once", async () => {
      const cur = (await currentSchedule(db, loanId))!;
      const second = cur.instalments.find((i) => i.sequence === 2)!;
      const r1 = await runServicing(db, null, second.dueDate);
      expect(r1.deductions).toBeGreaterThanOrEqual(1);
      const again = await runServicing(db, null, second.dueDate);
      expect(again.deductions).toBe(0);
      const paid = (await currentSchedule(db, loanId))!.instalments.find((i) => i.sequence === 2)!;
      expect(paid.status).toBe("paid");
      const [l] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
      expect(l.status).toBe("active");
    });
  });

  describe("early repayment of the whole balance", () => {
    const receipt = { buffer: Buffer.from("%PDF-1.4 receipt"), fileName: "receipt.pdf", mimeType: "application/pdf" };

    it("needs the University's account to be set up, and charges interest only up to now", async () => {
      await expectErr(requestEarlyRepayment(db, await actor("applicant"), loanId, { receipt }), /has not been set up/);
      for (const [key, value] of [["earlyRepayment.bankName", "Test Bank"], ["earlyRepayment.accountName", "University Loans"], ["earlyRepayment.accountNumber", "0123456789"]]) {
        await db.update(s.systemSettings).set({ value: value as never }).where(eq(s.systemSettings.key, key));
      }
      const q = await earlyRepaymentQuote(db, loanId);
      const [l] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
      // Principal still owed plus interest to date: less than everything left on the schedule.
      expect(dec(q.settlementAmount).lessThan(dec(l.principalOutstanding).plus(l.interestOutstanding))).toBe(true);
      expect(dec(q.interestSaved).greaterThan(0)).toBe(true);
      expect(dec(q.settlementAmount).equals(dec(q.principal).plus(q.interestDue).minus(q.overpaymentCredit))).toBe(true);
    });

    it("the Payroll Manager marks the loan repaid only with a correct two-step verification code", async () => {
      const r = await requestEarlyRepayment(db, await actor("applicant"), loanId, { payerReference: "FT-EARLY-1", receipt });
      await expectErr(requestEarlyRepayment(db, await actor("applicant"), loanId, { receipt }), /already sent/);
      await expectErr(confirmEarlyRepayment(db, await actor("payroll"), r.id, { code: "000000" }), /not authorised/);
      const manager = await actor("payrollmanager");
      await expectErr(confirmEarlyRepayment(db, manager, r.id, { code: "123456" }), /Set up two-step verification/);
      const secret = generateSecret();
      await db.update(s.users).set({ mfaSecret: encryptString(secret), mfaEnabledAt: new Date() }).where(eq(s.users.id, manager.userId));
      const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, "0");
      await expectErr(confirmEarlyRepayment(db, manager, r.id, { code: wrong }), /not correct/);
      await confirmEarlyRepayment(db, manager, r.id, { code: totp(secret) });
      const [l] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
      expect(l.status).toBe("closed");
      const [done] = await db.select().from(s.earlyRepayments).where(eq(s.earlyRepayments.id, r.id));
      expect(done.status).toBe("confirmed");
      // Nothing more is deducted from a closed loan.
      expect((await runServicing(db, null, addMonths(todayLagos(), 6))).deductions).toBe(0);
    });
  });
});
