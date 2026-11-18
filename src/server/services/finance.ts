/**
 * The Head of Account's view: the fund pool, lending and repayments this year, and the work waiting at
 * each stage with the people responsible, so they can follow up with them.
 */
import { and, eq, inArray, isNull, min, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { earlyRepayments, financialTransactions, loanAccounts, loanApplications, repaymentClaims, roles, userRoles, users } from "@/db/schema";
import type { RoleCode } from "@/lib/auth/permissions";
import { m } from "@/lib/finance/money";
import { assertCan, type Actor } from "../actor";
import { getWording } from "../wording";
import { currentYear, fundPositions, poolHistory } from "./funds";

export async function financeOverview(db: Executor, actor: Actor) {
  assertCan(actor, "finance.overview");
  const year = currentYear();
  const pools = await fundPositions(db, year);
  const history = await poolHistory(db);
  const inYear = (col: unknown) => sql`extract(year from ${col}) = ${year}`;
  const [repaid] = await db.select({ total: sql<string>`coalesce(sum(${financialTransactions.amount}), 0)`, n: sql<number>`count(*)` }).from(financialTransactions)
    .where(and(inArray(financialTransactions.type, ["repayment", "early_settlement"]), eq(financialTransactions.status, "posted"), inYear(financialTransactions.valueDate)));
  const [book] = await db.select({
    live: sql<number>`count(*) filter (where ${loanAccounts.status} in ('active','overdue','defaulted'))`,
    outstanding: sql<string>`coalesce(sum(${loanAccounts.principalOutstanding} + ${loanAccounts.interestOutstanding}) filter (where ${loanAccounts.status} in ('active','overdue','defaulted')), 0)`,
    overdue: sql<number>`count(*) filter (where ${loanAccounts.status} = 'overdue')`,
    defaulted: sql<number>`count(*) filter (where ${loanAccounts.status} = 'defaulted')`,
    automatic: sql<number>`count(*) filter (where ${loanAccounts.status} in ('active','overdue','defaulted') and ${loanAccounts.deductionsConfirmedAt} is not null)`,
    closedThisYear: sql<number>`count(*) filter (where ${loanAccounts.status} = 'closed' and extract(year from ${loanAccounts.closedAt}) = ${year})`,
  }).from(loanAccounts);

  const w = await getWording(db);
  const holders = await db.select({ code: roles.code, name: users.displayName, email: users.email }).from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId)).innerJoin(users, eq(users.id, userRoles.userId)).where(eq(users.isActive, true));
  const people = (codes: RoleCode[]) => holders.filter((h) => (codes as string[]).includes(h.code)).map((h) => ({ name: h.name, email: h.email }));
  const apps = async (status: (typeof loanApplications.status.enumValues)[number]) => {
    const [r] = await db.select({ n: sql<number>`count(*)`, oldest: min(loanApplications.updatedAt), total: sql<string>`coalesce(sum(${loanApplications.requestedAmount}), 0)` }).from(loanApplications).where(eq(loanApplications.status, status));
    return { count: Number(r.n), oldest: r.oldest, amount: m(r.total) };
  };
  const [payout] = await db.select({ n: sql<number>`count(*)`, oldest: min(loanAccounts.approvedAt), total: sql<string>`coalesce(sum(${loanAccounts.principal}), 0)` }).from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement"));
  const [claims] = await db.select({ n: sql<number>`count(*)`, oldest: min(repaymentClaims.createdAt), total: sql<string>`coalesce(sum(${repaymentClaims.amount}), 0)` }).from(repaymentClaims).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId)));
  const [early] = await db.select({ n: sql<number>`count(*)`, oldest: min(earlyRepayments.createdAt), total: sql<string>`coalesce(sum(${earlyRepayments.amount}), 0)` }).from(earlyRepayments).where(eq(earlyRepayments.status, "pending"));
  const [checker] = await db.select({ n: sql<number>`count(*)`, oldest: min(financialTransactions.createdAt), total: sql<string>`coalesce(sum(${financialTransactions.amount}), 0)` }).from(financialTransactions).where(eq(financialTransactions.status, "pending_approval"));
  const row = (r: { n: number; oldest: Date | null; total: string }) => ({ count: Number(r.n), oldest: r.oldest, amount: m(r.total) });

  const stages = [
    { stage: "Human Resources verification", ...(await apps("pending_hr")), people: people(["HR_ADMIN"]), roles: w.role.HR_ADMIN.name },
    { stage: "Bursary review (loan history, deductions, funds)", ...(await apps("pending_bursary")), people: people(["BURSARY_OFFICER"]), roles: w.role.BURSARY_OFFICER.name },
    { stage: "Approval (Line Manager, HR Director, Bursar)", ...(await apps("pending_approval")), people: people(["HR_DIRECTOR", "ACCOUNTS_ADMIN"]), roles: `${w.role.HR_DIRECTOR.name}, ${w.role.ACCOUNTS_ADMIN.name} and Line Managers` },
    { stage: "Payment of approved loans", ...row(payout), people: people(["ACCOUNTS_OFFICER"]), roles: w.role.ACCOUNTS_OFFICER.name },
    { stage: "First salary deduction to confirm", ...row(claims), people: people(["PAYROLL_OFFICER"]), roles: w.role.PAYROLL_OFFICER.name },
    { stage: "Early repayments to confirm", ...row(early), people: people(["PAYROLL_OFFICER"]), roles: w.role.PAYROLL_OFFICER.name },
    { stage: "Transactions awaiting authorisation", ...row(checker), people: people(["ACCOUNTS_ADMIN"]), roles: w.role.ACCOUNTS_ADMIN.name },
  ];
  return {
    year, pools, history,
    repaid: { total: m(repaid.total), count: Number(repaid.n) },
    book: { live: Number(book.live), outstanding: m(book.outstanding), overdue: Number(book.overdue), defaulted: Number(book.defaulted), automatic: Number(book.automatic), closedThisYear: Number(book.closedThisYear) },
    stages,
  };
}
