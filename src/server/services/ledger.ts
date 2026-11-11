/**
 * Loan sub-ledger. Every movement of money (or of a contractual balance) is a financial
 * transaction with balanced double-entry ledger lines. Official balances are derived only from
 * POSTED ledger entries; pending (maker) transactions never change balances.
 *
 * Accounts (per loan):
 *   loan_principal        asset   : principal receivable from the borrower
 *   interest_receivable   asset   : contractual interest receivable
 *   unearned_interest     contra  : offset for interest recognised at disbursement / restructure
 *   cash_bank             asset   : university bank (disbursements out, repayments in)
 *   fee_income            income  : unused; the University charges interest only
 *   overpayment_liability liability : amounts received above the balance, refundable to the borrower
 *   adjustments           expense : waivers and write-downs
 */
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import {
  financialTransactions, ledgerEntries, loanAccounts, repaymentSchedules, scheduleInstalments, repaymentClaims, applicationGuarantors, users,
} from "@/db/schema";
import { allocatePayments } from "@/lib/finance/calculator";
import { D, dec, m, sum, ZERO, type Dec, formatNaira } from "@/lib/finance/money";
import { daysBetween, todayLagos, addDays, addMonths, firstOfMonth } from "@/lib/finance/dates";
import { type Actor, assertCan } from "../actor";
import { audit } from "../audit";
import { notify } from "../notifications";
import { getSetting } from "../settings";
import { DomainError, ForbiddenError, NotFoundError } from "../errors";
import { getPolicyVersion } from "./policies";

export type LedgerAccount = (typeof ledgerEntries.$inferSelect)["account"];
export type TxnType = (typeof financialTransactions.$inferSelect)["type"];
export type Txn = typeof financialTransactions.$inferSelect;
export interface Line { account: LedgerAccount; direction: "debit" | "credit"; amount: string }

/** Transaction types that never count as "paid toward the schedule". */
const NON_PAYMENT_TYPES: TxnType[] = ["disbursement", "interest_recognition"];
const REVERSIBLE: TxnType[] = ["repayment", "early_settlement", "adjustment", "refund", "write_off"];

export function assertBalanced(lines: Line[]) {
  if (!lines.length) throw new DomainError("A transaction needs ledger lines.");
  for (const l of lines) if (dec(l.amount).lessThanOrEqualTo(0)) throw new DomainError("Ledger line amounts must be positive.");
  const dr = sum(lines.filter((l) => l.direction === "debit").map((l) => l.amount));
  const cr = sum(lines.filter((l) => l.direction === "credit").map((l) => l.amount));
  if (!dr.equals(cr)) throw new DomainError(`Unbalanced transaction: debits ${m(dr)} ≠ credits ${m(cr)}.`);
}

function cleanLines(lines: Line[]): Line[] {
  return lines.filter((l) => dec(l.amount).greaterThan(0)).map((l) => ({ ...l, amount: m(l.amount) }));
}

export interface PostInput {
  loanAccountId: string;
  type: TxnType;
  amount: string;
  valueDate: string;
  narration: string;
  externalReference?: string | null;
  idempotencyKey: string;
  lines: Line[];
  /** true → recorded as pending_approval for a checker; false → posted immediately. */
  requireApproval: boolean;
  reversesTransactionId?: string | null;
  makerId?: string;
  checkerId?: string | null;
}

export async function createTransaction(db: Executor, actor: Actor, input: PostInput): Promise<{ txn: Txn; duplicate: boolean }> {
  const [existing] = await db.select().from(financialTransactions).where(eq(financialTransactions.idempotencyKey, input.idempotencyKey));
  if (existing) return { txn: existing, duplicate: true };
  if (input.externalReference) {
    const [dup] = await db.select({ ref: financialTransactions.reference }).from(financialTransactions).where(and(
      eq(financialTransactions.type, input.type), eq(financialTransactions.externalReference, input.externalReference), sql`${financialTransactions.status} <> 'rejected'`));
    if (dup) throw new DomainError(`A ${input.type.replace("_", " ")} with reference "${input.externalReference}" has already been recorded (${dup.ref}). Duplicate postings are blocked.`);
  }
  const lines = cleanLines(input.lines);
  assertBalanced(lines);
  // One reference per loan cycle: every transaction carries the loan's (application's) reference.
  const [owner] = await db.select({ ref: loanAccounts.accountNumber }).from(loanAccounts).where(eq(loanAccounts.id, input.loanAccountId));
  const reference = owner.ref;
  const posted = !input.requireApproval;
  const [txn] = await db.insert(financialTransactions).values({
    reference, loanAccountId: input.loanAccountId, type: input.type, status: posted ? "posted" : "pending_approval",
    amount: m(input.amount), valueDate: input.valueDate, narration: input.narration, externalReference: input.externalReference ?? null,
    idempotencyKey: input.idempotencyKey, reversesTransactionId: input.reversesTransactionId ?? null,
    proposedEntries: posted ? null : lines, makerId: input.makerId ?? actor.userId, checkerId: posted ? (input.checkerId ?? null) : null,
    checkedAt: posted && input.checkerId ? new Date() : null, postedAt: posted ? new Date() : null,
  }).returning();
  if (posted) await insertEntries(db, txn, lines);
  await audit(db, actor, {
    action: posted ? "transaction.posted" : "transaction.proposed", entityType: "financial_transaction", entityId: txn.id,
    summary: `${reference} ${input.type} ${m(input.amount)}: ${input.narration}`, after: { lines, status: txn.status },
  });
  return { txn, duplicate: false };
}

async function insertEntries(db: Executor, txn: Txn, lines: Line[]) {
  await db.insert(ledgerEntries).values(lines.map((l) => ({ transactionId: txn.id, loanAccountId: txn.loanAccountId, account: l.account, direction: l.direction, amount: l.amount })));
}

/** Checker approval of a pending transaction. Repayment splits are recomputed against the latest state. */
export async function approveTransactionTx(db: Executor, actor: Actor, txnId: string, recomputeLines?: (txn: Txn) => Promise<Line[]>): Promise<Txn> {
  const [txn] = await db.select().from(financialTransactions).where(eq(financialTransactions.id, txnId)).for("update");
  if (!txn) throw new NotFoundError("Transaction");
  if (txn.status !== "pending_approval") throw new DomainError(`Transaction ${txn.reference} is already ${txn.status.replace("_", " ")}.`);
  if (txn.makerId === actor.userId) throw new ForbiddenError("Maker-checker control: you cannot approve a transaction you proposed.");
  const lines = cleanLines(recomputeLines ? await recomputeLines(txn) : (txn.proposedEntries as Line[]));
  assertBalanced(lines);
  const [updated] = await db.update(financialTransactions).set({ status: "posted", checkerId: actor.userId, checkedAt: new Date(), postedAt: new Date() })
    .where(eq(financialTransactions.id, txn.id)).returning();
  await insertEntries(db, updated, lines);
  await audit(db, actor, { action: "transaction.approved", entityType: "financial_transaction", entityId: txn.id, summary: `${txn.reference} approved and posted`, after: { lines } });
  return updated;
}

export async function rejectTransactionTx(db: Executor, actor: Actor, txnId: string, reason: string): Promise<Txn> {
  if (reason.trim().length < 3) throw new DomainError("Give a reason for rejecting the transaction.");
  const [txn] = await db.select().from(financialTransactions).where(eq(financialTransactions.id, txnId)).for("update");
  if (!txn) throw new NotFoundError("Transaction");
  if (txn.status !== "pending_approval") throw new DomainError("Only pending transactions can be rejected.");
  if (txn.makerId === actor.userId) throw new ForbiddenError("Maker-checker control: ask a different user to reject this transaction, or leave it for review.");
  const [updated] = await db.update(financialTransactions).set({ status: "rejected", checkerId: actor.userId, checkedAt: new Date(), rejectionReason: reason.trim() })
    .where(eq(financialTransactions.id, txn.id)).returning();
  await audit(db, actor, { action: "transaction.rejected", entityType: "financial_transaction", entityId: txn.id, summary: `${txn.reference}: ${reason}` });
  return updated;
}

/* ───────────────────────── Balances & schedule state ───────────────────────── */

export async function accountBalances(db: Executor, loanAccountId: string) {
  const rows = await db.select({
    account: ledgerEntries.account,
    net: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'debit' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end), 0)`,
  }).from(ledgerEntries).where(eq(ledgerEntries.loanAccountId, loanAccountId)).groupBy(ledgerEntries.account);
  const b = Object.fromEntries(rows.map((r) => [r.account, dec(r.net)])) as Partial<Record<LedgerAccount, Dec>>;
  return {
    principal: b.loan_principal ?? ZERO,
    interest: b.interest_receivable ?? ZERO,
    overpayment: (b.overpayment_liability ?? ZERO).negated(),
    unearned: (b.unearned_interest ?? ZERO).negated(),
    cash: b.cash_bank ?? ZERO,
  };
}

export async function currentSchedule(db: Executor, loanAccountId: string) {
  const [s] = await db.select().from(repaymentSchedules).where(and(eq(repaymentSchedules.loanAccountId, loanAccountId), eq(repaymentSchedules.isCurrent, true)));
  if (!s) return null;
  const instalments = await db.select().from(scheduleInstalments).where(eq(scheduleInstalments.scheduleId, s.id)).orderBy(asc(scheduleInstalments.sequence));
  return { schedule: s, instalments };
}

export async function maxLedgerId(db: Executor, loanAccountId: string): Promise<number> {
  const [r] = await db.select({ id: max(ledgerEntries.id) }).from(ledgerEntries).where(eq(ledgerEntries.loanAccountId, loanAccountId));
  return Number(r?.id ?? 0);
}

/**
 * Recompute everything derived from the ledger for one loan: cached balances, instalment
 * allocations, days past due and status. Runs inside the posting transaction.
 */
export async function recomputeLoan(db: Executor, actor: Actor | null, loanAccountId: string, asOf = todayLagos()) {
  const [loan] = await db.select().from(loanAccounts).where(eq(loanAccounts.id, loanAccountId)).for("update");
  if (!loan) throw new NotFoundError("Loan account");
  const bal = await accountBalances(db, loanAccountId);
  const policy = (await getPolicyVersion(db, loan.policyVersionId)).params;

  // Total repaid = net cash received from repayment-type transactions (incl. their reversals).
  const cashRows = await db.select({ type: financialTransactions.type, reverses: financialTransactions.reversesTransactionId, direction: ledgerEntries.direction, amount: ledgerEntries.amount, id: financialTransactions.id })
    .from(ledgerEntries).innerJoin(financialTransactions, eq(financialTransactions.id, ledgerEntries.transactionId))
    .where(and(eq(ledgerEntries.loanAccountId, loanAccountId), eq(ledgerEntries.account, "cash_bank")));
  const typeById = new Map<string, TxnType>();
  const allTxns = await db.select({ id: financialTransactions.id, type: financialTransactions.type }).from(financialTransactions).where(eq(financialTransactions.loanAccountId, loanAccountId));
  allTxns.forEach((t) => typeById.set(t.id, t.type));
  let totalRepaid = ZERO;
  for (const r of cashRows) {
    const effective = r.type === "reversal" && r.reverses ? typeById.get(r.reverses) : r.type;
    if (effective === "repayment" || effective === "early_settlement") {
      totalRepaid = r.direction === "debit" ? totalRepaid.plus(r.amount) : totalRepaid.minus(r.amount);
    }
  }

  let dpd = 0;
  const cur = await currentSchedule(db, loanAccountId);
  if (cur) {
    const [paidRow] = await db.select({
      paid: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' then ${ledgerEntries.amount} else -${ledgerEntries.amount} end), 0)`,
    }).from(ledgerEntries).innerJoin(financialTransactions, eq(financialTransactions.id, ledgerEntries.transactionId)).where(and(
      eq(ledgerEntries.loanAccountId, loanAccountId),
      sql`${ledgerEntries.id} > ${cur.schedule.ledgerWatermark}`,
      inArray(ledgerEntries.account, ["loan_principal", "interest_receivable"]),
      sql`${financialTransactions.type} not in ('disbursement', 'interest_recognition', 'write_off')`,
      // A reversal of a write-off must not count as a negative payment either.
      sql`not (${financialTransactions.type} = 'reversal' and exists (select 1 from financial_transactions o where o.id = ${financialTransactions.reversesTransactionId} and o.type = 'write_off'))`,
    ));
    const paidTowardSchedule = D.max(0, dec(paidRow?.paid ?? 0));
    const { allocations } = allocatePayments(cur.instalments.map((i) => ({ id: i.id, sequence: i.sequence, dueDate: i.dueDate, principalDue: i.principalDue, interestDue: i.interestDue })), [paidTowardSchedule]);
    let oldestUnpaid: string | null = null;
    for (const inst of cur.instalments) {
      const a = allocations.find((x) => x.instalmentId === inst.id)!;
      const paid = dec(a.principalPaid).plus(a.interestPaid);
      const full = paid.greaterThanOrEqualTo(inst.totalDue);
      const pastDue = daysBetween(inst.dueDate, asOf);
      let status: (typeof scheduleInstalments.$inferSelect)["status"] = full ? "paid" : paid.greaterThan(0) ? "partial" : "pending";
      if (!full && pastDue > policy.overdueAfterDays) status = "overdue";
      if (!full && pastDue > 0 && !oldestUnpaid) oldestUnpaid = inst.dueDate;
      if (inst.principalPaid !== a.principalPaid || inst.interestPaid !== a.interestPaid || inst.status !== status) {
        await db.update(scheduleInstalments).set({ principalPaid: a.principalPaid, interestPaid: a.interestPaid, status, paidAt: full ? (inst.paidAt ?? new Date()) : null }).where(eq(scheduleInstalments.id, inst.id));
      }
    }
    dpd = oldestUnpaid ? Math.max(0, daysBetween(oldestUnpaid, asOf)) : 0;
  }

  const outstanding = bal.principal.plus(bal.interest);
  // A posted, un-reversed write-off makes a zero balance "written off" rather than "closed".
  const [wo] = await db.select({ id: financialTransactions.id }).from(financialTransactions).where(and(
    eq(financialTransactions.loanAccountId, loanAccountId), eq(financialTransactions.type, "write_off"), eq(financialTransactions.status, "posted"),
    sql`not exists (select 1 from financial_transactions r where r.reverses_transaction_id = ${financialTransactions.id} and r.status = 'posted')`));
  let status = loan.status;
  if (["active", "overdue", "defaulted", "closed", "written_off"].includes(loan.status) && loan.disbursedAt) {
    if (outstanding.lessThanOrEqualTo(0)) status = wo ? "written_off" : "closed";
    else if (dpd > policy.defaultAfterDays) status = "defaulted";
    else if (dpd > policy.overdueAfterDays) status = "overdue";
    else status = "active";
  }

  await db.update(loanAccounts).set({
    principalOutstanding: m(bal.principal), interestOutstanding: m(bal.interest), overpaymentBalance: m(bal.overpayment),
    totalRepaid: m(totalRepaid), daysPastDue: dpd, status, updatedAt: new Date(), rowVersion: loan.rowVersion + 1,
    closedAt: status === "closed" ? (loan.closedAt ?? new Date()) : null,
  }).where(eq(loanAccounts.id, loanAccountId));

  if (status !== loan.status) {
    await audit(db, actor, { action: "loan.status_changed", entityType: "loan_account", entityId: loanAccountId, summary: `${loan.accountNumber}: ${loan.status} → ${status}`, before: { status: loan.status }, after: { status, dpd } });
    const guarantorIds = await loanGuarantorIds(db, loan.applicationId);
    const [borrower] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, loan.borrowerId));
    const vars = { accountNumber: loan.accountNumber, applicantName: borrower?.name, days: dpd, amount: formatNaira(m(outstanding)) };
    if (status === "closed") await notify(db, { template: "loan.closed", userIds: [loan.borrowerId, ...guarantorIds], link: `/loans/${loan.id}`, vars, dedupeKey: `closed:${loan.id}:${asOf}` });
    if (status === "overdue" && loan.status === "active") await notify(db, { template: "loan.overdue", userIds: [loan.borrowerId], link: `/loans/${loan.id}`, vars, dedupeKey: `overdue:${loan.id}:${asOf}` });
    if (status === "written_off") await notify(db, { template: "loan.written_off", userIds: [loan.borrowerId], roles: ["ACCOUNTS_ADMIN"], link: `/loans/${loan.id}`, vars, dedupeKey: `writeoff:${loan.id}:${asOf}` });
    if (status === "defaulted") await notify(db, { template: "loan.defaulted", userIds: [loan.borrowerId, ...guarantorIds], roles: ["ACCOUNTS_ADMIN"], link: `/loans/${loan.id}`, vars, dedupeKey: `default:${loan.id}:${asOf}` });
  }
  return { previous: loan.status, status, outstanding: m(outstanding), dpd };
}

export async function loanGuarantorIds(db: Executor, applicationId: string): Promise<string[]> {
  const rows = await db.select({ id: applicationGuarantors.guarantorId }).from(applicationGuarantors).where(and(eq(applicationGuarantors.applicationId, applicationId), eq(applicationGuarantors.status, "accepted")));
  return rows.map((r) => r.id);
}

/* ───────────────────────── Repayment line builders ───────────────────────── */

/** Last day of the month a date falls in. */
export function endOfMonth(date: string): string {
  return addDays(addMonths(firstOfMonth(date), 1), -1);
}

/**
 * The instalments a payment on `valueDate` is for: everything due up to the end of that month (arrears and
 * this month's instalment), and at least the next instalment not yet paid, so paying an instalment a little
 * early is still that instalment. Returns the last sequence number covered (0 when none).
 */
export function dueNowThrough(instalments: { sequence: number; dueDate: string; status: string; totalDue: string; principalPaid: string; interestPaid: string }[], valueDate: string): number {
  const cutoff = endOfMonth(valueDate);
  const open = instalments.filter((i) => i.status !== "superseded").sort((a, b) => a.sequence - b.sequence);
  let through = 0;
  for (const i of open) {
    if (i.dueDate <= cutoff) { through = i.sequence; continue; }
    const unpaid = dec(i.totalDue).minus(i.principalPaid).minus(i.interestPaid).greaterThan(0);
    if (unpaid) { through = i.sequence; break; }
    through = i.sequence;
  }
  return through;
}

/**
 * Split a receipt into interest, principal and overpayment. It clears what is due now (see dueNowThrough;
 * interest before principal). There is no early repayment: a loan is repaid by monthly deduction over the tenor
 * chosen, so anything more is held as an overpayment (to be refunded) and the schedule is unchanged.
 */
export async function repaymentLines(db: Executor, loanAccountId: string, amount: string, valueDate: string): Promise<Line[]> {
  const bal = await accountBalances(db, loanAccountId);
  const cur = await currentSchedule(db, loanAccountId);
  if (!cur) throw new DomainError("This loan has no active repayment schedule.");
  const through = dueNowThrough(cur.instalments, valueDate);
  let pool = dec(amount);
  let interest = ZERO;
  let principal = ZERO;
  for (const i of cur.instalments) {
    if (pool.lessThanOrEqualTo(0) || i.sequence > through) break;
    const iDue = D.max(0, dec(i.interestDue).minus(i.interestPaid));
    const ip = D.min(pool, iDue);
    interest = interest.plus(ip);
    pool = pool.minus(ip);
    const pDue = D.max(0, dec(i.principalDue).minus(i.principalPaid));
    const pp = D.min(pool, pDue);
    principal = principal.plus(pp);
    pool = pool.minus(pp);
  }
  // Never credit receivables beyond their ledger balances (guards against schedule/ledger drift).
  const iCap = D.max(0, bal.interest);
  const pCap = D.max(0, bal.principal);
  if (interest.greaterThan(iCap)) { pool = pool.plus(interest.minus(iCap)); interest = iCap; }
  if (principal.greaterThan(pCap)) { pool = pool.plus(principal.minus(pCap)); principal = pCap; }
  return [
    { account: "cash_bank", direction: "debit", amount: m(amount) },
    { account: "interest_receivable", direction: "credit", amount: m(interest) },
    { account: "loan_principal", direction: "credit", amount: m(principal) },
    { account: "overpayment_liability", direction: "credit", amount: m(pool) },
  ];
}

/**
 * Settlement figure today: all principal + interest already due; future interest rebated if policy allows.
 * `rebateFutureInterest` always rebates it: a staff member repaying in full early pays interest on the
 * reducing balance up to now, never the interest of the months they no longer borrow for.
 */
export async function settlementQuote(db: Executor, loanAccountId: string, asOf = todayLagos(), opts: { rebateFutureInterest?: boolean } = {}) {
  const [loan] = await db.select().from(loanAccounts).where(eq(loanAccounts.id, loanAccountId));
  if (!loan) throw new NotFoundError("Loan account");
  const policy = (await getPolicyVersion(db, loan.policyVersionId)).params;
  const bal = await accountBalances(db, loanAccountId);
  const cur = await currentSchedule(db, loanAccountId);
  const credit = D.max(0, bal.overpayment);
  if (opts.rebateFutureInterest && cur) {
    // Early repayment in full:
    //   Balance to repay = loan principal + interest to date - total repayments
    // Interest to date, on the reducing balance = the interest of every instalment already due
    //   + the current instalment's interest x days elapsed in its period / days in the period.
    // Interest of the later instalments is not charged.
    const all = [...cur.instalments].sort((a, b) => a.sequence - b.sequence);
    const open = all.filter((i) => i.status !== "superseded");
    let interestToDate = all.filter((i) => i.status === "superseded").reduce((a, i) => a.plus(i.interestPaid), ZERO);
    for (const i of open) if (i.dueDate <= asOf) interestToDate = interestToDate.plus(i.interestDue);
    const k = open.findIndex((i) => i.dueDate > asOf);
    if (k >= 0) {
      const next = open[k];
      const start = k > 0 ? open[k - 1].dueDate : (loan.disbursedAt ? loan.disbursedAt.toISOString().slice(0, 10) : asOf);
      const period = Math.max(1, daysBetween(start, next.dueDate));
      const elapsed = Math.min(period, Math.max(0, daysBetween(start, asOf)));
      interestToDate = interestToDate.plus(dec(next.interestDue).times(elapsed).div(period).toDecimalPlaces(2));
    }
    const totalRepaid = dec(loan.totalRepaid);
    const payable = D.max(0, dec(loan.principal).plus(interestToDate).minus(totalRepaid));
    // In the ledger the loan closes with the interest not charged written off from unearned interest. When
    // instalments were paid ahead, that includes interest already paid for months not yet reached.
    const principal = D.max(0, bal.principal);
    const rebate = principal.plus(bal.interest).minus(credit).minus(payable);
    if (rebate.isNegative() || rebate.greaterThan(D.max(0, bal.unearned))) {
      throw new DomainError("The balance on this loan cannot be worked out automatically because it has been restructured or adjusted. Please contact the Bursary.");
    }
    return {
      loanPrincipal: m(loan.principal), interestToDate: m(interestToDate), totalRepaid: m(totalRepaid),
      principal: m(principal), interestDue: m(bal.interest.minus(rebate)), rebate: m(rebate), overpaymentCredit: m(credit), settlementAmount: m(payable), asOf,
    };
  }
  let rebate = ZERO;
  if (policy.earlySettlementRebate === "unearned_interest" && cur) {
    // Interest on instalments falling due more than one month from today is not yet earned.
    const cutoff = addDays(asOf, 30);
    for (const i of cur.instalments) {
      if (i.dueDate > cutoff) rebate = rebate.plus(D.max(0, dec(i.interestDue).minus(i.interestPaid)));
    }
  }
  rebate = D.min(rebate, D.max(0, bal.interest));
  const interestDue = D.max(0, bal.interest.minus(rebate));
  const principal = D.max(0, bal.principal);
  const payable = D.max(0, principal.plus(interestDue).minus(credit));
  return { loanPrincipal: m(loan.principal), interestToDate: null as string | null, totalRepaid: m(loan.totalRepaid), principal: m(principal), interestDue: m(interestDue), rebate: m(rebate), overpaymentCredit: m(credit), settlementAmount: m(payable), asOf };
}

export function settlementLines(q: Awaited<ReturnType<typeof settlementQuote>>, cashReceived: string): Line[] {
  return [
    { account: "cash_bank", direction: "debit", amount: cashReceived },
    { account: "overpayment_liability", direction: "debit", amount: q.overpaymentCredit },
    { account: "unearned_interest", direction: "debit", amount: q.rebate },
    { account: "interest_receivable", direction: "credit", amount: m(dec(q.interestDue).plus(q.rebate)) },
    { account: "loan_principal", direction: "credit", amount: q.principal },
  ];
}

/* ───────────────────────── Reversals ───────────────────────── */

export async function proposeReversal(db: Executor, actor: Actor, txnId: string, reason: string) {
  assertCan(actor, "transaction.reverse");
  if (reason.trim().length < 5) throw new DomainError("Explain why the transaction is being reversed.");
  return db.transaction(async (tx) => {
    const [orig] = await tx.select().from(financialTransactions).where(eq(financialTransactions.id, txnId)).for("update");
    if (!orig) throw new NotFoundError("Transaction");
    if (orig.status !== "posted") throw new DomainError("Only posted transactions can be reversed.");
    if (!REVERSIBLE.includes(orig.type)) throw new DomainError(`${orig.type.replace("_", " ")} transactions cannot be reversed. Use an adjustment or contact the system administrator.`);
    const [already] = await tx.select({ ref: financialTransactions.reference, status: financialTransactions.status }).from(financialTransactions)
      .where(and(eq(financialTransactions.reversesTransactionId, orig.id), sql`${financialTransactions.status} <> 'rejected'`));
    if (already) throw new DomainError(`This transaction already has a reversal (${already.ref}, ${already.status.replace("_", " ")}).`);
    const entries = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, orig.id));
    const cur = await currentSchedule(tx, orig.loanAccountId);
    if (cur && entries.some((e) => e.id <= cur.schedule.ledgerWatermark)) {
      throw new DomainError("This transaction predates the loan's current (restructured) schedule and cannot be reversed. Record a corrective adjustment instead.");
    }
    if (orig.type === "refund" || orig.type === "repayment" || orig.type === "early_settlement") {
      // Reversing a receipt that created an overpayment credit must not make the credit negative.
      const bal = await accountBalances(tx, orig.loanAccountId);
      const overCredit = sum(entries.filter((e) => e.account === "overpayment_liability" && e.direction === "credit").map((e) => e.amount));
      if (orig.type !== "refund" && overCredit.greaterThan(bal.overpayment)) throw new DomainError("The overpayment from this receipt has already been refunded. Reverse the refund first.");
    }
    const lines: Line[] = entries.map((e) => ({ account: e.account, direction: e.direction === "debit" ? "credit" : "debit", amount: e.amount }));
    const requireApproval = await getSetting(tx, "finance.makerChecker.reversal");
    const { txn } = await createTransaction(tx, actor, {
      loanAccountId: orig.loanAccountId, type: "reversal", amount: orig.amount, valueDate: todayLagos(),
      narration: `Reversal of ${orig.reference}: ${reason.trim()}`, idempotencyKey: `reversal:${orig.id}`, lines, requireApproval, reversesTransactionId: orig.id,
    });
    if (txn.status === "posted") await recomputeLoan(tx, actor, orig.loanAccountId);
    else await notifyPending(tx, actor, txn);
    return txn;
  });
}

export async function notifyPending(db: Executor, actor: Actor, txn: Txn) {
  const [loan] = await db.select({ accountNumber: loanAccounts.accountNumber }).from(loanAccounts).where(eq(loanAccounts.id, txn.loanAccountId));
  await notify(db, {
    template: "transaction.pending_approval", roles: ["ACCOUNTS_ADMIN"], excludeUserIds: [actor.userId], link: `/accounts/approvals`,
    vars: { txnType: txn.type.replace(/_/g, " "), txnRef: txn.reference, amount: formatNaira(txn.amount), accountNumber: loan?.accountNumber, makerName: actor.displayName },
  });
}

export async function linkedClaim(db: Executor, txnId: string) {
  const [c] = await db.select().from(repaymentClaims).where(eq(repaymentClaims.transactionId, txnId));
  return c ?? null;
}
