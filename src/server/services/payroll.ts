import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanAccounts, staffProfiles, financialTransactions, users, scheduleInstalments, repaymentSchedules, repaymentClaims, earlyRepayments } from "@/db/schema";
import { dec, m, sum } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError, ForbiddenError, NotFoundError } from "../errors";
import type { PayrollDeduction, PayrollProvider } from "../integrations/payroll";
import { recordRepayment } from "./loans";

export interface PostingResult { posted: number; duplicates: number; errors: string[] }

/**
 * Post payroll deductions as repayments: the single path used by both the CSV import and the
 * payroll API sync. Each row is idempotent on its payroll reference, so re-running a month is safe.
 */
export async function postPayrollDeductions(db: Executor, actor: Actor, rows: PayrollDeduction[], source: string): Promise<PostingResult> {
  assertCan(actor, "repayment.confirm");
  const result: PostingResult = { posted: 0, duplicates: 0, errors: [] };
  for (const row of rows) {
    try {
      const [p] = await db.select({ userId: staffProfiles.userId }).from(staffProfiles).where(eq(staffProfiles.staffNumber, row.staffNumber));
      if (!p) throw new DomainError(`unknown staff number ${row.staffNumber}`);
      const live = await db.select({ id: loanAccounts.id }).from(loanAccounts).where(and(eq(loanAccounts.borrowerId, p.userId), inArray(loanAccounts.status, ["active", "overdue", "defaulted"])));
      if (live.length !== 1) throw new DomainError(`${row.staffNumber} has ${live.length} live loans; post manually`);
      const key = `payroll:${row.reference}`;
      const [seen] = await db.select({ id: financialTransactions.id }).from(financialTransactions).where(eq(financialTransactions.idempotencyKey, key));
      if (seen) { result.duplicates++; continue; }
      await recordRepayment(db, actor, live[0].id, { amount: row.amount, valueDate: row.valueDate, reference: row.reference, channel: "payroll", idempotencyKey: key });
      result.posted++;
    } catch (err) {
      const msg = (err as Error).message;
      if (/already been recorded/.test(msg)) result.duplicates++;
      else result.errors.push(`${row.staffNumber} (${row.reference}): ${msg}`);
    }
  }
  await audit(db, actor, { action: "payroll.deductions_posted", entityType: "system", summary: `${source}: ${result.posted} posted, ${result.duplicates} duplicate(s), ${result.errors.length} error(s)`, after: { errors: result.errors.slice(0, 50) } });
  return result;
}

export async function syncPayrollMonth(db: Executor, actor: Actor, provider: PayrollProvider, month: string) {
  const rows = await provider.fetchDeductions(month);
  return postPayrollDeductions(db, actor, rows, `${provider.name} sync ${month}`);
}

/** Pull a staff member's salary from payroll into their HR record (source = payroll). */
export async function importSalaryFromPayroll(db: Executor, actor: Actor, provider: PayrollProvider, userId: string) {
  if (!actor.permissions.has("hr.staff.edit") && !actor.permissions.has("hr.verify")) throw new ForbiddenError();
  if (userId === actor.userId) throw new ForbiddenError("You cannot update your own salary record.");
  const [p] = await db.select().from(staffProfiles).where(eq(staffProfiles.userId, userId));
  if (!p?.staffNumber) throw new DomainError("Record the staff number before fetching salary from payroll.");
  const s = await provider.fetchSalary(p.staffNumber);
  if (!s) throw new NotFoundError(`Payroll record for ${p.staffNumber}`);
  const patch = { monthlyBasic: s.monthlyBasic, monthlyGross: s.monthlyGross, monthlyNet: s.monthlyNet, salarySource: "payroll" as const, salaryVerifiedBy: actor.userId, salaryVerifiedAt: new Date(), updatedAt: new Date() };
  await db.update(staffProfiles).set(patch).where(eq(staffProfiles.userId, userId));
  await audit(db, actor, { action: "staff.salary_from_payroll", entityType: "staff_profile", entityId: userId, before: { basic: p.monthlyBasic, gross: p.monthlyGross, net: p.monthlyNet, source: p.salarySource }, after: { ...patch, asOf: s.asOf } });
  return s;
}

/**
 * What the Payroll Manager and Payroll Officer follow each month: instalments due for deduction, which
 * loans deduct automatically, which still need their first deduction confirmed, and early repayments.
 */
export async function payrollOverview(db: Executor, actor: Actor, month = todayLagos().slice(0, 7)) {
  assertCan(actor, "payroll.view");
  const live = await db.select({ loan: loanAccounts, borrower: users.displayName, staffNumber: staffProfiles.staffNumber })
    .from(loanAccounts).innerJoin(users, eq(users.id, loanAccounts.borrowerId)).leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .where(inArray(loanAccounts.status, ["active", "overdue", "defaulted"]));
  const due = await db.select({ i: scheduleInstalments, accountNumber: loanAccounts.accountNumber, loanId: loanAccounts.id, borrower: users.displayName, automatic: loanAccounts.deductionsConfirmedAt })
    .from(scheduleInstalments).innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
    .innerJoin(loanAccounts, eq(loanAccounts.id, scheduleInstalments.loanAccountId)).innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .where(and(eq(repaymentSchedules.isCurrent, true), sql`to_char(${scheduleInstalments.dueDate}, 'YYYY-MM') = ${month}`, inArray(loanAccounts.status, ["active", "overdue", "defaulted", "closed"])))
    .orderBy(scheduleInstalments.dueDate);
  const [received] = await db.select({ total: sql<string>`coalesce(sum(${financialTransactions.amount}), 0)`, n: sql<number>`count(*)` }).from(financialTransactions)
    .where(and(eq(financialTransactions.type, "repayment"), eq(financialTransactions.status, "posted"), sql`to_char(${financialTransactions.valueDate}, 'YYYY-MM') = ${month}`));
  const [claims] = await db.select({ n: sql<number>`count(*)` }).from(repaymentClaims).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId)));
  const [early] = await db.select({ n: sql<number>`count(*)`, total: sql<string>`coalesce(sum(${earlyRepayments.amount}), 0)` }).from(earlyRepayments).where(eq(earlyRepayments.status, "pending"));
  return {
    month,
    automatic: live.filter((l) => l.loan.deductionsConfirmedAt),
    awaitingFirst: live.filter((l) => !l.loan.deductionsConfirmedAt),
    due: due.map((d) => ({ ...d, remaining: m(dec(d.i.totalDue).minus(d.i.principalPaid).minus(d.i.interestPaid)) })),
    dueTotal: m(sum(due.map((d) => d.i.totalDue))),
    received: { total: m(received.total), count: Number(received.n) },
    claimsToConfirm: Number(claims.n),
    earlyPending: { count: Number(early.n), total: m(early.total) },
  };
}
