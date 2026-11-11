import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { earlyRepaymentAccount, earlyRepaymentQuote, getEarlyRepayment } from "@/server/services/loans";
import { confirmEarlyRepaymentAction, declineEarlyRepaymentAction } from "@/app/actions/payroll";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, DateText, KeyValues, Money, PageHeader, StatusBadge } from "@/components/ui";

export const metadata = { title: "Early repayment" };

export default async function EarlyRepayment({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("payroll.view");
  const { id } = await params;
  const db = await getDb();
  const e = await getEarlyRepayment(db, actor, id).catch(() => null);
  if (!e) notFound();
  const { r, loan } = e;
  const pending = r.status === "pending";
  // The figure today, to show whether the balance has moved since the borrower's quote.
  const now = pending && ["active", "overdue", "defaulted"].includes(loan.status) ? await earlyRepaymentQuote(db, loan.id, r.quoteDate) : null;
  const changed = now && now.settlementAmount !== r.amount;
  const account = await earlyRepaymentAccount(db);
  const own = loan.borrowerId === actor.userId;
  const canConfirm = pending && can(actor, "settlement.confirm") && !own;

  return (
    <>
      <PageHeader title={`Early repayment on ${loan.accountNumber}`} crumbs={[{ label: "Payroll", href: "/payroll" }, { label: "Early repayments", href: "/payroll/early-repayments" }, { label: loan.accountNumber }]}
        description={`${e.borrower} paid off the whole balance by transfer.`} actions={<StatusBadge status={r.status === "rejected" ? "declined" : r.status} />} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Payment">
          <KeyValues columns={2} items={[
            ["Amount paid", <Money key="a" value={r.amount} className="font-semibold" />], ["Quoted on", <DateText key="q" value={r.quoteDate} />],
            ["Principal", <Money key="p" value={r.principal} />], ["Interest to date", <Money key="i" value={r.interest} />],
            ["Interest saved", <Money key="s" value={r.interestSaved} />], ["Transfer reference", r.payerReference ?? "-"],
            ["Paid into", account.ready ? `${account.bankName}, ${account.accountNumber}` : "-"], ["Sent", <DateText key="c" value={r.createdAt} withTime />],
          ]} />
          <a href={`/api/documents/${r.receiptDocumentId}`} className="btn-secondary mt-4"><Download aria-hidden className="h-4 w-4" /> Receipt</a>
        </Card>
        <Card title="Loan">
          <KeyValues columns={2} items={[
            ["Borrower", e.borrower], ["Email", e.email], ["Loan", can(actor, "accounts.view") ? <Link key="l" className="link" href={`/accounts/loans/${loan.id}`}>{loan.accountNumber}</Link> : loan.accountNumber],
            ["Status", <StatusBadge key="s" status={loan.status} />], ["Principal lent", <Money key="pl" value={loan.principal} />], ["Instalment", <Money key="in" value={loan.monthlyInstalment} />],
          ]} />
        </Card>
      </div>

      {!pending && (
        <Card className="mt-6" title={r.status === "confirmed" ? "Confirmed" : "Declined"}>
          <p className="text-sm">{r.status === "confirmed" ? "Marked repaid in full" : "Declined"} by {e.reviewer ?? "-"} on <DateText value={r.reviewedAt} withTime />.{r.reviewComment ? ` ${r.reviewComment}` : ""}</p>
        </Card>
      )}
      {pending && own && <div className="mt-6"><Alert tone="warning" title="Your own loan">Another Payroll Manager must confirm this repayment.</Alert></div>}
      {changed && <div className="mt-6"><Alert tone="warning" title="The balance has changed">The amount due is now <Money value={now!.settlementAmount} />, not the <Money value={r.amount} /> quoted. Decline this request and ask the borrower to start again.</Alert></div>}
      {canConfirm && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card title="Mark the loan repaid" description="Check that the full amount has arrived in the account. The loan closes at once and no further deductions are made.">
            <ActionForm action={confirmEarlyRepaymentAction.bind(null, id)} submitLabel="Mark repaid in full" confirm={"Mark this loan repaid in full? This cannot be undone."}>
              <label htmlFor="code" className="label">Two-step verification code</label>
              <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required placeholder="123456" className="input max-w-48 text-center tracking-[0.3em]" />
              <p className="hint">Enter the current six-digit code from your authenticator app to confirm.</p>
            </ActionForm>
          </Card>
          <Card title="Decline" description="If the money has not arrived or the amount is wrong.">
            <ActionForm action={declineEarlyRepaymentAction.bind(null, id)} submitLabel="Decline">
              <label htmlFor="reason" className="label">Reason</label>
              <textarea id="reason" name="reason" rows={3} required minLength={5} className="input" />
            </ActionForm>
          </Card>
        </div>
      )}
    </>
  );
}
