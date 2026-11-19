import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { repaymentClaims, loanAccounts, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { payrollDeductionSchedule, repaymentClaimsForMonth, monthName } from "@/server/services/reports";
import { addMonths, addDays, todayLagos } from "@/lib/finance/dates";
import { dec, m, sum } from "@/lib/finance/money";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, PageHeader, Money, DateText, StatusBadge, EmptyState, Table, Th, Td, Stat, StatGrid } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { MonthToolbar, ReportDownloads } from "@/components/report-downloads";
import { confirmClaimAction, rejectClaimAction } from "@/app/actions/accounts";

export const metadata = { title: "Repayments" };

/** Reported amount against what the schedule says is due for the month (including arrears). */
function Variance({ reported, due }: { reported: string; due: string | undefined }) {
  if (due === undefined) return <Badge tone="neutral">Nothing due</Badge>;
  const diff = dec(reported).minus(due);
  if (diff.isZero()) return <Badge tone="success">Matches amount due</Badge>;
  return diff.isNegative() ? <Badge tone="warning">Short by <Money value={m(diff.abs())} /></Badge> : <Badge tone="info">Over by <Money value={m(diff)} /></Badge>;
}

export default async function Repayments({ searchParams }: { searchParams: Promise<{ month?: string; page?: string; size?: string; duePage?: string; duePageSize?: string; donePage?: string; donePageSize?: string }> }) {
  const actor = await requireActor("accounts.view", "repayment.confirm");
  const sp = await searchParams;
  const today = todayLagos();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= today.slice(0, 7) ? sp.month! : today.slice(0, 7);
  const db = await getDb();
  const [due, claims] = await Promise.all([payrollDeductionSchedule(db, actor, month), repaymentClaimsForMonth(db, actor, month)]);
  const pending = await db.select({ c: repaymentClaims, acct: loanAccounts.accountNumber, loanId: loanAccounts.id, borrower: users.displayName })
    .from(repaymentClaims).innerJoin(loanAccounts, eq(loanAccounts.id, repaymentClaims.loanAccountId)).innerJoin(users, eq(users.id, repaymentClaims.claimedBy))
    .where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId))).orderBy(repaymentClaims.deductionMonth, repaymentClaims.createdAt);
  const dueByLoan = new Map(due.map((r) => [r.accountNumber, r.total]));
  const reportedRefs = new Set(claims.filter((c) => c.status !== "rejected").map((c) => c.reference));
  const notReported = due.filter((r) => !reportedRefs.has(r.accountNumber));
  const confirmed = claims.filter((c) => c.status === "confirmed");
  const processed = claims.filter((c) => c.status !== "pending");
  const canConfirm = can(actor, "repayment.confirm");
  // Value date defaults to the last day of the deduction month (payroll run), never later than today.
  const valueDateFor = (deductionMonth: string) => { const last = addDays(addMonths(deductionMonth.slice(0, 10), 1), -1); return last < today ? last : today; };

  const toConfirm = paginate(pending, sp.page, sp.size);
  const dueList = paginate(notReported, sp.duePage, sp.duePageSize);
  const doneList = paginate(processed, sp.donePage, sp.donePageSize);

  return (
    <>
      <PageHeader title="Repayments" crumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Repayments" }]}
        description="Confirm each loan's first salary deduction. Later ones are recorded automatically." />
      <MonthToolbar month={month} max={today.slice(0, 7)}>
        <ReportDownloads label title="Repayment report" href={(f) => `/api/reports/export?report=repayment_claims&format=${f}&month=${month}`} />
        <ReportDownloads label title="Deduction schedule" href={(f) => `/api/reports/export?report=payroll_deductions&format=${f}&month=${month}`} />
      </MonthToolbar>

      <StatGrid>
        <Stat label="Awaiting confirmation" value={pending.length} hint="All months" tone={pending.length ? "warning" : "default"} />
        <Stat label={`Confirmed, ${monthName(month)}`} value={<Money value={m(sum(confirmed.map((c) => c.confirmed)))} />} hint={`${confirmed.length} repayment${confirmed.length === 1 ? "" : "s"}`} tone="success" />
        <Stat label="Still due, not reported" value={<Money value={m(sum(notReported.map((r) => r.total)))} />} hint={`${notReported.length} loan${notReported.length === 1 ? "" : "s"}`} tone={notReported.length ? "danger" : "default"} />
        <Stat label="Rejected reports" value={claims.filter((c) => c.status === "rejected").length} hint={monthName(month)} />
      </StatGrid>

      <Card title={`Awaiting confirmation (${pending.length})`} description="Check each against payroll or the bank statement before confirming." className="mb-6">
        {pending.length === 0 ? <EmptyState title="Nothing awaiting confirmation" /> : (
          <ul className="space-y-4">
            {toConfirm.items.map(({ c, acct, loanId, borrower }) => (
              <li key={c.id} className="rounded-md border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="text-sm">
                    <p><span className="font-medium">{borrower}</span> · <Link className="link" href={`/accounts/loans/${loanId}`}>{acct}</Link> · {monthName(c.deductionMonth.slice(0, 7))}</p>
                    <p className="mt-1 text-xs text-muted">{c.channel === "payroll" ? "Salary deduction" : "Bank transfer"}{c.payerReference && ` · ref ${c.payerReference}`}{c.note && ` · “${c.note}”`}{c.evidenceDocumentId && <> · <a className="link" href={`/api/documents/${c.evidenceDocumentId}`}>evidence</a></>} · reported <DateText value={c.createdAt} withTime /></p>
                  </div>
                  <div className="text-right text-sm">
                    <p>Reported <Money value={c.amount} className="font-semibold" />{c.deductionMonth.slice(0, 7) === month && dueByLoan.has(acct) && <> · due <Money value={dueByLoan.get(acct)} /></>}</p>
                    {c.deductionMonth.slice(0, 7) === month && <div className="mt-1"><Variance reported={c.amount} due={dueByLoan.get(acct)} /></div>}
                  </div>
                </div>
                {canConfirm && c.claimedBy !== actor.userId && (
                  <div className="mt-3 grid gap-4 border-t border-line pt-3 lg:grid-cols-3">
                    <div className="lg:col-span-2">
                      <ActionForm action={confirmClaimAction.bind(null, c.id)} submitLabel="Confirm repayment" variant="success">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <div><label className="label" htmlFor={`a-${c.id}`}>Amount received (₦)</label><input id={`a-${c.id}`} name="amount" defaultValue={c.amount} required className="input" /></div>
                          <div><label className="label" htmlFor={`v-${c.id}`}>Value date</label><DateInput id={`v-${c.id}`} name="valueDate" max={today} defaultValue={valueDateFor(c.deductionMonth)} required /></div>
                          <div><label className="label" htmlFor={`r-${c.id}`}>Payroll or bank reference</label><input id={`r-${c.id}`} name="bankReference" required className="input" /></div>
                        </div>
                      </ActionForm>
                    </div>
                    <ActionForm action={rejectClaimAction.bind(null, c.id)} submitLabel="Reject report" variant="secondary">
                      <label className="label" htmlFor={`x-${c.id}`}>Reason (sent to the borrower)</label><input id={`x-${c.id}`} name="reason" required className="input" />
                    </ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <Pagination data={toConfirm} base="/accounts/repayments" params={sp} label="reports" />
      </Card>

      <Card title={`Due but not reported, ${monthName(month)} (${notReported.length})`} description="Due this month with no report. Post them on the loan account." className="mb-6" bodyClassName="p-5 pt-0">
        {notReported.length === 0 ? <div className="pt-5"><EmptyState title="Every instalment due has been reported" /></div> : (
          <Table caption="Due but not reported">
            <thead><tr><Th>Staff no.</Th><Th>Borrower</Th><Th>Loan reference</Th><Th>Due date</Th><Th right>Due this month</Th><Th right>Arrears</Th><Th right>Total due</Th><Th /></tr></thead>
            <tbody>{dueList.items.map((r) => (
              <tr key={r.loanId}><Td>{r.staffNumber ?? "N/A"}</Td><Td>{r.borrower}</Td><Td>{r.accountNumber}</Td><Td><DateText value={r.dueDate} /></Td><Td right><Money value={r.scheduled} /></Td><Td right><Money value={r.arrears} /></Td><Td right className="font-medium"><Money value={r.total} /></Td>
                <Td><Link className="btn-secondary h-8 px-3 text-xs" href={`/accounts/loans/${r.loanId}`}>Record<span className="sr-only"> repayment for {r.accountNumber}</span></Link></Td></tr>
            ))}</tbody>
          </Table>
        )}
        <Pagination data={dueList} base="/accounts/repayments" params={sp} param="duePage" label="loans" />
      </Card>

      <Card title={`Processed, ${monthName(month)}`} bodyClassName="p-5 pt-0">
        {processed.length === 0 ? <div className="pt-5"><EmptyState title="None processed for this month" /></div> : (
          <Table caption="Processed repayment reports">
            <thead><tr><Th>Staff no.</Th><Th>Borrower</Th><Th>Loan reference</Th><Th right>Reported</Th><Th right>Confirmed</Th><Th>Status</Th><Th>By</Th><Th>On</Th></tr></thead>
            <tbody>{doneList.items.map((c, i) => (
              <tr key={i}><Td>{c.staffNumber ?? "N/A"}</Td><Td>{c.borrower}</Td><Td>{c.reference}</Td><Td right><Money value={c.reported} /></Td><Td right><Money value={c.confirmed} /></Td><Td><StatusBadge status={c.status} /></Td><Td>{c.reviewedBy ?? ""}</Td><Td><DateText value={c.reviewedAt} /></Td></tr>
            ))}</tbody>
          </Table>
        )}
        <Pagination data={doneList} base="/accounts/repayments" params={sp} param="donePage" label="reports" />
      </Card>
    </>
  );
}
