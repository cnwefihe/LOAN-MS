import { and, eq, inArray, sql, desc } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanApplications, loanAccounts, disbursements, users, staffProfiles, departments, applicationGuarantors, scheduleInstalments, repaymentSchedules, financialTransactions, loanProducts, auditLogs, repaymentClaims } from "@/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { dec, m, sum, formatNaira, type MoneyInput } from "@/lib/finance/money";
import { addMonths, todayLagos, firstOfMonth, formatDate } from "@/lib/finance/dates";
import { assertCan, canAny, type Actor } from "../actor";
import { ForbiddenError } from "../errors";
import { guarantorExposure } from "./guarantors";

const LIVE = ["active", "overdue", "defaulted"] as const;

export async function portfolioSummary(db: Executor, actor: Actor) {
  assertCan(actor, "reports.view");
  const [apps] = await db.select({
    total: sql<number>`count(*) filter (where ${loanApplications.status} <> 'draft')`,
    approved: sql<number>`count(*) filter (where ${loanApplications.status} = 'approved')`,
    declined: sql<number>`count(*) filter (where ${loanApplications.status} = 'declined')`,
    cancelled: sql<number>`count(*) filter (where ${loanApplications.status} = 'cancelled')`,
    inProgress: sql<number>`count(*) filter (where ${loanApplications.status} in ('pending_guarantor','pending_hr','pending_bursary','pending_approval','returned'))`,
    requested: sql<string>`coalesce(sum(${loanApplications.requestedAmount}) filter (where ${loanApplications.status} <> 'draft'), 0)`,
  }).from(loanApplications);
  const [loans] = await db.select({
    approvedAmount: sql<string>`coalesce(sum(${loanAccounts.principal}) filter (where ${loanAccounts.status} <> 'cancelled'), 0)`,
    recovered: sql<string>`coalesce(sum(${loanAccounts.totalRepaid}), 0)`,
    outstanding: sql<string>`coalesce(sum(${loanAccounts.principalOutstanding} + ${loanAccounts.interestOutstanding}) filter (where ${loanAccounts.status} in ('active','overdue','defaulted')), 0)`,
    activeCount: sql<number>`count(*) filter (where ${loanAccounts.status} = 'active')`,
    overdueCount: sql<number>`count(*) filter (where ${loanAccounts.status} = 'overdue')`,
    overdueAmount: sql<string>`coalesce(sum(${loanAccounts.principalOutstanding} + ${loanAccounts.interestOutstanding}) filter (where ${loanAccounts.status} = 'overdue'), 0)`,
    defaultedCount: sql<number>`count(*) filter (where ${loanAccounts.status} = 'defaulted')`,
    defaultedAmount: sql<string>`coalesce(sum(${loanAccounts.principalOutstanding} + ${loanAccounts.interestOutstanding}) filter (where ${loanAccounts.status} = 'defaulted'), 0)`,
    closedCount: sql<number>`count(*) filter (where ${loanAccounts.status} = 'closed')`,
    awaitingDisbursement: sql<number>`count(*) filter (where ${loanAccounts.status} = 'pending_disbursement')`,
  }).from(loanAccounts);
  const [disb] = await db.select({ amount: sql<string>`coalesce(sum(${disbursements.amountDisbursed}), 0)` }).from(disbursements).where(eq(disbursements.status, "confirmed"));
  return {
    applications: { total: Number(apps.total), approved: Number(apps.approved), declined: Number(apps.declined), cancelled: Number(apps.cancelled), inProgress: Number(apps.inProgress), requested: m(apps.requested) },
    loans: {
      approvedAmount: m(loans.approvedAmount), disbursed: m(disb.amount), recovered: m(loans.recovered), outstanding: m(loans.outstanding),
      activeCount: Number(loans.activeCount), overdueCount: Number(loans.overdueCount), overdueAmount: m(loans.overdueAmount),
      defaultedCount: Number(loans.defaultedCount), defaultedAmount: m(loans.defaultedAmount), closedCount: Number(loans.closedCount), awaitingDisbursement: Number(loans.awaitingDisbursement),
    },
  };
}

export async function departmentDistribution(db: Executor, actor: Actor) {
  assertCan(actor, "reports.view");
  const rows = await db.select({
    department: sql<string>`coalesce(${departments.name}, 'Unassigned')`,
    applications: sql<number>`count(distinct ${loanApplications.id})`,
    approvedPrincipal: sql<string>`coalesce(sum(${loanAccounts.principal}), 0)`,
    outstanding: sql<string>`coalesce(sum(${loanAccounts.principalOutstanding} + ${loanAccounts.interestOutstanding}) filter (where ${loanAccounts.status} in ('active','overdue','defaulted')), 0)`,
    liveLoans: sql<number>`count(${loanAccounts.id}) filter (where ${loanAccounts.status} in ('active','overdue','defaulted'))`,
  }).from(loanApplications)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanApplications.applicantId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .leftJoin(loanAccounts, eq(loanAccounts.applicationId, loanApplications.id))
    .where(sql`${loanApplications.status} <> 'draft'`)
    .groupBy(departments.name);
  return rows.map((r) => ({ ...r, applications: Number(r.applications), liveLoans: Number(r.liveLoans), approvedPrincipal: m(r.approvedPrincipal), outstanding: m(r.outstanding) }))
    .sort((a, b) => dec(b.approvedPrincipal).comparedTo(a.approvedPrincipal));
}

export async function guarantorExposureReport(db: Executor, actor: Actor) {
  assertCan(actor, "reports.view");
  const ids = await db.selectDistinct({ id: applicationGuarantors.guarantorId }).from(applicationGuarantors).where(inArray(applicationGuarantors.status, ["pending", "accepted", "clarification_requested"]));
  const out = [];
  for (const { id } of ids) {
    const e = await guarantorExposure(db, id);
    if (!e.liveCount) continue;
    const [u] = await db.select({ name: users.displayName, email: users.email, net: staffProfiles.monthlyNet }).from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(eq(users.id, id));
    out.push({ guarantorId: id, name: u.name, email: u.email, monthlyNet: u.net, liveGuarantees: e.liveCount, potential: e.potential, actual: e.actual, total: e.total });
  }
  return out.sort((a, b) => dec(b.total).comparedTo(a.total));
}

/** Expected (scheduled) vs collected per month for the trailing 12 months. */
export async function repaymentPerformance(db: Executor, actor: Actor, months = 12) {
  assertCan(actor, "reports.view");
  const end = addMonths(firstOfMonth(todayLagos()), 1);
  const start = addMonths(end, -months);
  const due = await db.select({ month: sql<string>`to_char(${scheduleInstalments.dueDate}, 'YYYY-MM')`, amount: sql<string>`sum(${scheduleInstalments.totalDue})` })
    .from(scheduleInstalments).innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
    .where(and(eq(repaymentSchedules.isCurrent, true), sql`${scheduleInstalments.dueDate} >= ${start} and ${scheduleInstalments.dueDate} < ${end}`))
    .groupBy(sql`1`);
  const collected = await db.select({ month: sql<string>`to_char(${financialTransactions.valueDate}, 'YYYY-MM')`, amount: sql<string>`sum(case when ${financialTransactions.type} = 'reversal' then -${financialTransactions.amount} else ${financialTransactions.amount} end)` })
    .from(financialTransactions)
    .where(and(eq(financialTransactions.status, "posted"), sql`${financialTransactions.valueDate} >= ${start} and ${financialTransactions.valueDate} < ${end}`,
      sql`(${financialTransactions.type} = 'repayment' or (${financialTransactions.type} = 'reversal' and exists (select 1 from financial_transactions o where o.id = ${financialTransactions.reversesTransactionId} and o.type = 'repayment')))`))
    .groupBy(sql`1`);
  const out = [];
  for (let i = 0; i < months; i++) {
    const mo = addMonths(start, i).slice(0, 7);
    const d = dec(due.find((x) => x.month === mo)?.amount ?? 0);
    const c = dec(collected.find((x) => x.month === mo)?.amount ?? 0);
    out.push({ month: mo, expected: m(d), collected: m(c), rate: d.isZero() ? null : Number(c.div(d).times(100).toFixed(1)) });
  }
  return out;
}

export async function loanBook(db: Executor, actor: Actor, status?: string) {
  if (!canAny(actor, "reports.view", "accounts.view")) throw new ForbiddenError();
  return db.select({
    accountNumber: loanAccounts.accountNumber, id: loanAccounts.id, borrower: users.displayName, staffNumber: staffProfiles.staffNumber, department: departments.name,
    product: loanProducts.name, status: loanAccounts.status, principal: loanAccounts.principal, totalRepayable: loanAccounts.totalRepayable, totalRepaid: loanAccounts.totalRepaid,
    principalOutstanding: loanAccounts.principalOutstanding, interestOutstanding: loanAccounts.interestOutstanding, monthlyInstalment: loanAccounts.monthlyInstalment,
    daysPastDue: loanAccounts.daysPastDue, disbursedAt: loanAccounts.disbursedAt, maturityDate: loanAccounts.maturityDate,
  }).from(loanAccounts)
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .innerJoin(loanProducts, eq(loanProducts.id, loanAccounts.productId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(status ? eq(loanAccounts.status, status as never) : sql`true`)
    .orderBy(desc(loanAccounts.createdAt));
}

export async function applicationsRegister(db: Executor, actor: Actor) {
  assertCan(actor, "reports.view");
  return db.select({
    reference: loanApplications.reference, applicant: users.displayName, department: departments.name, product: loanProducts.name, status: loanApplications.status,
    requested: loanApplications.requestedAmount, tenor: loanApplications.tenorMonths, eligible: loanApplications.eligibleAmount, submittedAt: loanApplications.submittedAt, decidedAt: loanApplications.decidedAt,
  }).from(loanApplications)
    .innerJoin(users, eq(users.id, loanApplications.applicantId))
    .innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanApplications.applicantId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(sql`${loanApplications.status} <> 'draft'`)
    .orderBy(desc(loanApplications.submittedAt));
}

/* ───────────────────────── Export datasets ───────────────────────── */

export type ColumnType = "text" | "money" | "date" | "datetime" | "status" | "number" | "percent";
export interface Column { key: string; label: string; type?: ColumnType; total?: boolean }
export interface Dataset {
  title: string;
  /** Plain statement of what the figures cover, e.g. "As at 01 Nov 2026" or "01 Jan 2026 to 31 Oct 2026". */
  basis: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  /** Report-specific findings for the executive summary. */
  points: string[];
  /** Report-specific notes and definitions. */
  notes: string[];
}

export type ReportBasis = "as_at" | "period" | "month";
export interface ReportMeta { title: string; description: string; basis: ReportBasis; permission: "reports.export" | "admin.audit.view" | "accounts.view"; landscape?: boolean }

export const REPORTS = {
  loan_book: { title: "Loan book", description: "Every loan account with balances, arrears and maturity.", basis: "as_at", permission: "reports.export", landscape: true },
  overdue: { title: "Overdue and defaulted loans", description: "Loans needing recovery action, oldest arrears first.", basis: "as_at", permission: "reports.export", landscape: true },
  ageing: { title: "Arrears ageing analysis", description: "Outstanding balances grouped by days past due.", basis: "as_at", permission: "reports.export" },
  repayment_claims: { title: "Staff deduction confirmations", description: "Deductions staff reported for the month, with their confirmation status.", basis: "month", permission: "accounts.view", landscape: true },
  payroll_deductions: { title: "Payroll deduction schedule", description: "Amounts payroll should deduct from each borrower for the month.", basis: "month", permission: "accounts.view", landscape: true },
  applications: { title: "Applications register", description: "Applications submitted in the period and their outcome.", basis: "period", permission: "reports.export", landscape: true },
  disbursements: { title: "Disbursements register", description: "Loans disbursed by the Accounts Payable Officer in the period.", basis: "period", permission: "reports.export", landscape: true },
  collections: { title: "Collections register", description: "Repayments and settlements posted in the period.", basis: "period", permission: "reports.export", landscape: true },
  repayment_performance: { title: "Repayment performance (12 months)", description: "Scheduled instalments against confirmed collections by month.", basis: "as_at", permission: "reports.export" },
  departments: { title: "Departmental distribution", description: "Borrowing and outstanding exposure by department.", basis: "as_at", permission: "reports.export" },
  guarantor_exposure: { title: "Guarantor exposure", description: "Staff guaranteeing active loans and their total exposure.", basis: "as_at", permission: "reports.export" },
  audit: { title: "Audit log extract", description: "Recorded actions in the period, for internal audit.", basis: "period", permission: "admin.audit.view", landscape: true },
} as const satisfies Record<string, ReportMeta>;
export type ReportKey = keyof typeof REPORTS;
export const isReportKey = (k: string): k is ReportKey => k in REPORTS;

export interface ReportParams { from: string; to: string; month: string }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Validated report parameters: the period defaults to the last 12 months and the month to the current one. */
export function reportParams(input: { from?: string | null; to?: string | null; month?: string | null }): ReportParams {
  const today = todayLagos();
  let to = input.to && ISO_DAY.test(input.to) ? input.to : today;
  let from = input.from && ISO_DAY.test(input.from) ? input.from : addMonths(firstOfMonth(today), -11);
  if (from > to) [from, to] = [to, from];
  const month = input.month && /^\d{4}-\d{2}$/.test(input.month) ? input.month : today.slice(0, 7);
  return { from, to, month };
}

export function basisText(key: ReportKey, p: ReportParams): string {
  const basis = REPORTS[key].basis;
  if (basis === "period") return `${formatDate(p.from)} to ${formatDate(p.to)}`;
  if (basis === "month") return `Deduction month ${monthName(p.month)}`;
  return `As at ${formatDate(todayLagos())}`;
}

export function monthName(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export { humanise } from "@/lib/text";

const AGEING_BUCKETS = [
  { label: "Current (not past due)", min: 0, max: 0 },
  { label: "1 to 30 days", min: 1, max: 30 },
  { label: "31 to 60 days", min: 31, max: 60 },
  { label: "61 to 90 days", min: 61, max: 90 },
  { label: "91 to 180 days", min: 91, max: 180 },
  { label: "Over 180 days", min: 181, max: Infinity },
];

export async function arrearsAgeing(db: Executor, actor: Actor) {
  assertCan(actor, "reports.view");
  const live = (await loanBook(db, actor)).filter((r) => (LIVE as readonly string[]).includes(r.status));
  const total = sum(live.map((r) => dec(r.principalOutstanding).plus(r.interestOutstanding)));
  return AGEING_BUCKETS.map((b) => {
    const rows = live.filter((r) => r.daysPastDue >= b.min && r.daysPastDue <= b.max);
    const outstanding = sum(rows.map((r) => dec(r.principalOutstanding).plus(r.interestOutstanding)));
    return { bucket: b.label, loans: rows.length, outstanding: m(outstanding), share: total.isZero() ? 0 : Number(outstanding.div(total).times(100).toFixed(1)) };
  });
}

export async function disbursementsRegister(db: Executor, actor: Actor, p: ReportParams) {
  assertCan(actor, "reports.view");
  return db.select({
    paymentDate: disbursements.paymentDate, accountNumber: loanAccounts.accountNumber, borrower: users.displayName, staffNumber: staffProfiles.staffNumber, department: departments.name,
    product: loanProducts.name, approved: disbursements.approvedAmount, disbursed: disbursements.amountDisbursed,
    method: disbursements.paymentMethod, reference: disbursements.transactionReference,
  }).from(disbursements)
    .innerJoin(loanAccounts, eq(loanAccounts.id, disbursements.loanAccountId))
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .innerJoin(loanProducts, eq(loanProducts.id, loanAccounts.productId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(and(eq(disbursements.status, "confirmed"), sql`${disbursements.paymentDate} between ${p.from} and ${p.to}`))
    .orderBy(disbursements.paymentDate);
}

export async function collectionsRegister(db: Executor, actor: Actor, p: ReportParams) {
  assertCan(actor, "reports.view");
  return db.select({
    valueDate: financialTransactions.valueDate, reference: financialTransactions.reference, accountNumber: loanAccounts.accountNumber, borrower: users.displayName,
    staffNumber: staffProfiles.staffNumber, type: financialTransactions.type, externalReference: financialTransactions.externalReference, amount: financialTransactions.amount,
  }).from(financialTransactions)
    .innerJoin(loanAccounts, eq(loanAccounts.id, financialTransactions.loanAccountId))
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .where(and(inArray(financialTransactions.type, ["repayment", "early_settlement"]), eq(financialTransactions.status, "posted"),
      sql`${financialTransactions.valueDate} between ${p.from} and ${p.to}`,
      sql`not exists (select 1 from financial_transactions r where r.reverses_transaction_id = ${financialTransactions.id} and r.status = 'posted')`))
    .orderBy(financialTransactions.valueDate, financialTransactions.reference);
}

/**
 * What payroll should deduct from each borrower in a month: the instalment falling due in that month
 * plus any instalments from earlier months that are already past due and unpaid, from the current schedule.
 */
export async function payrollDeductionSchedule(db: Executor, actor: Actor, month: string) {
  if (!canAny(actor, "reports.view", "accounts.view")) throw new ForbiddenError();
  const start = `${month}-01`;
  const end = addMonths(start, 1);
  const today = todayLagos();
  const unpaid = sql<string>`${scheduleInstalments.totalDue} - ${scheduleInstalments.principalPaid} - ${scheduleInstalments.interestPaid}`;
  const rows = await db.select({
    loanId: loanAccounts.id, accountNumber: loanAccounts.accountNumber, borrower: users.displayName, staffNumber: staffProfiles.staffNumber, department: departments.name,
    dueDate: sql<string | null>`max(${scheduleInstalments.dueDate}) filter (where ${scheduleInstalments.dueDate} >= ${start} and ${scheduleInstalments.dueDate} < ${end})`,
    scheduled: sql<string>`coalesce(sum(${unpaid}) filter (where ${scheduleInstalments.dueDate} >= ${start} and ${scheduleInstalments.dueDate} < ${end}), 0)`,
    // Arrears are instalments already past due today and before the month; later ones are deducted in their own month.
    arrears: sql<string>`coalesce(sum(${unpaid}) filter (where ${scheduleInstalments.dueDate} < ${start} and ${scheduleInstalments.dueDate} < ${today}), 0)`,
  }).from(scheduleInstalments)
    .innerJoin(repaymentSchedules, eq(repaymentSchedules.id, scheduleInstalments.scheduleId))
    .innerJoin(loanAccounts, eq(loanAccounts.id, scheduleInstalments.loanAccountId))
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .where(and(eq(repaymentSchedules.isCurrent, true), inArray(loanAccounts.status, [...LIVE]), sql`${scheduleInstalments.status} <> 'superseded'`, sql`${scheduleInstalments.dueDate} < ${end}`))
    .groupBy(loanAccounts.id, loanAccounts.accountNumber, users.displayName, staffProfiles.staffNumber, departments.name);
  return rows
    .map((r) => ({ ...r, scheduled: m(r.scheduled), arrears: m(r.arrears), total: m(dec(r.scheduled).plus(r.arrears)) }))
    .filter((r) => dec(r.total).greaterThan(0))
    .sort((a, b) => String(a.staffNumber ?? "").localeCompare(String(b.staffNumber ?? "")) || a.accountNumber.localeCompare(b.accountNumber));
}

/** Deductions that staff marked as taken from their salary in a month, and what Accounts did about each. */
export async function repaymentClaimsForMonth(db: Executor, actor: Actor, month: string) {
  if (!canAny(actor, "reports.view", "accounts.view")) throw new ForbiddenError();
  const reviewer = alias(users, "reviewer");
  const rows = await db.select({
    staffNumber: staffProfiles.staffNumber, borrower: users.displayName, department: departments.name, reference: loanAccounts.accountNumber,
    reported: repaymentClaims.amount, reportedOn: repaymentClaims.createdAt, channel: repaymentClaims.channel, payerReference: repaymentClaims.payerReference,
    status: repaymentClaims.status, confirmed: financialTransactions.amount, reviewedBy: reviewer.displayName, reviewedAt: repaymentClaims.reviewedAt,
  }).from(repaymentClaims)
    .innerJoin(loanAccounts, eq(loanAccounts.id, repaymentClaims.loanAccountId))
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .leftJoin(departments, eq(departments.id, staffProfiles.departmentId))
    .leftJoin(financialTransactions, eq(financialTransactions.id, repaymentClaims.transactionId))
    .leftJoin(reviewer, eq(reviewer.id, repaymentClaims.reviewedBy))
    .where(eq(repaymentClaims.deductionMonth, `${month}-01`))
    .orderBy(staffProfiles.staffNumber, repaymentClaims.createdAt);
  return rows.map((x) => ({ ...x, confirmed: x.confirmed ?? "0.00" }));
}

export async function auditExtract(db: Executor, actor: Actor, p: ReportParams) {
  assertCan(actor, "admin.audit.view");
  return db.select({ createdAt: auditLogs.createdAt, actor: users.displayName, action: auditLogs.action, entityType: auditLogs.entityType, entityId: auditLogs.entityId, summary: auditLogs.summary, ipAddress: auditLogs.ipAddress })
    .from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(sql`(${auditLogs.createdAt} at time zone 'Africa/Lagos')::date between ${p.from} and ${p.to}`)
    .orderBy(auditLogs.createdAt, auditLogs.id)
    .limit(50_000);
}

const money = (key: string, label: string): Column => ({ key, label, type: "money", total: true });
const naira = (v: MoneyInput) => formatNaira(v);

export async function buildDataset(db: Executor, actor: Actor, key: ReportKey, p: ReportParams = reportParams({})): Promise<Dataset> {
  const title = REPORTS[key].title;
  const basis = basisText(key, p);
  switch (key) {
    case "loan_book":
    case "overdue": {
      const all = await loanBook(db, actor);
      const rows = (key === "overdue" ? all.filter((r) => r.status === "overdue" || r.status === "defaulted").sort((a, b) => b.daysPastDue - a.daysPastDue) : all)
        .map((r) => ({ ...r, outstanding: m(dec(r.principalOutstanding).plus(r.interestOutstanding)) }));
      const outstanding = sum(rows.map((r) => r.outstanding));
      const live = rows.filter((r) => (LIVE as readonly string[]).includes(r.status));
      return {
        title, basis,
        columns: [
          { key: "accountNumber", label: "Account" }, { key: "borrower", label: "Borrower" }, { key: "staffNumber", label: "Staff no." }, { key: "department", label: "Department" },
          { key: "product", label: "Product" }, { key: "status", label: "Status", type: "status" }, money("principal", "Principal"), money("totalRepaid", "Repaid"),
          money("outstanding", "Outstanding"), { key: "daysPastDue", label: "Days past due", type: "number" }, { key: "maturityDate", label: "Maturity", type: "date" },
        ],
        rows,
        points: key === "overdue"
          ? [rows.length ? `${plural(rows.length, "loan")} ${rows.length === 1 ? "is" : "are"} overdue or in default, with ${naira(m(outstanding))} outstanding. The oldest arrears are ${rows[0].daysPastDue} days past due.` : "No loans are overdue or in default."]
          : [`${plural(rows.length, "loan account")} on the book, of which ${live.length} ${live.length === 1 ? "is" : "are"} active. Total outstanding is ${naira(m(outstanding))}.`],
        notes: ["Outstanding is principal plus interest due and unpaid, after all confirmed postings.", "Days past due counts from the oldest unpaid instalment."],
      };
    }
    case "ageing": {
      const rows = await arrearsAgeing(db, actor);
      const past = rows.slice(1);
      const pastAmt = sum(past.map((r) => r.outstanding));
      return {
        title, basis,
        columns: [{ key: "bucket", label: "Days past due" }, { key: "loans", label: "Loans", type: "number", total: true }, money("outstanding", "Outstanding"), { key: "share", label: "Share of portfolio", type: "percent" }],
        rows,
        points: [pastAmt.isZero() ? "No live loan has an instalment past due." : `${naira(m(pastAmt))} (${(100 - rows[0].share).toFixed(1)}% of the live portfolio) is past due. ${naira(rows.slice(3).reduce((a, r) => a.plus(r.outstanding), dec(0)).toFixed(2))} is more than 60 days past due.`],
        notes: ["Only live loans (active, overdue or defaulted) are included.", "Provisioning, where adopted by the Bursary, is normally applied to the buckets over 90 days."],
      };
    }
    case "repayment_claims": {
      const rows = await repaymentClaimsForMonth(db, actor, p.month);
      const confirmed = rows.filter((x) => x.status === "confirmed");
      const pending = rows.filter((x) => x.status === "pending");
      return {
        title, basis,
        columns: [{ key: "staffNumber", label: "Staff no." }, { key: "borrower", label: "Staff name" }, { key: "department", label: "Department" }, { key: "reference", label: "Loan reference" },
          money("reported", "Amount reported"), { key: "reportedOn", label: "Reported on", type: "date" }, { key: "status", label: "Status", type: "status" },
          money("confirmed", "Amount confirmed"), { key: "reviewedBy", label: "Confirmed by" }, { key: "reviewedAt", label: "Confirmed on", type: "date" }],
        rows,
        points: [`${plural(rows.length, "deduction")} reported for ${monthName(p.month)}: ${confirmed.length} confirmed (${naira(m(sum(confirmed.map((x) => x.confirmed))))}), ${pending.length} awaiting confirmation and ${rows.length - confirmed.length - pending.length} rejected.`],
        notes: ["Staff report a deduction once it appears on their payslip. Balances fall only when the Bursary confirms it against payroll or bank records.", "Use this list to reconcile with the payroll deduction file for the month."],
      };
    }
    case "payroll_deductions": {
      const rows = await payrollDeductionSchedule(db, actor, p.month);
      const total = sum(rows.map((r) => r.total));
      const arrears = rows.filter((r) => dec(r.arrears).greaterThan(0));
      return {
        title, basis,
        columns: [{ key: "staffNumber", label: "Staff no." }, { key: "borrower", label: "Staff name" }, { key: "department", label: "Department" }, { key: "accountNumber", label: "Loan account" },
          { key: "dueDate", label: "Due date", type: "date" }, money("scheduled", "Instalment due"), money("arrears", "Arrears brought forward"), money("total", "Total to deduct")],
        rows,
        points: [`${plural(rows.length, "deduction")} totalling ${naira(m(total))} for ${monthName(p.month)}.`, arrears.length ? `${plural(arrears.length, "borrower")} also ${arrears.length === 1 ? "has" : "have"} arrears brought forward from earlier months.` : "No borrower has arrears brought forward."],
        notes: ["Amounts come from the current repayment schedule, net of confirmed payments.", "Send this schedule to payroll before the payroll cut-off. After payroll runs, import the actual deductions under Accounts > Repayments so that receipts are issued.", "Where a deduction would breach the salary deduction cap, agree the treatment of arrears with the borrower and the Bursary."],
      };
    }
    case "applications": {
      const rows = (await applicationsRegister(db, actor)).filter((r) => r.submittedAt && toLagosDay(r.submittedAt) >= p.from && toLagosDay(r.submittedAt) <= p.to);
      const approved = rows.filter((r) => r.status === "approved").length;
      const declined = rows.filter((r) => r.status === "declined").length;
      return {
        title, basis,
        columns: [{ key: "reference", label: "Reference" }, { key: "applicant", label: "Applicant" }, { key: "department", label: "Department" }, { key: "product", label: "Product" }, { key: "status", label: "Status", type: "status" }, money("requested", "Requested"), money("eligible", "Eligible"), { key: "tenor", label: "Months", type: "number" }, { key: "submittedAt", label: "Submitted", type: "date" }, { key: "decidedAt", label: "Decided", type: "date" }],
        rows,
        points: [`${plural(rows.length, "application")} submitted in the period for ${naira(m(sum(rows.map((r) => r.requested))))}: ${approved} approved, ${declined} declined and ${rows.length - approved - declined} other.`],
        notes: ["Drafts that were never submitted are excluded.", "Eligible is the maximum the policy allowed at assessment."],
      };
    }
    case "disbursements": {
      const rows = await disbursementsRegister(db, actor, p);
      return {
        title, basis,
        columns: [{ key: "paymentDate", label: "Payment date", type: "date" }, { key: "accountNumber", label: "Account" }, { key: "borrower", label: "Borrower" }, { key: "staffNumber", label: "Staff no." }, { key: "product", label: "Product" }, money("approved", "Approved"), money("disbursed", "Paid out"), { key: "method", label: "Method", type: "status" }, { key: "reference", label: "Payment reference" }],
        rows,
        points: [`${plural(rows.length, "disbursement")} confirmed in the period, disbursing ${naira(m(sum(rows.map((r) => r.disbursed))))}.`],
        notes: ["Only disbursements confirmed by a second officer (maker-checker) are included."],
      };
    }
    case "collections": {
      const rows = await collectionsRegister(db, actor, p);
      return {
        title, basis,
        columns: [{ key: "valueDate", label: "Value date", type: "date" }, { key: "accountNumber", label: "Loan reference" }, { key: "borrower", label: "Borrower" }, { key: "staffNumber", label: "Staff no." }, { key: "type", label: "Type", type: "status" }, { key: "externalReference", label: "Bank or payroll reference" }, money("amount", "Amount")],
        rows,
        points: [`${plural(rows.length, "receipt")} posted in the period, totalling ${naira(m(sum(rows.map((r) => r.amount))))}.`],
        notes: ["Receipts that were later reversed are excluded.", "Every payment carries its loan's reference and can be checked against the loan statement."],
      };
    }
    case "departments": {
      const rows = await departmentDistribution(db, actor);
      return {
        title, basis,
        columns: [{ key: "department", label: "Department" }, { key: "applications", label: "Applications", type: "number", total: true }, { key: "liveLoans", label: "Active loans", type: "number", total: true }, money("approvedPrincipal", "Approved principal"), money("outstanding", "Outstanding")],
        rows,
        points: rows.length ? [`${rows[0].department} has the largest approved principal (${naira(rows[0].approvedPrincipal)}).`] : [],
        notes: ["Departments are taken from the borrower's current Human Resources record."],
      };
    }
    case "guarantor_exposure": {
      const rows = await guarantorExposureReport(db, actor);
      return {
        title, basis,
        columns: [{ key: "name", label: "Guarantor" }, { key: "email", label: "Email" }, { key: "liveGuarantees", label: "Active guarantees", type: "number", total: true }, money("potential", "Potential (pre-disbursement)"), money("actual", "Actual (disbursed)"), money("total", "Total exposure")],
        rows,
        points: rows.length ? [`${plural(rows.length, "member of staff", "members of staff")} currently guarantee live loans. The highest single exposure is ${naira(rows[0].total)}.`] : ["No member of staff currently guarantees a live loan."],
        notes: ["Potential exposure covers approved loans not yet disbursed; actual exposure covers disbursed loans."],
      };
    }
    case "repayment_performance": {
      const rows = (await repaymentPerformance(db, actor)).map((r) => ({ ...r, month: monthName(r.month) }));
      const exp = sum(rows.map((r) => r.expected));
      const col = sum(rows.map((r) => r.collected));
      return {
        title, basis,
        columns: [{ key: "month", label: "Month" }, money("expected", "Expected"), money("collected", "Collected"), { key: "rate", label: "Collection rate", type: "percent" }],
        rows,
        points: [exp.isZero() ? "No instalments fell due in the 12 months." : `${naira(m(col))} collected against ${naira(m(exp))} scheduled, a collection rate of ${col.div(exp).times(100).toFixed(1)}%.`],
        notes: ["Expected is the total of instalments falling due in each month on the current schedules.", "Collected is confirmed repayments by value date, net of reversals."],
      };
    }
    case "audit": {
      const rows = await auditExtract(db, actor, p);
      return {
        title, basis,
        columns: [{ key: "createdAt", label: "When (WAT)", type: "datetime" }, { key: "actor", label: "By" }, { key: "action", label: "Action" }, { key: "entityType", label: "Record type" }, { key: "entityId", label: "Record" }, { key: "summary", label: "Summary" }, { key: "ipAddress", label: "IP address" }],
        rows: rows.map((r) => ({ ...r, actor: r.actor ?? "System" })),
        points: [`${plural(rows.length, "recorded action")} in the period.`],
        notes: ["The audit log is append-only: entries cannot be edited or deleted.", "Extracts are limited to 50,000 entries; narrow the period for larger ranges."],
      };
    }
  }
}

function toLagosDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(d);
}

export function totalOf(rows: Record<string, unknown>[], key: string) {
  return m(sum(rows.map((r) => String(r[key] ?? 0))));
}

/** Notes printed at the end of every report, after the report-specific ones. */
export const STANDARD_NOTES = [
  "Figures come from transactions confirmed by the Bursary under maker-checker control. Items awaiting confirmation are excluded.",
  "Amounts are in Nigerian naira (NGN). Dates and times are West Africa Time.",
  "Portfolio at risk is the outstanding balance of overdue and defaulted loans as a percentage of the live portfolio.",
  "This document is registered under the reference shown in the footer. Its authenticity can be checked under Authenticate.",
];

/* ───────────────────────── Executive summary ───────────────────────── */

export interface ExecutiveSummary {
  asOf: string;
  tiles: { label: string; value: string; money?: boolean; tone?: "default" | "good" | "warn" | "bad" }[];
  points: string[];
}

const pct = (part: string, whole: string) => (dec(whole).isZero() ? null : Number(dec(part).div(whole).times(100).toFixed(1)));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Headline figures and plain-English findings for management, used on screen and in every export. */
export async function executiveSummary(db: Executor, actor: Actor): Promise<ExecutiveSummary> {
  const s = await portfolioSummary(db, actor);
  const perf = await repaymentPerformance(db, actor, 12);
  const expected = m(sum(perf.map((p) => p.expected)));
  const collected = m(sum(perf.map((p) => p.collected)));
  const collectionRate = pct(collected, expected);
  const atRisk = m(dec(s.loans.overdueAmount).plus(s.loans.defaultedAmount));
  const par = pct(atRisk, s.loans.outstanding);
  const decided = s.applications.approved + s.applications.declined;
  const approvalRate = decided ? Number(((s.applications.approved / decided) * 100).toFixed(1)) : null;
  const live = s.loans.activeCount + s.loans.overdueCount + s.loans.defaultedCount;
  const fmt = (v: string) => formatNaira(v);

  const points: string[] = [];
  points.push(`${plural(s.applications.total, "application")} submitted to date for ${fmt(s.applications.requested)}; ${s.applications.inProgress} still in progress.${approvalRate === null ? "" : ` ${approvalRate}% of decided applications were approved.`}`);
  points.push(`${fmt(s.loans.disbursed)} has been disbursed and ${fmt(s.loans.recovered)} recovered. ${plural(live, "loan")} ${live === 1 ? "is" : "are"} active with ${fmt(s.loans.outstanding)} outstanding; ${plural(s.loans.closedCount, "loan")} fully repaid.`);
  points.push(collectionRate === null ? "No instalments fell due in the last 12 months, so there is no collection rate yet." : `Over the last 12 months ${fmt(collected)} was collected against ${fmt(expected)} scheduled, a collection rate of ${collectionRate}%.`);
  if (s.loans.overdueCount || s.loans.defaultedCount) {
    points.push(`${plural(s.loans.overdueCount, "loan")} overdue (${fmt(s.loans.overdueAmount)}) and ${plural(s.loans.defaultedCount, "loan")} in default (${fmt(s.loans.defaultedAmount)}): ${par ?? 0}% of the outstanding portfolio is at risk.`);
  } else {
    points.push("No loans are overdue or in default.");
  }
  if (s.loans.awaitingDisbursement) points.push(`${plural(s.loans.awaitingDisbursement, "approved loan")} ${s.loans.awaitingDisbursement === 1 ? "is" : "are"} awaiting payment by the Bursary.`);

  return {
    asOf: todayLagos(),
    tiles: [
      { label: "Applications", value: String(s.applications.total) },
      { label: "Approval rate", value: approvalRate === null ? "Not yet" : `${approvalRate}%` },
      { label: "Disbursed", value: s.loans.disbursed, money: true },
      { label: "Recovered", value: s.loans.recovered, money: true, tone: "good" },
      { label: "Outstanding", value: s.loans.outstanding, money: true },
      { label: "Active loans", value: String(live) },
      { label: "Collection rate (12m)", value: collectionRate === null ? "Not yet" : `${collectionRate}%`, tone: collectionRate === null ? "default" : collectionRate >= 95 ? "good" : collectionRate >= 80 ? "warn" : "bad" },
      { label: "Portfolio at risk", value: par === null ? "0%" : `${par}%`, tone: !par ? "good" : par < 5 ? "warn" : "bad" },
    ],
    points,
  };
}
