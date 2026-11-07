import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanAccounts, staffProfiles, financialTransactions } from "@/db/schema";
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
