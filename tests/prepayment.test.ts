/**
 * There is no early repayment: a loan is repaid by monthly deduction over the term chosen. Paying more than is
 * due leaves the schedule as it is and holds the excess as an overpayment. A principal waiver (a write-down
 * approved by the Bursar) is the only thing that re-schedules the months left, with interest recalculated.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-prepay-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { respondToGuarantee } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { decideApplication } from "@/server/services/approvals";
import { reviewByBursary } from "@/server/services/bursary";
import { recordDisbursement, recordRepayment, realignSchedule, approvePendingTransaction, proposeWaiver } from "@/server/services/loans";
import { accountBalances, currentSchedule, endOfMonth, proposeReversal } from "@/server/services/ledger";
import { quoteLoan, rescheduleRemaining } from "@/lib/finance/calculator";
import { dec, m, sum } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";

let db: Database;
let productId: string;
const ids: Record<string, string> = {};
const actor = async (k: string) => (await loadActor(db, ids[k], { ip: "127.0.0.1", userAgent: "vitest" }))!;

describe("recalculating interest on the reduced balance", () => {
  it("₦533,333.34 left over 10 months at 10% flat", () => {
    // ₦1,000,000 over 12 months; two instalments paid (₦166,666.66 principal) and ₦300,000 extra.
    const lines = rescheduleRemaining("533333.34", 10, "flat", 10, "2027-01-25");
    expect(sum(lines.map((l) => l.interestDue)).toFixed(2)).toBe("44444.45"); // 533,333.34 × 10% × 10 ÷ 12
    expect(sum(lines.map((l) => l.principalDue)).toFixed(2)).toBe("533333.34");
    expect(lines[0].totalDue).toBe("57777.78"); // 53,333.33 + 4,444.45
    // Was 83,333.34 interest still to come on the old schedule: 38,888.89 is no longer charged.
    expect(dec("83333.34").minus("44444.45").toFixed(2)).toBe("38888.89");
  });

  it("keeps the interest, spread over the same months, when the product gives no rebate", () => {
    const lines = rescheduleRemaining("500000", 10, "flat", 10, "2027-01-25", 1, "83333.34");
    expect(sum(lines.map((l) => l.interestDue)).toFixed(2)).toBe("83333.34");
    expect(lines[0].principalDue).toBe("50000.00");
  });
});

describe("paying more than is due on a live loan", () => {
  let loanId = "";

  beforeAll(async () => {
    db = await getDb();
    await db.transaction(async (tx) => {
      await seedBase(tx);
      const r = await seedFixtures(tx);
      productId = r.productId;
      Object.assign(ids, r.ids);
    });
    const a = await actor("applicant");
    const draft = await saveDraft(db, a, { productId, requestedAmount: "600000", tenorMonths: 12, purpose: "Prepayment test application", guarantorEmails: [(await actor("guarantor1")).email, (await actor("guarantor2")).email] });
    await submitApplication(db, a, draft.id, { termsAccepted: true });
    for (const g of await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, draft.id))) {
      const ga = (await loadActor(db, g.guarantorId))!;
      await respondToGuarantee(db, ga, g.id, { decision: "accept", typedName: ga.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    }
    const gs = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, draft.id), eq(s.applicationGuarantors.status, "accepted")));
    await recordHrDecision(db, await actor("hradmin"), draft.id, { outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true, notes: "Verified for prepayment test.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })) });
    await reviewByBursary(db, await actor("bursary"), draft.id, { decision: "cleared", fundsAvailable: true, comments: "Funds available; deduction check met." });
    await decideApplication(db, await actor("hod"), draft.id, { decision: "approved", comments: "Supported." });
    await decideApplication(db, await actor("hrdirector"), draft.id, { decision: "approved", comments: "Approved." });
    const { loan } = await decideApplication(db, await actor("accadmin"), draft.id, { decision: "approved", comments: "Approved." });
    loanId = loan!.id;
    await recordDisbursement(db, await actor("accounts"), loanId, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "PRE-FT-1", amountDisbursed: loan!.principal, idempotencyKey: "pre-1" });
  });

  /** The schedule always matches the ledger: unpaid principal and interest on it equal the balances. */
  async function expectScheduleMatchesLedger() {
    const bal = await accountBalances(db, loanId);
    const cur = (await currentSchedule(db, loanId))!;
    const open = cur.instalments.filter((i) => i.status !== "superseded");
    expect(sum(open.map((i) => dec(i.principalDue).minus(i.principalPaid))).toFixed(2)).toBe(m(bal.principal));
    expect(sum(open.map((i) => dec(i.interestDue).minus(i.interestPaid))).toFixed(2)).toBe(m(bal.interest));
  }

  it("₦600,000 over 12 months: pay what is due now plus ₦200,000; the term and repayments do not change", async () => {
    const before = (await currentSchedule(db, loanId))!;
    // Reducing balance: =PMT(10%/12, 12, -600000) = 52,749.53 a month; the first is 5,000 interest (600,000 × 10% ÷ 12).
    expect(before.instalments[0]).toMatchObject({ principalDue: "47749.53", interestDue: "5000.00", totalDue: "52749.53" });
    expect(before.instalments.every((i) => i.totalDue === "52749.53")).toBe(true);
    const dueNow = Math.max(1, before.instalments.filter((i) => i.dueDate <= endOfMonth(todayLagos())).length);
    const amount = dec("52749.53").times(dueNow).plus(200000).toFixed(2);
    await recordRepayment(db, await actor("payroll"), loanId, { amount, valueDate: todayLagos(), reference: "PRE-PAY-1", channel: "bank_transfer", idempotencyKey: "pre-pay-1" });

    const cur = (await currentSchedule(db, loanId))!;
    expect(cur.schedule.version).toBe(1);
    expect(cur.instalments).toHaveLength(12);
    const bal = await accountBalances(db, loanId);
    expect(m(bal.overpayment)).toBe("200000.00");
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.id, loanId));
    expect(loan.monthlyInstalment).toBe("52749.53");
    expect(loan.totalInterest).toBe(quoteLoan("600000", 12, "reducing_balance", 10).totalInterest);
    await expectScheduleMatchesLedger();
  });

  it("a principal waiver re-schedules the months left; a payment from before it cannot then be reversed", async () => {
    const [pay] = await db.select().from(s.financialTransactions).where(eq(s.financialTransactions.idempotencyKey, "pre-pay-1"));
    const before = await accountBalances(db, loanId);
    const w = await proposeWaiver(db, await actor("bursary"), loanId, { component: "principal", amount: "40000", reason: "Approved hardship waiver, Bursar's memo" });
    if (w.status === "posted") await realignSchedule(db, await actor("bursary"), loanId);
    else await approvePendingTransaction(db, await actor("accadmin"), w.id);
    const bal = await accountBalances(db, loanId);
    expect(m(bal.principal)).toBe(m(before.principal.minus(40000)));
    expect((await currentSchedule(db, loanId))!.schedule.version).toBe(2);
    await expectScheduleMatchesLedger();
    await expect(proposeReversal(db, await actor("bursary"), pay.id, "Bank returned the transfer")).rejects.toThrow(/corrective adjustment/);
  });
});
