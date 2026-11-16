import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getLoanDetail } from "@/server/services/loans";
import { accountBalances } from "@/server/services/ledger";
import { listDocumentsFor } from "@/server/services/documents";
import { can } from "@/server/actor";
import { dec, m } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { randomToken } from "@/lib/security/crypto";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, PageHeader, StatusBadge, Tabs, Money, Table, Th, Td, KeyValues, DateText, Badge } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { DocumentList } from "@/components/panels";
import { LoanSummary, ScheduleTable, ClaimsTable } from "@/components/loan-panels";
import { recordRepaymentAction, waiverAction, refundAction, reversalAction, decideRestructureAction, callGuarantorsAction, writeOffAction } from "@/app/actions/accounts";
import { uploadStaffDocumentAction } from "@/app/actions/staff-ops";
import { loanGuarantorIds } from "@/server/services/ledger";
import { users } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Loan account" };

const REVERSIBLE = ["repayment", "early_settlement", "adjustment", "refund", "write_off"];

export default async function AccountsLoan({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("accounts.view");
  const { id } = await params;
  const { tab = "overview", page, size } = await searchParams;
  const db = await getDb();
  const d = await getLoanDetail(db, actor, id).catch(() => null);
  if (!d) notFound();
  const { loan } = d;
  const serviceable = ["active", "overdue", "defaulted"].includes(loan.status);
  const own = loan.borrowerId === actor.userId;
  const bal = await accountBalances(db, id);
  const docs = await listDocumentsFor(db, actor, { loanAccountId: id, applicationId: loan.applicationId });
  const reversedIds = new Set(d.txns.filter((t) => t.t.reversesTransactionId && t.t.status !== "rejected").map((t) => t.t.reversesTransactionId));
  const pendingRestructure = d.restructures.find((r) => r.status === "pending");
  const gIds = await loanGuarantorIds(db, loan.applicationId);
  const guarantors = gIds.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, gIds)) : [];
  const ACCOUNTS = ["loan_principal", "interest_receivable", "unearned_interest", "cash_bank", "overpayment_liability", "adjustments"] as const;
  const trial = ACCOUNTS.map((a) => {
    const rows = d.entries.filter((e) => e.account === a);
    const dr = rows.filter((e) => e.direction === "debit").reduce((s, e) => s.plus(e.amount), dec(0));
    const cr = rows.filter((e) => e.direction === "credit").reduce((s, e) => s.plus(e.amount), dec(0));
    return { a, dr, cr };
  });

  return (
    <>
      <PageHeader title={`Loan ${loan.accountNumber}`} crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Loan accounts", href: "/accounts/loans" }, { label: loan.accountNumber }]}
        description={<>{d.borrower.displayName} ({d.borrower.email}) · {d.product.name} · application <Link className="link" href={`/hr/applications/${loan.applicationId}`}>{d.app.reference}</Link></>}
        actions={<><StatusBadge status={loan.status} />{loan.disbursedAt && <a href={`/api/loans/${id}/statement`} className="btn-secondary"><Download aria-hidden className="h-4 w-4" /> Statement</a>}{loan.status === "closed" && <a href={`/api/loans/${id}/clearance`} className="btn-secondary"><Download aria-hidden className="h-4 w-4" /> Clearance letter</a>}</>} />
      {own && <div className="mb-6"><Alert tone="warning" title="This is your own loan">All financial operations on it are blocked for you.</Alert></div>}
      {pendingRestructure && <div className="mb-6"><Alert tone="info" title={`Restructuring requested: ${monthsText(pendingRestructure.proposedTenorMonths)}`}>{pendingRestructure.reason}</Alert></div>}

      <Card title="Summary" className="mb-6"><LoanSummary d={d} showPolicy /></Card>

      <Tabs base={`/accounts/loans/${id}`} active={tab} tabs={[
        { key: "overview", label: "Operations" }, { key: "schedule", label: "Schedule" }, { key: "transactions", label: "Transactions", count: d.txns.length },
        { key: "ledger", label: "Ledger", count: d.entries.length }, { key: "claims", label: "Claims", count: d.claims.length }, { key: "restructure", label: "Restructuring", count: d.restructures.length }, { key: "documents", label: "Documents", count: docs.length },
      ]} />

      {tab === "overview" && (
        serviceable && !own ? (
          <div className="grid gap-6 lg:grid-cols-2">
            {can(actor, "repayment.confirm") && (
              <Card title="Record repayment" description="Payroll or bank receipt, verified against source records.">
                <ActionForm action={recordRepaymentAction.bind(null, id, randomToken(16))} submitLabel="Record repayment" resetOnSuccess>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><label className="label" htmlFor="ramt">Amount (₦)</label><input id="ramt" name="amount" defaultValue={loan.monthlyInstalment} required className="input" /></div>
                    <div><label className="label" htmlFor="rvd">Value date</label><input id="rvd" name="valueDate" type="date" max={todayLagos()} defaultValue={todayLagos()} required className="input" /></div>
                    <div><label className="label" htmlFor="rref">Reference</label><input id="rref" name="reference" required className="input" /></div>
                    <div><label className="label" htmlFor="rch">Channel</label><select id="rch" name="channel" className="input"><option value="payroll">Payroll deduction</option><option value="bank_transfer">Bank transfer</option></select></div>
                    {loan.status === "defaulted" && guarantors.length > 0 && (
                      <div className="sm:col-span-2"><label className="label" htmlFor="rpayer">Paid by</label><select id="rpayer" name="guarantorId" className="input"><option value="">Borrower</option>{guarantors.map((g) => <option key={g.id} value={g.id}>Guarantor: {g.name}</option>)}</select></div>
                    )}
                  </div>
                </ActionForm>
              </Card>
            )}
            {can(actor, "transaction.adjust") && (
              <Card title="Waiver / write-down" description="Reduces the balance. Requires documented authority.">
                <ActionForm action={waiverAction.bind(null, id)} submitLabel="Propose adjustment" variant="secondary">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><label className="label" htmlFor="wc">Component</label><select id="wc" name="component" className="input"><option value="interest">Interest</option><option value="principal">Principal</option></select></div>
                    <div><label className="label" htmlFor="wa">Amount (₦)</label><input id="wa" name="amount" required className="input" /></div>
                    <div className="sm:col-span-2"><label className="label" htmlFor="wr">Reason and approving authority</label><input id="wr" name="reason" required minLength={10} className="input" /></div>
                  </div>
                </ActionForm>
              </Card>
            )}
            {can(actor, "transaction.adjust") && bal.overpayment.greaterThan(0) && (
              <Card title="Refund overpayment" description={<>Overpayment held: <Money value={m(bal.overpayment)} /></>}>
                <ActionForm action={refundAction.bind(null, id)} submitLabel="Propose refund" variant="secondary">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><label className="label" htmlFor="fa">Amount (₦)</label><input id="fa" name="amount" defaultValue={m(bal.overpayment)} required className="input" /></div>
                    <div><label className="label" htmlFor="fr">Payment reference</label><input id="fr" name="reference" required className="input" /></div>
                  </div>
                </ActionForm>
              </Card>
            )}
            {can(actor, "transaction.adjust") && loan.status === "defaulted" && (
              <Card title="Default management" description={`${loan.daysPastDue} days past due. Call on guarantors, record recoveries or write off.`} className="border-red-200 lg:col-span-2">
                <div className="grid gap-6 lg:grid-cols-2">
                  <ActionForm action={callGuarantorsAction.bind(null, id)} submitLabel="Call on guarantors" variant="secondary" confirm="Formally notify all guarantors of their obligation?">
                    <p className="text-sm">{guarantors.length ? `Notifies ${guarantors.map((g) => g.name).join(", ")} of their pro-rata share of the outstanding balance.` : "This loan has no accepted guarantors."}</p>
                    <label className="label mt-2" htmlFor="gcc">Message to guarantors (optional)</label><input id="gcc" name="comment" className="input" />
                  </ActionForm>
                  <ActionForm action={writeOffAction.bind(null, id)} submitLabel="Propose write-off" variant="danger" confirm="Propose writing off the balance? It needs checker approval and can be reversed.">
                    <p className="text-sm">Writes off <Money value={m(bal.principal.plus(bal.interest))} className="font-semibold" /> to the adjustments account. The debt is not extinguished.</p>
                    <label className="label mt-2" htmlFor="wor">Reason and approving authority</label><input id="wor" name="reason" required minLength={15} className="input" />
                  </ActionForm>
                </div>
              </Card>
            )}
          </div>
        ) : (
          <Card>
            {loan.status === "written_off" && <div className="mb-3"><Alert tone="danger" title="Written off">To reinstate the loan, reverse the write-off under Transactions.</Alert></div>}
            {loan.status === "pending_disbursement" ? <p className="text-sm">Awaiting disbursement. <Link className="link" href="/accounts/disbursements">Go to disbursements</Link>.</p>
              : loan.status === "closed" && bal.overpayment.greaterThan(0) && can(actor, "transaction.adjust") && !own ? (
                <ActionForm action={refundAction.bind(null, id)} submitLabel="Propose refund of overpayment" variant="secondary">
                  <p className="text-sm">Loan closed with an overpayment of <Money value={m(bal.overpayment)} />.</p>
                  <input type="hidden" name="amount" value={m(bal.overpayment)} />
                  <label className="label mt-2" htmlFor="cr">Payment reference</label><input id="cr" name="reference" required className="input max-w-xs" />
                </ActionForm>
              ) : <p className="text-sm text-muted">No operations available in status “{loan.status.replace("_", " ")}”.</p>}
          </Card>
        )
      )}

      {tab === "schedule" && <Card><ScheduleTable d={d} /></Card>}

      {tab === "transactions" && (
        <Card bodyClassName="p-5 pt-0">
          <Table caption="Transactions">
            <thead><tr><Th>Value date</Th><Th>Reference</Th><Th>Type</Th><Th right>Amount</Th><Th>Status</Th><Th>Narration</Th><Th>Maker / checker</Th><Th /></tr></thead>
            <tbody>
              {paginate(d.txns, page, size).items.map(({ t, makerName }) => (
                <tr key={t.id}>
                  <Td><DateText value={t.valueDate} /></Td>
                  <Td className="font-mono text-xs">{t.reference}{t.externalReference && <p className="text-muted">{t.externalReference}</p>}</Td>
                  <Td className="capitalize">{t.type.replace(/_/g, " ")}{reversedIds.has(t.id) && <> <Badge tone="warning">reversed</Badge></>}</Td>
                  <Td right><Money value={t.amount} /></Td>
                  <Td><StatusBadge status={t.status} txn /></Td>
                  <Td className="min-w-56 max-w-xs text-xs !whitespace-normal">{t.narration}{t.rejectionReason && <p className="text-danger">{t.rejectionReason}</p>}{t.status === "posted" && (t.type === "repayment" || t.type === "early_settlement") && <p><a className="link" href={`/api/transactions/${t.id}/receipt`}>Receipt PDF</a></p>}</Td>
                  <Td className="text-xs">{makerName}{t.checkerId && " ✓ checked"}</Td>
                  <Td>
                    {t.status === "posted" && REVERSIBLE.includes(t.type) && !reversedIds.has(t.id) && can(actor, "transaction.reverse") && !own && (
                      <details><summary className="cursor-pointer text-xs font-medium text-brand">Reverse</summary>
                        <ActionForm action={reversalAction.bind(null, t.id)} submitLabel="Propose reversal" variant="danger" confirm={`Reverse ${t.reference}?`}>
                          <label className="sr-only" htmlFor={`rv-${t.id}`}>Reason</label><input id={`rv-${t.id}`} name="reason" required minLength={5} placeholder="Reason" className="input mt-2 min-w-48" />
                        </ActionForm>
                      </details>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination data={paginate(d.txns, page, size)} base={`/accounts/loans/${id}`} params={{ tab }} label="transactions" />
        </Card>
      )}

      {tab === "ledger" && (
        <div className="grid gap-6 xl:grid-cols-3">
          <Card title="Account balances" description="Derived from posted ledger entries only.">
            <Table caption="Trial balance">
              <thead><tr><Th>Account</Th><Th right>Debit</Th><Th right>Credit</Th></tr></thead>
              <tbody>
                {trial.map((t) => <tr key={t.a}><Td className="font-mono text-xs">{t.a}</Td><Td right><Money value={m(t.dr)} /></Td><Td right><Money value={m(t.cr)} /></Td></tr>)}
                <tr className="font-semibold"><Td>Total</Td><Td right><Money value={m(trial.reduce((s, t) => s.plus(t.dr), dec(0)))} /></Td><Td right><Money value={m(trial.reduce((s, t) => s.plus(t.cr), dec(0)))} /></Td></tr>
              </tbody>
            </Table>
          </Card>
          <Card title="Ledger entries" className="xl:col-span-2" bodyClassName="p-5 pt-0">
            <Table caption="Ledger entries">
              <thead><tr><Th>#</Th><Th>Transaction</Th><Th>Account</Th><Th right>Debit</Th><Th right>Credit</Th><Th>Posted</Th></tr></thead>
              <tbody>{paginate(d.entries, page, size).items.map((e) => {
                const t = d.txns.find((x) => x.t.id === e.transactionId)?.t;
                return <tr key={e.id}><Td className="text-xs">{e.id}</Td><Td className="font-mono text-xs">{t?.reference}</Td><Td className="font-mono text-xs">{e.account}</Td><Td right>{e.direction === "debit" ? <Money value={e.amount} /> : ""}</Td><Td right>{e.direction === "credit" ? <Money value={e.amount} /> : ""}</Td><Td><DateText value={e.createdAt} withTime /></Td></tr>;
              })}</tbody>
            </Table>
            <Pagination data={paginate(d.entries, page, size)} base={`/accounts/loans/${id}`} params={{ tab }} label="entries" />
          </Card>
        </div>
      )}

      {tab === "claims" && <Card title="Staff-reported deductions"><ClaimsTable d={d} /></Card>}

      {tab === "restructure" && (
        <Card title="Restructuring requests">
          {d.restructures.length === 0 ? <p className="text-sm text-muted">No requests.</p> : (
            <ul className="space-y-4">{d.restructures.map((r) => (
              <li key={r.id} className="rounded-md border border-line p-4">
                <p className="text-sm"><Badge>{monthsText(r.proposedTenorMonths)}</Badge> <StatusBadge status={r.status} /> <span className="text-xs text-muted"><DateText value={r.createdAt} withTime /></span></p>
                <p className="mt-1 text-sm">{r.reason}</p>
                {r.reviewComment && <p className="mt-1 text-xs text-muted">Review: {r.reviewComment}</p>}
                {r.status === "pending" && can(actor, "restructure.approve") && !own && (
                  <ActionForm action={decideRestructureAction.bind(null, r.id)} submitLabel="Record decision" confirm="Record this restructuring decision?">
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div><label className="label" htmlFor={`rd-${r.id}`}>Decision</label><select id={`rd-${r.id}`} name="decision" className="input"><option value="approve">Approve with a new schedule</option><option value="reject">Decline</option></select></div>
                      <div className="sm:col-span-2"><label className="label" htmlFor={`rc-${r.id}`}>Comment</label><input id={`rc-${r.id}`} name="comment" required className="input" /></div>
                    </div>
                  </ActionForm>
                )}
              </li>
            ))}</ul>
          )}
        </Card>
      )}

      {tab === "documents" && (
        <Card title="Documents">
          <DocumentList docs={docs} />
          {can(actor, "accounts.view") && !own && (
            <ActionForm action={uploadStaffDocumentAction.bind(null, "loan", id)} submitLabel="Upload document" variant="secondary" resetOnSuccess encType="multipart/form-data">
              <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
                <div><label className="label" htmlFor="dcat">Type</label><select id="dcat" name="category" className="input"><option value="restructuring">Restructuring document</option><option value="repayment_evidence">Repayment evidence</option><option value="disbursement_evidence">Disbursement evidence</option><option value="statement">Statement / confirmation</option></select></div>
                <div><label className="label" htmlFor="dtitle">Title</label><input id="dtitle" name="title" required className="input" /></div>
                <div><label className="label" htmlFor="dfile">File (PDF, PNG, JPEG)</label><input id="dfile" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg" className="input py-1.5" /></div>
              </div>
            </ActionForm>
          )}
        </Card>
      )}
    </>
  );
}
