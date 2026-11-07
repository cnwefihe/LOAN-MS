import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanAccounts, loanApplications, staffProfiles, users } from "@/db/schema";
import type { StaffEligibility } from "@/lib/finance/staff-eligibility";
import { assertCan, type Actor } from "../actor";

/**
 * Register of advances against salary, leave allowance and 13th month pay, for the officers who make those
 * payments: who received what, against which payment, and how much is still payable to them once the
 * advance is deducted.
 */
export async function advancesRegister(db: Executor, actor: Actor) {
  assertCan(actor, "accounts.view");
  const rows = await db.select({ loan: loanAccounts, app: loanApplications, name: users.displayName, staffNumber: staffProfiles.staffNumber })
    .from(loanAccounts)
    .innerJoin(loanApplications, eq(loanApplications.id, loanAccounts.applicationId))
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .where(and(isNotNull(loanApplications.advanceType)))
    .orderBy(desc(loanAccounts.createdAt));
  return rows.map((r) => {
    const a = (r.app.quote as unknown as StaffEligibility).advance;
    const recovered = r.loan.status === "closed";
    return {
      loanId: r.loan.id, accountNumber: r.loan.accountNumber, name: r.name, staffNumber: r.staffNumber, type: r.app.advanceType!,
      amount: r.loan.principal, paymentNet: a?.payment ?? null, stillPayable: a?.remaining ?? null,
      deductOn: r.loan.firstDueDate, status: r.loan.status, recovered,
      stage: r.loan.status === "pending_disbursement" ? "To be paid out" : recovered ? "Recovered" : "To be deducted",
    };
  });
}

/** Advances paid out and not yet deducted, for the menu badge. */
export async function advancesToRecover(db: Executor) {
  const rows = await db.select({ id: loanAccounts.id }).from(loanAccounts).innerJoin(loanApplications, eq(loanApplications.id, loanAccounts.applicationId))
    .where(and(isNotNull(loanApplications.advanceType), eq(loanAccounts.status, "active")));
  return rows.length;
}
