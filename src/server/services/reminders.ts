/**
 * Reminders for work left waiting, run by the scheduled checks. Timings are set by administrators
 * under Settings > Reminders: the team responsible is reminded after its threshold and then at the
 * repeat interval; anything older than the alert threshold is also raised with Super Administrators.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanApplications, loanAccounts, repaymentClaims, financialTransactions, workflowTransitions, users, applicationGuarantors } from "@/db/schema";
import type { RoleCode } from "@/lib/auth/permissions";
import { formatNaira } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { durationText, waitedText } from "@/lib/duration";
import { getSettings } from "../settings";
import { notify } from "../notifications";
import { approvalStageName, loadWording } from "../wording";
import { APPROVAL_LEVEL } from "../workflow";
import { departmentHeadOf } from "./staff";

interface Waiting { kind: string; id: string; reference: string; detail: string; since: Date; stage: string; item: string; roles: RoleCode[]; userIds?: string[]; link: string; exclude: string[]; threshold: number }

/** Whole minutes an item has waited: measured from now when the job runs today. */
export const ageMinutes = (since: Date, asOf: string) => Math.floor(((asOf === todayLagos() ? Date.now() : Date.parse(`${asOf}T23:59:00+01:00`)) - since.getTime()) / 60_000);

export async function remindWaitingWork(db: Executor, asOf: string): Promise<{ reminders: number; escalations: number }> {
  const cfg = await getSettings(db, ["reminders.enabled", "reminders.hrMinutes", "reminders.approvalMinutes", "reminders.accountsMinutes", "reminders.escalateMinutes", "reminders.repeatMinutes"]);
  if (!cfg["reminders.enabled"]) return { reminders: 0, escalations: 0 };
  const items: Waiting[] = [];

  // Applications: waiting since they entered their current stage.
  const w = await loadWording(db);
  const apps = await db.select({
    id: loanApplications.id, reference: loanApplications.reference, status: loanApplications.status, level: loanApplications.currentApprovalLevel, amount: loanApplications.requestedAmount, applicantId: loanApplications.applicantId, applicant: users.displayName,
    since: sql<Date>`(select max(${workflowTransitions.createdAt}) from ${workflowTransitions} where ${workflowTransitions.applicationId} = ${loanApplications.id})`,
  }).from(loanApplications).innerJoin(users, eq(users.id, loanApplications.applicantId)).where(inArray(loanApplications.status, ["pending_hr", "pending_bursary", "pending_approval"]));
  for (const a of apps) {
    const guarantors = (await db.select({ id: applicationGuarantors.guarantorId }).from(applicationGuarantors).where(eq(applicationGuarantors.applicationId, a.id))).map((g) => g.id);
    const level = a.level || APPROVAL_LEVEL.HOD;
    const dept = a.status === "pending_approval" && level === APPROVAL_LEVEL.HOD ? await departmentHeadOf(db, a.applicantId) : null;
    const head = dept?.headUserId ?? null;
    const stage = a.status === "pending_hr"
      ? { kind: "hr", stage: w.stage.hr, roles: ["HR_ADMIN"] as RoleCode[], link: `/hr/applications/${a.id}`, threshold: cfg["reminders.hrMinutes"] }
      : a.status === "pending_bursary"
        ? { kind: "bursary", stage: w.stage.bursary, roles: ["BURSARY_OFFICER"] as RoleCode[], link: `/bursary/review/${a.id}`, threshold: cfg["reminders.accountsMinutes"] }
        : {
          kind: `approval${level}`, stage: approvalStageName(w, level, dept?.approverTitle), link: `/approvals/${a.id}`, threshold: cfg["reminders.approvalMinutes"],
          roles: (level === APPROVAL_LEVEL.HOD ? [] : level === APPROVAL_LEVEL.HR_DIRECTOR ? ["HR_DIRECTOR"] : ["ACCOUNTS_ADMIN"]) as RoleCode[], userIds: head ? [head] : [],
        };
    items.push({ ...stage, id: a.id, reference: a.reference, detail: `${a.applicant}, ${formatNaira(a.amount)}`, since: new Date(a.since), item: "Application", exclude: [a.applicantId, ...guarantors] });
  }

  const accounts = cfg["reminders.accountsMinutes"];
  const toPay = await db.select({ id: loanAccounts.id, reference: loanAccounts.accountNumber, principal: loanAccounts.principal, borrowerId: loanAccounts.borrowerId, since: loanAccounts.createdAt })
    .from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement"));
  for (const l of toPay) items.push({ kind: "payout", id: l.id, reference: l.reference, detail: formatNaira(l.principal), since: l.since, stage: "disbursement by the Accounts Payable Officer", item: "Approved loan", roles: ["ACCOUNTS_OFFICER"], link: "/accounts/disbursements", exclude: [l.borrowerId], threshold: accounts });

  const claims = await db.select({ id: repaymentClaims.id, reference: loanAccounts.accountNumber, amount: repaymentClaims.amount, claimedBy: repaymentClaims.claimedBy, since: repaymentClaims.createdAt })
    .from(repaymentClaims).innerJoin(loanAccounts, eq(loanAccounts.id, repaymentClaims.loanAccountId)).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId)));
  for (const c of claims) items.push({ kind: "claim", id: c.id, reference: c.reference, detail: `deduction of ${formatNaira(c.amount)} reported by the borrower`, since: c.since, stage: "confirmation by the Payroll Officer", item: "Repayment", roles: ["PAYROLL_OFFICER"], link: "/accounts/repayments", exclude: [c.claimedBy], threshold: accounts });

  const checker = await db.select({ id: financialTransactions.id, reference: financialTransactions.reference, type: financialTransactions.type, amount: financialTransactions.amount, makerId: financialTransactions.makerId, since: financialTransactions.createdAt })
    .from(financialTransactions).where(eq(financialTransactions.status, "pending_approval"));
  for (const t of checker) items.push({ kind: "checker", id: t.id, reference: t.reference, detail: `${t.type.replace(/_/g, " ")} of ${formatNaira(t.amount)}`, since: t.since, stage: "checker approval", item: "Transaction", roles: ["ACCOUNTS_ADMIN"], link: "/accounts/approvals", exclude: [t.makerId], threshold: accounts });

  let reminders = 0, escalations = 0;
  const repeat = cfg["reminders.repeatMinutes"];
  const escalate = cfg["reminders.escalateMinutes"];
  for (const w of items) {
    const age = ageMinutes(w.since, asOf);
    if (age < w.threshold) continue;
    const period = Math.floor((age - w.threshold) / repeat);
    const vars = { item: w.item, reference: w.reference, detail: w.detail, stage: w.stage, days: waitedText(age), limit: durationText(escalate) };
    await notify(db, { template: "reminder.work", roles: w.roles, userIds: w.userIds, excludeUserIds: w.exclude, link: w.link, dedupeKey: `work:${w.kind}:${w.id}:${period}`, vars });
    reminders++;
    if (age >= escalate) {
      await notify(db, { template: "reminder.escalation", roles: ["SUPER_ADMIN"], excludeUserIds: w.exclude, link: w.link, dedupeKey: `escalate:${w.kind}:${w.id}:${Math.floor((age - escalate) / repeat)}`, vars });
      escalations++;
    }
  }
  return { reminders, escalations };
}
