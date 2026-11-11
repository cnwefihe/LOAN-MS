import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanAccounts, disbursements, users, staffProfiles } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { todayLagos } from "@/lib/finance/dates";
import { randomToken } from "@/lib/security/crypto";
import { ActionForm } from "@/components/action-form";
import { FundPoolCard } from "@/components/fund-pool";
import { fundPosition } from "@/server/services/funds";
import { Alert, Card, PageHeader, Money, DateText, StatusBadge, EmptyState, Table, Th, Td, Badge } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { recordDisbursementAction } from "@/app/actions/accounts";

export const metadata = { title: "Disbursements" };

export default async function Disbursements({ searchParams }: { searchParams: Promise<{ page?: string; size?: string; awaitingPage?: string; awaitingPageSize?: string }> }) {
  const sp = await searchParams;
  const actor = await requireActor("accounts.view");
  const db = await getDb();
  const awaiting = await db.select({ loan: loanAccounts, borrower: users.displayName, profile: staffProfiles }).from(loanAccounts)
    .innerJoin(users, eq(users.id, loanAccounts.borrowerId)).leftJoin(staffProfiles, eq(staffProfiles.userId, loanAccounts.borrowerId))
    .where(eq(loanAccounts.status, "pending_disbursement")).orderBy(loanAccounts.approvedAt);
  const all = await db.select({ d: disbursements, acct: loanAccounts.accountNumber, loanId: loanAccounts.id, maker: users.displayName }).from(disbursements)
    .innerJoin(loanAccounts, eq(loanAccounts.id, disbursements.loanAccountId)).innerJoin(users, eq(users.id, disbursements.recordedBy))
    .orderBy(desc(disbursements.createdAt));
  const waiting = paginate(awaiting, sp.awaitingPage, sp.awaitingPageSize);
  const history = paginate(all, sp.page, sp.size);

  return (
    <>
      <PageHeader title="Disbursements" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Disbursements" }]}
        description="Pay out approved loans. The loan starts when it is paid, and repayments begin the following month." />
      <FundPoolCard pos={await fundPosition(db)} />

      <Card title={`Approved loans awaiting payment (${awaiting.length})`} className="mb-6">
        {awaiting.length === 0 ? <EmptyState title="No approved loans awaiting payment" /> : (
          <ul className="space-y-4">
            {waiting.items.map(({ loan, borrower, profile }) => {
              return (
                <li key={loan.id} className="rounded-md border border-line p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium"><Link className="link" href={`/accounts/loans/${loan.id}`}>{loan.accountNumber}</Link> · {borrower}</p>
                      <p className="text-xs text-muted">Approved <DateText value={loan.approvedAt} /> · amount to pay <Money value={loan.principal} className="font-semibold text-ink" /></p>
                    </div>
                    {profile?.bankAccountLast4 ? <Badge>{profile.bankName} ••••{profile.bankAccountLast4}</Badge> : <Badge tone="danger">No bank details</Badge>}
                  </div>
                  {!profile?.bankAccountLast4 ? <div className="mt-3"><Alert tone="warning">The borrower must add bank details to their profile before the loan can be paid out.</Alert></div>
                    : can(actor, "disbursement.record") && loan.borrowerId !== actor.userId && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium text-brand">Enter payment details</summary>
                        <ActionForm action={recordDisbursementAction.bind(null, loan.id, randomToken(16))} submitLabel="Record payment" encType="multipart/form-data">
                          <div className="mt-3 grid gap-3 sm:grid-cols-3">
                            <div><label className="label" htmlFor={`amt-${loan.id}`}>Amount paid (₦)</label><input id={`amt-${loan.id}`} name="amountDisbursed" defaultValue={loan.principal} inputMode="decimal" required className="input" /></div>
                            <div><label className="label" htmlFor={`pd-${loan.id}`}>Payment date</label><input id={`pd-${loan.id}`} name="paymentDate" type="date" max={todayLagos()} defaultValue={todayLagos()} required className="input" /></div>
                            <div><label className="label" htmlFor={`pm-${loan.id}`}>Method</label><select id={`pm-${loan.id}`} name="paymentMethod" className="input"><option value="bank_transfer">Bank transfer</option><option value="internal_transfer">Internal transfer</option><option value="cheque">Cheque</option></select></div>
                            <div><label className="label" htmlFor={`ref-${loan.id}`}>Bank transaction reference</label><input id={`ref-${loan.id}`} name="transactionReference" required className="input" /></div>
                            <div><label className="label" htmlFor={`ev-${loan.id}`}>Evidence (payment advice)</label><input id={`ev-${loan.id}`} name="evidence" type="file" accept=".pdf,.png,.jpg,.jpeg" className="input py-1.5" /></div>
                            <div><label className="label" htmlFor={`no-${loan.id}`}>Notes</label><input id={`no-${loan.id}`} name="notes" className="input" /></div>
                          </div>
                        </ActionForm>
                      </details>
                    )}
                </li>
              );
            })}
          </ul>
        )}
        <Pagination data={waiting} base="/accounts/disbursements" params={sp} param="awaitingPage" label="loans" />
      </Card>

      <Card title="Disbursement history" bodyClassName="p-5 pt-0">
        <Table caption="Disbursement history">
          <thead><tr><Th>Loan</Th><Th right>Amount</Th><Th>Reference</Th><Th>Paid</Th><Th>Recorded by</Th><Th>Status</Th></tr></thead>
          <tbody>{history.items.map(({ d, acct, loanId, maker }) => (
            <tr key={d.id}><Td><Link className="link" href={`/accounts/loans/${loanId}`}>{acct}</Link></Td><Td right><Money value={d.amountDisbursed} /></Td><Td className="font-mono text-xs">{d.transactionReference}</Td><Td><DateText value={d.paymentDate} /></Td><Td>{maker}</Td><Td><StatusBadge status={d.status} />{d.rejectionReason && <p className="text-xs text-muted">{d.rejectionReason}</p>}</Td></tr>
          ))}</tbody>
        </Table>
        <Pagination data={history} base="/accounts/disbursements" params={sp} label="disbursements" />
      </Card>
    </>
  );
}
