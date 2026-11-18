/**
 * Fund pools: the money set aside for staff loans in a year, one pool for each school, set by the Head of
 * Account or the Payroll Manager. An application draws on the pool of the school its department belongs to.
 *
 *   Paid out   = the school's loans paid out in the year (advances against pay are not drawn from a pool)
 *   Available  = pool - paid out              (repayments do not go back into the pool)
 *   Committed  = the school's loans approved and awaiting payment + its applications with the approvers
 *   Free       = available - committed        (what the Bursary Officer can still clear)
 *
 * The Bursary Officer cannot clear an application its school's free balance cannot cover, and the Accounts
 * Payable Officer cannot pay out a loan its school's available balance cannot cover.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { departments, disbursements, fundPools, loanAccounts, loanApplications, schools, staffProfiles, users } from "@/db/schema";
import { D, dec, formatNaira, m } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";

export type FundPosition = Awaited<ReturnType<typeof fundPositions>>["schools"][number];

export const currentYear = () => Number(todayLagos().slice(0, 4));

const NO_SCHOOL = "The applicant's department is not in a school, so there is no fund pool to draw from. An administrator can put the department in a school under Organisation.";

/** Each active school's pool for the year (and any school that holds money in it), with the totals. */
export async function fundPositions(db: Executor, year = currentYear(), opts: { excludeApplicationId?: string; schoolId?: string } = {}) {
  const only = opts.schoolId ? [eq(loanApplications.schoolId, opts.schoolId)] : [];
  const pools = await db.select({ p: fundPools, setByName: users.displayName }).from(fundPools).leftJoin(users, eq(users.id, fundPools.setBy))
    .where(and(eq(fundPools.year, year), opts.schoolId ? eq(fundPools.schoolId, opts.schoolId) : sql`${fundPools.schoolId} is not null`));
  const paid = await db.select({ school: loanApplications.schoolId, total: sql<string>`coalesce(sum(${disbursements.amountDisbursed}), 0)`, n: sql<number>`count(*)` })
    .from(disbursements).innerJoin(loanAccounts, eq(loanAccounts.id, disbursements.loanAccountId)).innerJoin(loanApplications, eq(loanApplications.id, loanAccounts.applicationId))
    .where(and(eq(disbursements.status, "confirmed"), isNull(loanApplications.advanceType), sql`extract(year from ${disbursements.paymentDate}) = ${year}`, ...only))
    .groupBy(loanApplications.schoolId);
  const awaiting = await db.select({ school: loanApplications.schoolId, total: sql<string>`coalesce(sum(${loanAccounts.principal}), 0)`, n: sql<number>`count(*)` })
    .from(loanAccounts).innerJoin(loanApplications, eq(loanApplications.id, loanAccounts.applicationId))
    .where(and(eq(loanAccounts.status, "pending_disbursement"), isNull(loanApplications.advanceType), ...only))
    .groupBy(loanApplications.schoolId);
  const approving = await db.select({ school: loanApplications.schoolId, total: sql<string>`coalesce(sum(${loanApplications.requestedAmount}), 0)`, n: sql<number>`count(*)` })
    .from(loanApplications)
    .where(and(inArray(loanApplications.status, ["pending_approval"]), isNull(loanApplications.advanceType), ...only, ...(opts.excludeApplicationId ? [ne(loanApplications.id, opts.excludeApplicationId)] : [])))
    .groupBy(loanApplications.schoolId);
  const used = new Set([...paid, ...awaiting, ...approving].map((r) => r.school).filter(Boolean) as string[]);
  const list = (await db.select().from(schools).orderBy(asc(schools.name)))
    .filter((s) => (opts.schoolId ? s.id === opts.schoolId : s.isActive || used.has(s.id) || pools.some((p) => p.p.schoolId === s.id)));

  const of = (rows: { school: string | null; total: string; n: number }[], id: string) => rows.find((r) => r.school === id) ?? { total: "0", n: 0 };
  const positions = list.map((school) => {
    const pool = pools.find((p) => p.p.schoolId === school.id);
    const p = of(paid, school.id), a = of(awaiting, school.id), w = of(approving, school.id);
    const amount = dec(pool?.p.amount ?? 0);
    const paidOut = dec(p.total);
    const committed = dec(a.total).plus(w.total);
    const available = D.max(0, amount.minus(paidOut));
    return {
      year, schoolId: school.id, school: school.name, set: !!pool, amount: m(amount), note: pool?.p.note ?? null, setBy: pool?.setByName ?? null, updatedAt: pool?.p.updatedAt ?? null,
      paidOut: m(paidOut), paidOutCount: Number(p.n),
      awaitingPayout: m(a.total), awaitingCount: Number(a.n),
      withApprovers: m(w.total), withApproversCount: Number(w.n),
      committed: m(committed), available: m(available), free: m(D.max(0, available.minus(committed))),
      usedPercent: amount.greaterThan(0) ? Math.min(100, paidOut.div(amount).times(100).toNumber()) : 0,
    };
  });
  const sum = (k: "amount" | "paidOut" | "committed" | "available" | "free") => m(positions.reduce((t, x) => t.plus(x[k]), dec(0)));
  // Loans whose department had no school when they were cleared: shown so nothing goes unaccounted for.
  const unassigned = !opts.schoolId && [...paid, ...awaiting, ...approving].some((r) => !r.school && Number(r.n) > 0);
  return { year, schools: positions, total: { amount: sum("amount"), paidOut: sum("paidOut"), committed: sum("committed"), available: sum("available"), free: sum("free") }, unassigned };
}

/** The pools set, newest year first, with their school. */
export async function poolHistory(db: Executor, limit = 40) {
  return db.select({ id: fundPools.id, year: fundPools.year, school: schools.name, amount: fundPools.amount, updatedAt: fundPools.updatedAt, setBy: users.displayName })
    .from(fundPools).innerJoin(schools, eq(schools.id, fundPools.schoolId)).leftJoin(users, eq(users.id, fundPools.setBy))
    .orderBy(desc(fundPools.year), asc(schools.name)).limit(limit);
}

/** One school's pool for the year. */
export async function fundPosition(db: Executor, schoolId: string, year = currentYear(), opts: { excludeApplicationId?: string } = {}): Promise<FundPosition> {
  const [pos] = (await fundPositions(db, year, { ...opts, schoolId })).schools;
  if (!pos) throw new DomainError("That school was not found.");
  return pos;
}

/** The school of the applicant's department now, or null when the department is not in a school. */
export async function applicantSchool(db: Executor, applicantId: string): Promise<string | null> {
  const [r] = await db.select({ school: departments.schoolId }).from(staffProfiles)
    .innerJoin(departments, eq(departments.id, staffProfiles.departmentId)).where(eq(staffProfiles.userId, applicantId));
  return r?.school ?? null;
}

/**
 * The school whose pool an application draws on: its department's school now (Human Resources may have
 * corrected the department), kept on the application once set. With `save`, the application is updated.
 */
export async function schoolForApplication(db: Executor, app: { id: string; applicantId: string; schoolId: string | null }, opts: { save?: boolean } = {}) {
  const school = (await applicantSchool(db, app.applicantId)) ?? app.schoolId;
  if (opts.save && school && school !== app.schoolId) await db.update(loanApplications).set({ schoolId: school }).where(eq(loanApplications.id, app.id));
  return school;
}

/** The Head of Account or Payroll Manager sets (or changes) a school's pool for a year. It cannot go below what that school has already paid out. */
export async function setFundPool(db: Executor, actor: Actor, input: { year: number; schoolId: string; amount: string; note?: string }) {
  assertCan(actor, "fund.manage");
  const year = Math.trunc(input.year);
  if (!(year >= 2000 && year <= 2100)) throw new DomainError("Enter a valid year.");
  const [school] = input.schoolId ? await db.select().from(schools).where(eq(schools.id, input.schoolId)) : [];
  if (!school) throw new DomainError("Choose the school.");
  const amount = dec(input.amount || 0);
  if (amount.lessThan(0)) throw new DomainError("The pool cannot be negative.");
  return db.transaction(async (tx) => {
    const pos = await fundPosition(tx, school.id, year);
    if (amount.lessThan(pos.paidOut)) throw new DomainError(`${formatNaira(pos.paidOut)} has already been paid out for ${school.name} in ${year}, so its pool cannot be less than that.`);
    const values = { amount: m(amount), note: input.note?.trim() || null, setBy: actor.userId, updatedAt: new Date() };
    const [row] = await tx.insert(fundPools).values({ year, schoolId: school.id, ...values }).onConflictDoUpdate({ target: [fundPools.year, fundPools.schoolId], set: values }).returning();
    await audit(tx, actor, {
      action: "fund_pool.set", entityType: "fund_pool", entityId: row.id,
      summary: `Fund pool for ${school.name}, ${year}, set to ${formatNaira(amount)}${pos.set ? ` (was ${formatNaira(pos.amount)})` : ""}`,
      before: pos.set ? { amount: pos.amount } : null, after: { school: school.name, amount: m(amount), note: values.note },
    });
    return row;
  });
}

/** Whether a loan of `amount` can still be funded from its school's pool for the year. Advances are not drawn from a pool. */
export async function assertFundsFor(db: Executor, input: { amount: string; isAdvance: boolean; stage: "clear" | "payout"; schoolId: string | null; applicationId?: string; year?: number }) {
  if (input.isAdvance) return;
  if (!input.schoolId) throw new DomainError(NO_SCHOOL);
  const pos = await fundPosition(db, input.schoolId, input.year ?? currentYear(), { excludeApplicationId: input.applicationId });
  if (!pos.set) throw new DomainError(`The fund pool for ${pos.school} for ${pos.year} has not been set. Loans cannot be ${input.stage === "clear" ? "cleared" : "paid out"} until the Head of Account or Payroll Manager sets it.`);
  const room = input.stage === "clear" ? pos.free : pos.available;
  if (dec(input.amount).greaterThan(room)) {
    throw new DomainError(input.stage === "clear"
      ? `Only ${formatNaira(room)} of the ${pos.year} fund pool for ${pos.school} is left once loans already approved or awaiting payment are counted, so this loan of ${formatNaira(input.amount)} cannot be funded. Return or decline the application, or contact the Head of Account.`
      : `Only ${formatNaira(room)} of the ${pos.year} fund pool for ${pos.school} is left, so this loan of ${formatNaira(input.amount)} cannot be paid out. Contact the Head of Account.`);
  }
}
