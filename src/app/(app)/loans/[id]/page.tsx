import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getLoanDetail } from "@/server/services/loans";
import { listDocumentsFor } from "@/server/services/documents";
import { todayLagos } from "@/lib/finance/dates";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import type { StaffEligibility } from "@/lib/finance/staff-eligibility";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, PageHeader, StatusBadge, Tabs, Badge, KeyValues, Money, DateText } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { DocumentList } from "@/components/panels";
import { LoanSummary, ScheduleTable, TransactionsTable, ClaimsTable } from "@/components/loan-panels";
import { submitClaimAction, requestRestructureAction } from "@/app/actions/applicant";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Loan" };

export default async function LoanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string; size?: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const { tab = "schedule", page, size } = await searchParams;
  const db = await getDb();
  const d = await getLoanDetail(db, actor, id).catch(() => null);
  if (!d) notFound();
  const { loan } = d;
  const docs = await listDocumentsFor(db, actor, { loanAccountId: id, applicationId: loan.applicationId });
  const serviceable = ["active", "overdue", "defaulted"].includes(loan.status);
  const pendingRestructure = d.restructures.find((r) => r.status === "pending");
  const disbursed = d.disbursements.find((x) => x.status === "confirmed");
  const thisMonth = todayLagos().slice(0, 7);
  const claimThisMonth = d.claims.find((c) => c.deductionMonth.slice(0, 7) === thisMonth && c.status !== "rejected");
  // An advance is not a loan: part of a payment the staff member is due, recovered from that payment.
  const advance = d.app.advanceType ? (d.app.quote as unknown as StaffEligibility).advance : undefined;
  const advanceLabel = d.app.advanceType ? ADVANCE_TYPES[d.app.advanceType].toLowerCase() : "";
  const kind = advance ? "Advance" : "Loan";
  const monthLabel = new Date(`${thisMonth}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <>
      <PageHeader title={`${kind} ${loan.accountNumber}`} crumbs={[{ label: d.isBorrower ? "My loans" : "Loans", href: d.isBorrower ? "/loans" : "/guarantor" }, { label: loan.accountNumber }]}
        description={<>{d.product.name}{advance ? ` (against ${advanceLabel})` : ""} · {d.isBorrower ? `Your ${kind.toLowerCase()}` : `Borrower: ${d.borrower.displayName}`} · <Link className="link" href={`/applications/${loan.applicationId}`}>Application history</Link></>}
        actions={<><StatusBadge status={loan.status} />{loan.disbursedAt && <a href={`/api/loans/${id}/statement`} className="btn-secondary"><Download aria-hidden className="h-4 w-4" /> Statement (PDF)</a>}{loan.status === "closed" && <a href={`/api/loans/${id}/clearance`} className="btn-primary"><Download aria-hidden className="h-4 w-4" /> Clearance letter</a>}</>} />

      <Card className="mb-6"><LifecycleTracker applicantId={d.app.applicantId} appStatus={d.app.status} loanStatus={loan.status} level={d.app.currentApprovalLevel} /></Card>
      {advance && (
        <div className="mb-6"><Alert tone="info" title={`Advance against your ${advanceLabel}`}>
          <Money value={loan.principal} /> will be deducted from your {advanceLabel}{loan.firstDueDate ? <> on <DateText value={loan.firstDueDate} /></> : ""}; you will still receive <Money value={advance.remaining} />.
        </Alert></div>
      )}
      {!advance && loan.status === "pending_disbursement" && <div className="mb-6"><Alert tone="info" title="Approved and awaiting payment">It will be paid into your salary account shortly.</Alert></div>}
      {loan.status === "overdue" && <div className="mb-6"><Alert tone="warning" title={`Repayment overdue (${loan.daysPastDue} days)`}>If it was deducted from your salary, report it below.</Alert></div>}
      {loan.status === "defaulted" && <div className="mb-6"><Alert tone="danger" title="Loan in default">Please contact the Bursary urgently.</Alert></div>}

      {d.isBorrower && serviceable && tab !== "report" && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50 px-5 py-4">
          <div>
            <p className="font-semibold text-navy">{!claimThisMonth ? `Report your ${monthLabel} repayment` : claimThisMonth.status === "confirmed" ? `${monthLabel} repayment confirmed` : `${monthLabel} repayment reported`}</p>
            <p className="text-sm text-muted">{!claimThisMonth ? "Report it once it appears on your payslip." : claimThisMonth.status === "confirmed" ? "Confirmed; your balance is updated." : "Awaiting confirmation by the Bursary."}</p>
          </div>
          {!claimThisMonth && <Link href={`/loans/${id}?tab=report`} className="btn-primary">Report repayment</Link>}
        </div>
      )}
      <Card title="Summary" className="mb-6"><LoanSummary d={d} /></Card>
      {disbursed && (
        <Card title="Disbursement" className="mb-6" description="Payment made to your salary account by the Bursary.">
          <KeyValues columns={3} items={[
            ["Approved amount", <Money key="a" value={disbursed.approvedAmount} />], ["Amount disbursed", <Money key="p" value={disbursed.amountDisbursed} />],
            ["Payment date", <DateText key="d" value={disbursed.paymentDate} />], ["Method", disbursed.paymentMethod.replace("_", " ")], ["Bank reference", disbursed.transactionReference],
            ["Paid into", `${disbursed.beneficiaryName}, ${disbursed.beneficiaryBank ?? ""} ••••${disbursed.beneficiaryAccountLast4 ?? ""}`], ["First repayment due", <DateText key="fd" value={loan.firstDueDate} />], ["Final repayment due", <DateText key="md" value={loan.maturityDate} />],
          ]} />
        </Card>
      )}

      <Tabs base={`/loans/${id}`} active={tab} tabs={[
        { key: "schedule", label: "Repayment schedule" }, { key: "payments", label: "Payments", count: d.txns.filter((t) => t.t.status === "posted" && t.t.type !== "interest_recognition").length },
        { key: "report", label: "Report a repayment", count: d.claims.filter((c) => c.status === "pending").length }, { key: "documents", label: "Documents", count: docs.length },
        ...(d.isBorrower && (d.policy.params.allowRestructuring || d.restructures.length) ? [{ key: "restructure", label: "Restructuring" }] : []),
      ]} />

      {tab === "schedule" && <Card><ScheduleTable d={d} /></Card>}
      {tab === "payments" && <Card title="Confirmed and pending transactions" description="Only confirmed transactions change your balance."><TransactionsTable d={d} showInternal={false} base={`/loans/${id}`} page={page} size={size} /></Card>}
      {tab === "report" && (
        <div className="grid gap-6 lg:grid-cols-2">
          {d.isBorrower && serviceable ? (
            <Card title="Report a repayment" description="Your balance updates once the Bursary confirms it.">
              <ActionForm action={submitClaimAction.bind(null, id)} submitLabel="Submit for confirmation" resetOnSuccess encType="multipart/form-data">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><label htmlFor="deductionMonth" className="label">Repayment month</label><input id="deductionMonth" name="deductionMonth" type="month" required max={todayLagos().slice(0, 7)} defaultValue={todayLagos().slice(0, 7)} className="input" /></div>
                  <div><label htmlFor="amount" className="label">Amount (₦)</label><p className="hint">Your instalment is ₦{Number(loan.monthlyInstalment).toLocaleString("en-GB", { minimumFractionDigits: 2 })}.</p><input id="amount" name="amount" inputMode="decimal" required defaultValue={loan.monthlyInstalment} className="input" /></div>
                  <div><label htmlFor="channel" className="label">Payment method</label><select id="channel" name="channel" className="input"><option value="payroll">Salary deduction (payroll)</option><option value="bank_transfer">Bank transfer to the University</option></select></div>
                  <div><label htmlFor="payerReference" className="label">Payslip number or transfer reference</label><input id="payerReference" name="payerReference" className="input" /></div>
                  <div className="sm:col-span-2"><label htmlFor="evidence" className="label">Payslip or receipt (optional)</label><input id="evidence" name="evidence" type="file" accept=".pdf,.png,.jpg,.jpeg" className="input py-1.5" /></div>
                  <div className="sm:col-span-2"><label htmlFor="note" className="label">Note</label><input id="note" name="note" className="input" /></div>
                </div>
              </ActionForm>
            </Card>
          ) : <Card><p className="text-sm text-muted">Reporting is available to the borrower while the loan is active.</p></Card>}
          <Card title="Your repayment reports"><ClaimsTable d={d} /></Card>
        </div>
      )}
      {tab === "documents" && <Card title="Agreements, advices and evidence"><DocumentList docs={docs} /></Card>}
      {tab === "restructure" && d.isBorrower && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Request restructuring" description={d.policy.params.allowRestructuring ? `Spread the balance over up to ${monthsText(d.policy.params.maxRestructuredTenorMonths)}.` : "This product does not allow restructuring."}>
            {pendingRestructure ? <Alert tone="info" title="Request pending">You asked for {monthsText(pendingRestructure.proposedTenorMonths)}. The Bursary will respond.</Alert>
              : serviceable && d.policy.params.allowRestructuring ? (
                <ActionForm action={requestRestructureAction.bind(null, id)} submitLabel="Send request">
                  <label htmlFor="proposedTenorMonths" className="label">Remaining tenor (months)</label>
                  <input id="proposedTenorMonths" name="proposedTenorMonths" type="number" min={1} max={d.policy.params.maxRestructuredTenorMonths} required className="input" />
                  <label htmlFor="reason" className="label mt-3">Reason</label>
                  <textarea id="reason" name="reason" rows={3} minLength={10} required className="input" />
                </ActionForm>
              ) : <p className="text-sm text-muted">Not available for this loan.</p>}
          </Card>
          <Card title="Previous requests">
            {d.restructures.length === 0 ? <p className="text-sm text-muted">None.</p> : (
              <ul className="space-y-2 text-sm">{d.restructures.map((r) => <li key={r.id}><Badge>{monthsText(r.proposedTenorMonths)}</Badge> <StatusBadge status={r.status} /> <span className="text-xs text-muted">{r.reviewComment}</span></li>)}</ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
