/**
 * Bursary review: the "Bursary information" section of the paper loan form. Loan history and the
 * take-home pay test are filled in from records; the Bursary Officer affirms that the applicant meets
 * the terms and funds are available, and sends the application to the Line Manager.
 */
import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import type { Executor } from "@/db";
import { applicationGuarantors, applicationMessages, bursaryReviews, hrVerifications, loanAccounts, loanApplications, users } from "@/db/schema";
import { dec, formatNaira, m, sum } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { assertCan, type Actor } from "../actor";
import { notify } from "../notifications";
import { transition } from "../workflow";
import { DomainError, NotFoundError } from "../errors";
import { getPolicyVersion } from "./policies";
import { computeEligibilityFor, assessedWith } from "./applications";
import { assertFundsFor, fundPosition, schoolForApplication } from "./funds";
import { getPayslip } from "./payslips";
import { LIVE_GUARANTEE_STATUSES } from "./guarantors";
import { departmentHeadOf } from "./staff";
import { APPROVAL_LEVEL } from "../workflow";
import { notifyApprovalStage } from "./approvals";

export type BursaryDecision = "cleared" | "declined" | "returned" | "refer_hr";

/** Everything the Bursar needs on one page, worked out from the records. */
export async function bursaryWorksheet(db: Executor, applicationId: string) {
  const [app] = await db.select().from(loanApplications).where(eq(loanApplications.id, applicationId));
  if (!app) throw new NotFoundError("Application");
  const policy = await getPolicyVersion(db, app.policyVersionId);
  const p = policy.params;
  // Previous loans in this system: the latest one taken, and when it was fully repaid.
  const [last] = await db.select({ accountNumber: loanAccounts.accountNumber, disbursedAt: loanAccounts.disbursedAt, approvedAt: loanAccounts.approvedAt, closedAt: loanAccounts.closedAt, status: loanAccounts.status, principal: loanAccounts.principal })
    .from(loanAccounts).where(and(eq(loanAccounts.borrowerId, app.applicantId), ne(loanAccounts.applicationId, app.id), ne(loanAccounts.status, "cancelled")))
    .orderBy(desc(loanAccounts.approvedAt)).limit(1);
  const elig = await computeEligibilityFor(db, app.applicantId, p, { requestedAmount: app.requestedAmount, tenorMonths: app.tenorMonths, excludeApplicationId: app.id, ...assessedWith(app) });
  // Deduction check: everything deducted after this loan (payslip deductions, guarantees and this
  // loan's instalment) must stay within the limit, a share of net pay from the payslip.
  const slip = elig.payslip;
  const net = dec(slip?.netPay ?? 0);
  const instalment = dec(elig.instalmentMonthly ?? 0);
  const committed = dec(elig.existingMonthlyDeductions);
  const totalAfter = committed.plus(instalment);
  const payslip = await getPayslip(db, elig.payslipId);
  const deductionPassed = !!slip && !slip.problems.length && totalAfter.lessThanOrEqualTo(elig.monthlyDeductionCap);
  // Funding position: approved loans not yet paid out, and payouts already made this month.
  const awaiting = await db.select({ principal: loanAccounts.principal }).from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement"));
  const monthStart = new Date(`${todayLagos().slice(0, 7)}-01T00:00:00+01:00`);
  const paidThisMonth = await db.select({ principal: loanAccounts.principal }).from(loanAccounts).where(gt(loanAccounts.disbursedAt, monthStart));
  const [hr] = await db.select({ v: hrVerifications, officer: users.displayName }).from(hrVerifications).innerJoin(users, eq(users.id, hrVerifications.officerId))
    .where(eq(hrVerifications.applicationId, app.id)).orderBy(desc(hrVerifications.createdAt)).limit(1);
  const reviews = await db.select({ r: bursaryReviews, reviewer: users.displayName }).from(bursaryReviews).innerJoin(users, eq(users.id, bursaryReviews.reviewerId))
    .where(eq(bursaryReviews.applicationId, app.id)).orderBy(desc(bursaryReviews.createdAt));
  // The pool of the school the applicant's department belongs to; none when the department is not in a school.
  const schoolId = await schoolForApplication(db, app);
  return {
    app, policy: p, elig, hr: hr ?? null, reviews,
    lastLoan: last ? { accountNumber: last.accountNumber, takenOn: (last.disbursedAt ?? last.approvedAt).toISOString().slice(0, 10), repaidOn: last.closedAt ? last.closedAt.toISOString().slice(0, 10) : null, status: last.status, principal: last.principal } : null,
    deductions: {
      period: payslip?.period ?? null, payForLending: slip?.payForLending ?? "0.00", net: m(net), capPercent: p.maxDeductionPercent, limit: elig.monthlyDeductionCap,
      committed: m(committed), deduction: m(instalment), after: m(totalAfter),
      percent: net.greaterThan(0) ? totalAfter.div(net).times(100).toFixed(1) : "0.0", passed: deductionPassed,
    },
    fund: schoolId ? await fundPosition(db, schoolId, undefined, { excludeApplicationId: app.id }) : null,
    funding: { awaitingPayout: m(sum(awaiting.map((a) => a.principal))), awaitingCount: awaiting.length, paidThisMonth: m(sum(paidThisMonth.map((a) => a.principal))) },
  };
}

export async function reviewByBursary(db: Executor, actor: Actor, applicationId: string, input: {
  decision: BursaryDecision; fundsAvailable: boolean; comments: string; lastLoanDate?: string | null; lastLoanRepaidDate?: string | null;
}) {
  assertCan(actor, "bursary.review");
  if (input.comments.trim().length < 5) throw new DomainError("Record the basis for your decision.");
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).for("update");
    if (!app) throw new NotFoundError("Application");
    if (app.status !== "pending_bursary") throw new DomainError("This application is not awaiting Bursary review.");
    const w = await bursaryWorksheet(tx, app.id);
    const head = await departmentHeadOf(tx, app.applicantId);
    if (input.decision === "cleared") {
      if (!input.fundsAvailable) throw new DomainError("Confirm that funds are available before clearing the application.");
      if (!head?.headUserId) throw new DomainError(head ? `${head.department} has no Line Manager. Ask the administrator to set one under Administration > Organisation.` : "The applicant has no department on their staff record. Ask Human Resources to set it.");
      if (!w.deductions.passed) throw new DomainError(`Deductions after this loan would be ${w.deductions.percent}% of net pay, above the ${w.deductions.capPercent}% limit. Return or decline the application.`);
      // Even an eligible loan is not cleared when its school's fund pool for the year cannot cover it.
      const schoolId = await schoolForApplication(tx, app, { save: true });
      await assertFundsFor(tx, { amount: app.requestedAmount, isAdvance: !!app.advanceType, stage: "clear", schoolId, applicationId: app.id });
    }
    const lastLoanDate = input.lastLoanDate || w.lastLoan?.takenOn || null;
    const lastLoanRepaidDate = input.lastLoanRepaidDate || w.lastLoan?.repaidOn || null;
    if (lastLoanDate && lastLoanRepaidDate && lastLoanRepaidDate < lastLoanDate) throw new DomainError("The date fully repaid cannot be before the date the loan was taken.");
    await tx.insert(bursaryReviews).values({
      applicationId: app.id, reviewerId: actor.userId, decision: input.decision === "refer_hr" ? "returned" : input.decision, lastLoanDate, lastLoanRepaidDate,
      monthlyGross: w.deductions.payForLending, monthlyNet: w.deductions.net, monthlyDeduction: w.deductions.deduction, takeHomeAfter: w.deductions.after,
      takeHomePercent: w.deductions.percent, takeHomeTestPassed: w.deductions.passed, fundsAvailable: input.fundsAvailable, comments: input.comments.trim(),
    });
    const guarantees = await tx.select({ id: applicationGuarantors.guarantorId }).from(applicationGuarantors).where(and(eq(applicationGuarantors.applicationId, app.id), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])));
    const [applicant] = await tx.select().from(users).where(eq(users.id, app.applicantId));
    const vars = { reference: app.reference, applicantName: applicant.displayName, amount: formatNaira(app.requestedAmount), comment: input.comments.trim(), level: 1 };
    const exclude = [app.applicantId, ...guarantees.map((g) => g.id)];
    if (input.decision === "cleared") {
      // A Line Manager applying for their own loan goes straight to the HR Director.
      const ownHead = head!.headUserId === app.applicantId;
      const level = ownHead ? APPROVAL_LEVEL.HR_DIRECTOR : APPROVAL_LEVEL.HOD;
      const comment = ownHead ? `${input.comments.trim()} (The applicant is the approver for ${head!.department}, so it goes straight to the HR Director.)` : input.comments.trim();
      const updated = await transition(tx, actor, app.id, "bursary_clear", { comment, patch: { currentApprovalLevel: level } });
      await notifyApprovalStage(tx, updated, level, [actor.userId, ...exclude]);
    } else if (input.decision === "returned") {
      await transition(tx, actor, app.id, "bursary_return", { comment: input.comments.trim() });
      await tx.insert(applicationMessages).values({ applicationId: app.id, authorId: actor.userId, kind: "correction", body: input.comments.trim() });
      await notify(tx, { template: "application.returned", userIds: [app.applicantId], link: `/applications/${app.id}`, vars });
    } else if (input.decision === "refer_hr") {
      await transition(tx, actor, app.id, "bursary_refer_hr", { comment: input.comments.trim() });
      await notify(tx, { template: "application.pending_hr", roles: ["HR_ADMIN"], excludeUserIds: exclude, link: `/hr/applications/${app.id}`, vars });
    } else {
      await transition(tx, actor, app.id, "bursary_decline", { comment: input.comments.trim() });
      await notify(tx, { template: "application.declined", userIds: exclude, link: `/applications/${app.id}`, vars });
    }
  });
}

/** Applications waiting for the Bursary Officer, oldest first. */
export async function bursaryQueue(db: Executor, actor: Actor) {
  assertCan(actor, "bursary.review");
  return db.select({ app: loanApplications, applicant: users.displayName }).from(loanApplications).innerJoin(users, eq(users.id, loanApplications.applicantId))
    .where(eq(loanApplications.status, "pending_bursary")).orderBy(loanApplications.updatedAt);
}
