/**
 * The three approvals after the Bursary Officer: Line Manager, then HR Director, then the
 * Bursar's final approval, which opens the loan account for the Accounts Payable Officer to pay out.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { approvals, bursaryReviews, loanApplications, hrVerifications, applicationGuarantors, applicationMessages, staffProfiles, users } from "@/db/schema";
import { dec, m, formatNaira } from "@/lib/finance/money";
import { quoteLoan, PERIOD_MONTHS } from "@/lib/finance/calculator";
import { can, type Actor } from "../actor";
import { notify } from "../notifications";
import { getSetting } from "../settings";
import { APPROVAL_LEVEL, transition, type WorkflowAction } from "../workflow";
import { approvalStageName, loadWording } from "../wording";
import { DomainError, ForbiddenError, NotFoundError } from "../errors";
import { getPolicyVersion } from "./policies";
import { createLoanAccount } from "./loans";
import { departmentHeadOf, departmentsHeadedBy } from "./staff";
import { LIVE_GUARANTEE_STATUSES } from "./guarantors";
import { monthsText } from "@/lib/finance/dates";

export interface ApprovalDecisionInput {
  decision: "approved" | "declined" | "returned" | "refer_hr";
  /** Bursar only: may approve a lower amount or shorter tenor. */
  approvedAmount?: string;
  approvedTenorMonths?: number;
  comments: string;
}

type App = typeof loanApplications.$inferSelect;

/** Whether this person may decide the application at its current approval level. */
export async function canDecideAt(db: Executor, actor: Actor, app: App): Promise<boolean> {
  if (app.status !== "pending_approval") return false;
  const level = app.currentApprovalLevel || APPROVAL_LEVEL.HOD;
  if (level === APPROVAL_LEVEL.HOD) return (await departmentHeadOf(db, app.applicantId))?.headUserId === actor.userId;
  if (level === APPROVAL_LEVEL.HR_DIRECTOR) return can(actor, "approval.hr_director");
  return can(actor, "approval.decide");
}

/** Tells whoever decides the next level that it is their turn. */
export async function notifyApprovalStage(db: Executor, app: App, level: number, exclude: string[]) {
  const w = await loadWording(db);
  const [applicant] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, app.applicantId));
  const head = await departmentHeadOf(db, app.applicantId);
  const vars = { reference: app.reference, applicantName: applicant.name, amount: formatNaira(app.requestedAmount), stage: approvalStageName(w, level, head?.approverTitle) };
  const target = level === APPROVAL_LEVEL.HOD
    ? { userIds: [head?.headUserId].filter((x): x is string => !!x) }
    : { roles: [level === APPROVAL_LEVEL.HR_DIRECTOR ? "HR_DIRECTOR" as const : "ACCOUNTS_ADMIN" as const] };
  await notify(db, { template: "application.pending_approval", ...target, excludeUserIds: exclude, link: `/approvals/${app.id}`, vars });
}

const ACTIONS: Record<number, Record<"approved" | "declined" | "returned", WorkflowAction>> = {
  [APPROVAL_LEVEL.HOD]: { approved: "hod_approve", declined: "hod_decline", returned: "hod_return" },
  [APPROVAL_LEVEL.HR_DIRECTOR]: { approved: "hrd_approve", declined: "hrd_decline", returned: "hrd_return" },
  [APPROVAL_LEVEL.BURSAR]: { approved: "approve", declined: "approver_decline", returned: "approver_return" },
};

export async function decideApplication(db: Executor, actor: Actor, applicationId: string, input: ApprovalDecisionInput) {
  if (!["approved", "declined", "returned", "refer_hr"].includes(input.decision)) throw new DomainError("Unknown decision.");
  if (input.comments.trim().length < 5) throw new DomainError("Record the basis for your decision.");
  return db.transaction(async (tx) => {
    const [app] = await tx.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).for("update");
    if (!app) throw new NotFoundError("Application");
    if (app.status !== "pending_approval") throw new DomainError("This application is not awaiting approval.");
    const level = app.currentApprovalLevel || APPROVAL_LEVEL.HOD;
    if (!(await canDecideAt(tx, actor, app))) {
      throw new ForbiddenError(level === APPROVAL_LEVEL.HOD ? "Only the applicant's Line Manager can approve at this stage."
        : level === APPROVAL_LEVEL.HR_DIRECTOR ? "Only the HR Director can approve at this stage." : "Only the Bursar can give final approval.");
    }
    const policy = await getPolicyVersion(tx, app.policyVersionId);
    const p = policy.params;
    const [hr] = await tx.select().from(hrVerifications).where(eq(hrVerifications.applicationId, app.id)).orderBy(desc(hrVerifications.createdAt)).limit(1);
    if (!hr || hr.outcome !== "verified") throw new DomainError("This application has no current Human Resources verification.");
    const [bursary] = await tx.select().from(bursaryReviews).where(eq(bursaryReviews.applicationId, app.id)).orderBy(desc(bursaryReviews.createdAt)).limit(1);
    if (!bursary || bursary.decision !== "cleared" || bursary.createdAt < hr.createdAt || !bursary.fundsAvailable) throw new DomainError("The Bursary Officer has not affirmed this application.");

    // One person, one say: whoever approved at an earlier stage of this round, or did the Bursary review, cannot approve again.
    if (input.decision === "approved") {
      const prior = await tx.select({ id: approvals.id }).from(approvals).where(and(
        eq(approvals.applicationId, app.id), eq(approvals.approverId, actor.userId), eq(approvals.decision, "approved"), gt(approvals.createdAt, hr.createdAt)));
      if (prior.length || bursary.reviewerId === actor.userId) throw new ForbiddenError("You have already acted on this application at an earlier stage; a different person must approve this stage.");
    }

    const guarantees = await tx.select({ guarantorId: applicationGuarantors.guarantorId }).from(applicationGuarantors).where(and(eq(applicationGuarantors.applicationId, app.id), inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES])));
    const [applicant] = await tx.select().from(users).where(eq(users.id, app.applicantId));
    const comment = input.comments.trim();
    const baseVars = { reference: app.reference, applicantName: applicant.displayName, comment, amount: formatNaira(app.requestedAmount) };
    const exclude = [actor.userId, app.applicantId, ...guarantees.map((g) => g.guarantorId)];

    if (input.decision === "approved" && level < APPROVAL_LEVEL.BURSAR) {
      await tx.insert(approvals).values({ applicationId: app.id, level, approverId: actor.userId, decision: "approved", comments: comment });
      const updated = await transition(tx, actor, app.id, ACTIONS[level].approved, { comment, patch: { currentApprovalLevel: level + 1 } });
      await notifyApprovalStage(tx, updated, level + 1, exclude);
      return { status: "pending_approval" as const, loan: null };
    }

    if (input.decision === "approved") {
      const amount = m(input.approvedAmount ?? app.requestedAmount);
      const tenor = input.approvedTenorMonths ?? app.tenorMonths;
      if (dec(amount).greaterThan(app.requestedAmount)) throw new DomainError("Approved amount cannot exceed the amount requested.");
      if (dec(amount).lessThanOrEqualTo(0)) throw new DomainError("Enter the approved amount.");
      if (hr.recomputedEligibleAmount && dec(amount).greaterThan(hr.recomputedEligibleAmount)) throw new DomainError(`Approved amount is more than the eligible amount verified by Human Resources of ${formatNaira(hr.recomputedEligibleAmount)}.`);
      if (tenor < p.minTenorMonths || tenor > p.maxTenorMonths) throw new DomainError(`The tenor must be between ${p.minTenorMonths} and ${monthsText(p.maxTenorMonths)}.`);
      // Guarantor obligations were accepted on the original figures; a higher total repayable would need fresh consent.
      const period = PERIOD_MONTHS[p.repaymentFrequency];
      if (tenor % period !== 0) throw new DomainError(`The tenor must be a multiple of ${monthsText(period)} for this product.`);
      const newQuote = quoteLoan(amount, tenor, p.interestMethod, p.annualInterestRate, null, period);
      const originalTotal = (app.quote as { quote?: { totalRepayable: string } }).quote?.totalRepayable;
      if (originalTotal && dec(newQuote.totalRepayable).greaterThan(originalTotal)) throw new DomainError("These terms increase the total repayable above what guarantors accepted. Approve a shorter tenor or lower amount, or return the application.");

      await tx.insert(approvals).values({ applicationId: app.id, level, approverId: actor.userId, decision: "approved", approvedAmount: amount, approvedTenorMonths: tenor, comments: comment });
      const updated = await transition(tx, actor, app.id, "approve", { comment });
      const loan = await createLoanAccount(tx, actor, updated, amount, tenor);
      await notify(tx, { template: "application.approved", userIds: [app.applicantId], link: `/loans/${loan.id}`, vars: { ...baseVars, amount: formatNaira(loan.principal), tenor, instalment: formatNaira(loan.monthlyInstalment), accountNumber: loan.accountNumber } });
      await notify(tx, { template: "loan.ready_for_disbursement", roles: ["ACCOUNTS_OFFICER"], excludeUserIds: [app.applicantId], link: `/accounts/disbursements`, vars: { ...baseVars, accountNumber: loan.accountNumber, amount: formatNaira(loan.principal) } });
      return { status: "approved" as const, loan };
    }

    await tx.insert(approvals).values({ applicationId: app.id, level, approverId: actor.userId, decision: input.decision === "declined" ? "declined" : "returned", comments: comment });
    if (input.decision === "declined") {
      await transition(tx, actor, app.id, ACTIONS[level].declined, { comment });
      await notify(tx, { template: "application.declined", userIds: [app.applicantId, ...guarantees.map((g) => g.guarantorId)], link: `/applications/${app.id}`, vars: baseVars });
    } else if (input.decision === "returned") {
      await transition(tx, actor, app.id, ACTIONS[level].returned, { comment, patch: { currentApprovalLevel: 0 } });
      await tx.insert(applicationMessages).values({ applicationId: app.id, authorId: actor.userId, kind: "correction", body: comment });
      await notify(tx, { template: "application.returned", userIds: [app.applicantId], link: `/applications/${app.id}`, vars: baseVars });
    } else {
      if (level !== APPROVAL_LEVEL.BURSAR) throw new DomainError("Only the Bursar can refer an application back to Human Resources.");
      if (!(await getSetting(tx, "workflow.allowApproverReturnToHr"))) throw new DomainError("Referral back to Human Resources is disabled in system settings.");
      await transition(tx, actor, app.id, "refer_to_hr", { comment, patch: { currentApprovalLevel: 0 } });
      await notify(tx, { template: "application.pending_hr", roles: ["HR_ADMIN"], excludeUserIds: [app.applicantId], link: `/hr/applications/${app.id}`, vars: baseVars });
    }
    return { status: input.decision, loan: null };
  });
}

/** Applications waiting for this person's decision (their department as Head, HR Director, or Bursar). */
export async function myApprovalQueue(db: Executor, actor: Actor) {
  const headed = await departmentsHeadedBy(db, actor.userId);
  const rows = await db.select({ app: loanApplications, departmentId: staffProfiles.departmentId }).from(loanApplications)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanApplications.applicantId))
    .where(eq(loanApplications.status, "pending_approval"));
  return rows.filter(({ app, departmentId }) => {
    const level = app.currentApprovalLevel || APPROVAL_LEVEL.HOD;
    if (app.applicantId === actor.userId) return false;
    if (level === APPROVAL_LEVEL.HOD) return !!departmentId && headed.includes(departmentId);
    if (level === APPROVAL_LEVEL.HR_DIRECTOR) return can(actor, "approval.hr_director");
    return can(actor, "approval.decide");
  }).map((r) => r.app.id);
}
