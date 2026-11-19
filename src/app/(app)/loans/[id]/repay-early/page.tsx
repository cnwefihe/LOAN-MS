import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { earlyRepayments } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { getLoanDetail, earlyRepaymentQuote, earlyRepaymentAccount } from "@/server/services/loans";
import { requestEarlyRepaymentAction } from "@/app/actions/payroll";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, DateText, KeyValues, Money, PageHeader } from "@/components/ui";

export const metadata = { title: "Repay early" };

/**
 * Repaying the whole balance early: the amount today (principal plus interest on the reducing balance
 * up to now), the University's account to pay into, and the receipt to send. Part payments are not
 * taken here; they come only from salary.
 */
export default async function RepayEarly({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("repayment.claim");
  const { id } = await params;
  const db = await getDb();
  const d = await getLoanDetail(db, actor, id).catch(() => null);
  if (!d || !d.isBorrower) notFound();
  const { loan } = d;
  const crumbs = [{ label: "My loans", href: "/loans" }, { label: loan.accountNumber, href: `/loans/${id}` }, { label: "Repay early" }];
  const [pending] = await db.select().from(earlyRepayments).where(and(eq(earlyRepayments.loanAccountId, id), eq(earlyRepayments.status, "pending")));
  const serviceable = ["active", "overdue", "defaulted"].includes(loan.status);

  if (pending || !serviceable || d.app.advanceType) {
    return (
      <>
        <PageHeader title="Repay early" crumbs={crumbs} />
        <Card>
          <p className="text-sm text-muted">{pending ? <>You sent <Money value={pending.amount} /> on <DateText value={pending.createdAt} />. The Payroll Officer will check the payment and close the loan.</>
            : d.app.advanceType ? "An advance is recovered from the payment it was taken against, so it cannot be repaid early."
            : "Only an active loan can be repaid early."}</p>
          <Link href={`/loans/${id}`} className="btn-secondary mt-4">Back to the loan</Link>
        </Card>
      </>
    );
  }

  const q = await earlyRepaymentQuote(db, id);
  const account = await earlyRepaymentAccount(db, id);
  return (
    <>
      <PageHeader title="Repay early" crumbs={crumbs} description="Repay the whole balance now. Part payments are taken only from your salary." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Amount to pay today" description={<>Valid for payment today, <DateText value={q.asOf} />.</>}>
          <p className="text-3xl font-semibold text-navy"><Money value={q.settlementAmount} /></p>
          <dl className="mt-4 divide-y divide-line text-sm">
            <div className="flex justify-between py-2"><dt className="text-muted">Loan principal</dt><dd><Money value={q.loanPrincipal} /></dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted">Plus interest to date</dt><dd><Money value={q.interestToDate ?? "0"} /></dd></div>
            <div className="flex justify-between py-2"><dt className="text-muted">Less total repayments</dt><dd>- <Money value={q.totalRepaid} /></dd></div>
            <div className="flex justify-between py-2 font-semibold"><dt>Loan balance to repay</dt><dd><Money value={q.settlementAmount} /></dd></div>
          </dl>
          <p className="hint mt-4">Interest to date is on the reducing balance: the interest of every instalment already due, plus this month&apos;s interest for the days up to today. Interest for the remaining months is not charged, which saves you <Money value={q.interestSaved} />.</p>
        </Card>
        <Card title="1. Pay into this account">
          {account.ready ? (
            <KeyValues columns={1} items={[["Bank", account.bankName], ["Account name", account.accountName], ["Account number", <span key="n" className="font-mono text-base font-semibold">{account.accountNumber}</span>]]} />
          ) : <Alert tone="warning" title="Account not set up yet">The account for early repayments has not been added yet. Please contact the Bursary.</Alert>}
          <p className="hint mt-4">Use {loan.accountNumber} as the payment description.</p>
        </Card>
      </div>
      {account.ready && (
        <Card title="2. Send your receipt" className="mt-6" description="Payroll checks the payment and closes the loan. Deductions then stop.">
          <ActionForm action={requestEarlyRepaymentAction.bind(null, id)} submitLabel="Send for confirmation" encType="multipart/form-data"
            confirm={"Send your receipt for the early repayment? Make sure you paid the full amount shown."}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label htmlFor="receipt" className="label">Payment receipt</label><input id="receipt" name="receipt" type="file" required accept=".pdf,.png,.jpg,.jpeg" className="input py-1.5" /></div>
              <div><label htmlFor="payerReference" className="label">Transfer reference (optional)</label><input id="payerReference" name="payerReference" maxLength={100} className="input" /></div>
            </div>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
