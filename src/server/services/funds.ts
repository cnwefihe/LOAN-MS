/**
 * The fund pool: the money set aside for staff loans in a year, set by the Head of Account.
 *
 *   Paid out   = loans paid out in the year (advances against pay are not drawn from the pool)
 *   Available  = pool - paid out              (repayments do not go back into the pool)
 *   Committed  = loans approved and awaiting payment + applications with the approvers
 *   Free       = available - committed        (what the Bursary Officer can still clear)
 *
 * The Bursary Officer cannot clear an application the free balance cannot cover, and the Accounts
 * Payable Officer cannot pay out a loan the available balance cannot cover.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { disbursements, fundPools, loanAccounts, loanApplications, users } from "@/db/schema";
import { D, dec, formatNaira, m } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";

export type FundPosition = Awaited<ReturnType<typeof fundPosition>>;

export const currentYear = () => Number(todayLagos().slice(0, 4));

export async function fundPosition(db: Executor, year = currentYear(), opts: { excludeApplicationId?: string } = {}) {
  const [pool] = await db.select({ p: fundPools, setByName: users.displayName }).from(fundPools).leftJoin(users, eq(users.id, fundPools.setBy)).where(eq(fundPools.year, year));
  const [paid] = await db.select({ total: sql<string>`coalesce(sum(${disbursements.amountDisbursed}), 0)`, n: sql<number>`count(*)` })
    .from(disbursements).innerJoin(loanAccounts, eq(loanAccounts.id, disbursements.loanAccountId)).innerJoin(loanApplications, eq(loanApplications.id, loanAccounts.applicationId))
    .where(and(eq(disbursements.status, "confirmed"), isNull(loanApplications.advanceType), sql`extract(year from ${disbursements.paymentDate}) = ${year}`));
  const [awaiting] = await db.select({ total: sql<string>`coalesce(sum(${loanAccounts.principal}), 0)`, n: sql<number>`count(*)` })
    .from(loanAccounts).innerJoin(loanApplications, eq(loanApplications.id, loanAccounts.applicationId))
    .where(and(eq(loanAccounts.status, "pending_disbursement"), isNull(loanApplications.advanceType)));
  const [approving] = await db.select({ total: sql<string>`coalesce(sum(${loanApplications.requestedAmount}), 0)`, n: sql<number>`count(*)` })
    .from(loanApplications)
    .where(and(inArray(loanApplications.status, ["pending_approval"]), isNull(loanApplications.advanceType), ...(opts.excludeApplicationId ? [ne(loanApplications.id, opts.excludeApplicationId)] : [])));
  const amount = dec(pool?.p.amount ?? 0);
  const paidOut = dec(paid.total);
  const committed = dec(awaiting.total).plus(approving.total);
  const available = D.max(0, amount.minus(paidOut));
  const free = D.max(0, available.minus(committed));
  return {
    year, set: !!pool, amount: m(amount), note: pool?.p.note ?? null, setBy: pool?.setByName ?? null, updatedAt: pool?.p.updatedAt ?? null,
    paidOut: m(paidOut), paidOutCount: Number(paid.n),
    awaitingPayout: m(awaiting.total), awaitingCount: Number(awaiting.n),
    withApprovers: m(approving.total), withApproversCount: Number(approving.n),
    committed: m(committed), available: m(available), free: m(free),
    usedPercent: amount.greaterThan(0) ? Math.min(100, paidOut.div(amount).times(100).toNumber()) : 0,
  };
}

/** The Head of Account sets (or changes) the pool for a year. It cannot go below what has already been paid out. */
export async function setFundPool(db: Executor, actor: Actor, input: { year: number; amount: string; note?: string }) {
  assertCan(actor, "fund.manage");
  const year = Math.trunc(input.year);
  if (!(year >= 2000 && year <= 2100)) throw new DomainError("Enter a valid year.");
  const amount = dec(input.amount || 0);
  if (amount.lessThan(0)) throw new DomainError("The pool cannot be negative.");
  return db.transaction(async (tx) => {
    const pos = await fundPosition(tx, year);
    if (amount.lessThan(pos.paidOut)) throw new DomainError(`${formatNaira(pos.paidOut)} has already been paid out in ${year}, so the pool cannot be less than that.`);
    const values = { amount: m(amount), note: input.note?.trim() || null, setBy: actor.userId, updatedAt: new Date() };
    const [row] = await tx.insert(fundPools).values({ year, ...values }).onConflictDoUpdate({ target: fundPools.year, set: values }).returning();
    await audit(tx, actor, {
      action: "fund_pool.set", entityType: "fund_pool", entityId: row.id,
      summary: `Fund pool for ${year} set to ${formatNaira(amount)}${pos.set ? ` (was ${formatNaira(pos.amount)})` : ""}`,
      before: pos.set ? { amount: pos.amount } : null, after: { amount: m(amount), note: values.note },
    });
    return row;
  });
}

/** Whether a loan of `amount` can still be funded from this year's pool. Advances are not drawn from it. */
export async function assertFundsFor(db: Executor, input: { amount: string; isAdvance: boolean; stage: "clear" | "payout"; applicationId?: string; year?: number }) {
  if (input.isAdvance) return;
  const pos = await fundPosition(db, input.year ?? currentYear(), { excludeApplicationId: input.applicationId });
  if (!pos.set) throw new DomainError(`The Head of Account has not set the fund pool for ${pos.year}. Loans cannot be ${input.stage === "clear" ? "cleared" : "paid out"} until it is set.`);
  const room = input.stage === "clear" ? pos.free : pos.available;
  if (dec(input.amount).greaterThan(room)) {
    throw new DomainError(input.stage === "clear"
      ? `Only ${formatNaira(room)} of the ${pos.year} fund pool is left once loans already approved or awaiting payment are counted, so this loan of ${formatNaira(input.amount)} cannot be funded. Return or decline the application, or contact the Head of Account.`
      : `Only ${formatNaira(room)} of the ${pos.year} fund pool is left, so this loan of ${formatNaira(input.amount)} cannot be paid out. Contact the Head of Account.`);
  }
}
