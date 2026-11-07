/**
 * The path every real application takes after go-live: a member of staff with no salary on the HR record
 * (eligibility comes from their payslip) goes through every role, with the reducing-balance figures checked
 * against Excel and the notifications checked at each step.
 */
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { and, eq, gt, asc } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pau-loans-golive-"));

import { getDb, type Database } from "@/db";
import * as s from "@/db/schema";
import { seedBase, seedFixtures } from "@/server/seed";
import { loadActor } from "@/server/services/identity";
import { saveDraft, submitApplication } from "@/server/services/applications";
import { respondToGuarantee } from "@/server/services/guarantors";
import { recordHrDecision } from "@/server/services/hr";
import { reviewByBursary } from "@/server/services/bursary";
import { decideApplication } from "@/server/services/approvals";
import { recordDisbursement, submitRepaymentClaim, confirmRepaymentClaim } from "@/server/services/loans";
import { accountBalances, currentSchedule } from "@/server/services/ledger";
import { todayLagos } from "@/lib/finance/dates";

let db: Database;
let appId: string;
const actor = async (email: string) => {
  const [u] = await db.select().from(s.users).where(eq(s.users.email, email));
  return (await loadActor(db, u.id, { ip: "127.0.0.1", userAgent: "vitest" }))!;
};
const SEUN = "seun.bakare.dev@example.edu.ng";
let since = new Date(0);
/** Who was notified since the last call, as "Name: subject". */
async function notified() {
  const rows = await db.select({ n: s.notifications, name: s.users.displayName }).from(s.notifications).innerJoin(s.users, eq(s.users.id, s.notifications.userId))
    .where(gt(s.notifications.createdAt, since)).orderBy(asc(s.notifications.createdAt));
  if (rows.length) since = rows.at(-1)!.n.createdAt;
  return rows.map((r) => `${r.name}: ${r.n.title}`);
}
const status = async () => (await db.select().from(s.loanApplications).where(eq(s.loanApplications.id, appId)))[0].status;

beforeAll(async () => {
  db = await getDb();
  await db.transaction(async (tx) => { await seedBase(tx); await seedFixtures(tx); });
  await notified();
});

describe("go-live path: payslip only, every role, every notification", () => {
  it("the applicant has no HR salary on record; the Personal Loan is open from installation", async () => {
    const [p] = await db.select().from(s.staffProfiles).innerJoin(s.users, eq(s.users.id, s.staffProfiles.userId)).where(eq(s.users.email, SEUN));
    expect(p.staff_profiles.monthlyBasic).toBeNull();
    const [product] = await db.select().from(s.loanProducts).where(eq(s.loanProducts.code, "PERSONAL"));
    expect(product.isActive).toBe(true);
    const draft = await saveDraft(db, await actor(SEUN), { productId: product.id, requestedAmount: "500000", tenorMonths: 12, purpose: "Go-live path: rent renewal", guarantorEmails: ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"] });
    appId = draft.id;
    // =PMT(10%/12, 12, -500000) = 43,957.94; 12 × 43,957.94 = 527,495.28; each guarantor covers half.
    expect(draft.eligibility.quote).toMatchObject({ monthlyInstalment: "43957.94", totalRepayable: "527495.28", totalInterest: "27495.28" });
    await submitApplication(db, await actor(SEUN), appId, { termsAccepted: true });
    const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, appId));
    expect(gs.map((g) => g.guaranteedAmount)).toEqual(["263747.64", "263747.64"]);
    expect(await notified()).toEqual(expect.arrayContaining([
      "Tunde Bello: Seun Bakare has asked you to be a loan guarantor", "Ngozi Eze: Seun Bakare has asked you to be a loan guarantor", expect.stringMatching(/^Seun Bakare: Loan application .* submitted$/),
    ]));
  });

  it("both guarantors accept; HR is told", async () => {
    for (const email of ["tunde.bello.dev@example.edu.ng", "ngozi.eze.dev@example.edu.ng"]) {
      const g = await actor(email);
      const [row] = await db.select().from(s.applicationGuarantors).where(and(eq(s.applicationGuarantors.applicationId, appId), eq(s.applicationGuarantors.guarantorId, g.userId)));
      await respondToGuarantee(db, g, row.id, { decision: "accept", typedName: g.displayName, confirmations: [true, true, true], relationship: "Colleague", phone: "08030000000" });
    }
    expect(await status()).toBe("pending_hr");
    expect(await notified()).toEqual(expect.arrayContaining([expect.stringMatching(/^Kunle Adeyemi: Application .* is ready for Human Resources verification$/)]));
  });

  it("HR verifies on the payslip alone, which becomes the verified salary; the Bursary Officer is told", async () => {
    const gs = await db.select().from(s.applicationGuarantors).where(eq(s.applicationGuarantors.applicationId, appId));
    await recordHrDecision(db, await actor("kunle.adeyemi.dev@example.edu.ng"), appId, {
      outcome: "verified", employmentVerified: true, salaryVerified: true, staffStatusVerified: true, departmentVerified: true,
      notes: "Verified against the personnel file and payroll.", guarantorAssessments: gs.map((g) => ({ guaranteeId: g.id, outcome: "capable" as const })),
    });
    expect(await status()).toBe("pending_bursary");
    const [p] = await db.select().from(s.staffProfiles).innerJoin(s.users, eq(s.users.id, s.staffProfiles.userId)).where(eq(s.users.email, SEUN));
    expect(p.staff_profiles).toMatchObject({ monthlyNet: "294000.00", salarySource: "hr_verified" });
    expect(await notified()).toEqual(expect.arrayContaining([expect.stringMatching(/^Chioma Nnaji: Application .* is ready for Bursary review$/), expect.stringMatching(/^Seun Bakare: Application .* verified by Human Resources$/)]));
  });

  it("Bursary Officer, HOD, HR Director and Bursar each act in turn, and each next person is told", async () => {
    await reviewByBursary(db, await actor("chioma.nnaji.dev@example.edu.ng"), appId, { decision: "cleared", fundsAvailable: true, comments: "Funds available; within the deduction limit." });
    expect(await notified()).toEqual([expect.stringMatching(/^Funmilayo Adebayo: .* awaiting your approval \(HOD approval\)$/)]);
    await decideApplication(db, await actor("funmi.adebayo.dev@example.edu.ng"), appId, { decision: "approved", comments: "Supported." });
    expect(await notified()).toEqual([expect.stringMatching(/^Halima Musa: .* awaiting your approval \(HR Director approval\)$/)]);
    await decideApplication(db, await actor("halima.musa.dev@example.edu.ng"), appId, { decision: "approved", comments: "Approved." });
    expect(await notified()).toEqual([expect.stringMatching(/^Bisi Lawal: .* awaiting your approval \(Bursar's final approval\)$/)]);
    await decideApplication(db, await actor("bisi.lawal.dev@example.edu.ng"), appId, { decision: "approved", comments: "Final approval." });
    expect(await status()).toBe("approved");
    expect(await notified()).toEqual(expect.arrayContaining([expect.stringMatching(/^Seun Bakare: Loan .* approved$/), expect.stringMatching(/^Chidi Obi: Loan .* ready for disbursement$/)]));
  });

  it("the Accounts Payable Officer disburses; the schedule is level and the ledger balances", async () => {
    const [loan] = await db.select().from(s.loanAccounts).where(eq(s.loanAccounts.applicationId, appId));
    await recordDisbursement(db, await actor("chidi.obi.dev@example.edu.ng"), loan.id, { paymentDate: todayLagos(), paymentMethod: "bank_transfer", transactionReference: "FT-GOLIVE-1", amountDisbursed: loan.principal, idempotencyKey: "golive-1" });
    const sch = (await currentSchedule(db, loan.id))!;
    expect(sch.instalments).toHaveLength(12);
    expect(sch.instalments.every((i) => i.totalDue === "43957.94")).toBe(true);
    expect(sch.instalments[0]).toMatchObject({ interestDue: "4166.67", principalDue: "39791.27" }); // 500,000 × 10% ÷ 12
    expect(sch.instalments.at(-1)!.closingBalance).toBe("0.00");
    const b = await accountBalances(db, loan.id);
    expect([b.principal.toFixed(2), b.interest.toFixed(2)]).toEqual(["500000.00", "27495.28"]);
    expect((await notified()).sort()).toEqual([expect.stringMatching(/^Ngozi Eze: Loan .* disbursed$/), expect.stringMatching(/^Seun Bakare: Loan .* disbursed$/), expect.stringMatching(/^Tunde Bello: Loan .* disbursed$/)]);

    const claim = await submitRepaymentClaim(db, await actor(SEUN), loan.id, { amount: "43957.94", deductionMonth: todayLagos().slice(0, 7), channel: "payroll" });
    expect(await notified()).toEqual([expect.stringMatching(/^Chioma Nnaji: Repayment reported on /)]);
    await confirmRepaymentClaim(db, await actor("chioma.nnaji.dev@example.edu.ng"), claim.id, { amount: "43957.94", valueDate: todayLagos(), bankReference: "PAYROLL-GOLIVE-1" });
    const after = await accountBalances(db, loan.id);
    expect([after.principal.toFixed(2), after.interest.toFixed(2)]).toEqual(["460208.73", "23328.61"]);
    expect(await notified()).toEqual([expect.stringMatching(/^Seun Bakare: Repayment of .* confirmed on /)]);
  });
});
