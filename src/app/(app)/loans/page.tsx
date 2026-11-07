import Link from "next/link";
import { Download } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listMyLoans } from "@/server/services/loans";
import { dec, sum } from "@/lib/finance/money";
import { Card, PageHeader, Table, Th, Td, Money, StatusBadge, DateText, EmptyState, Stat, StatGrid, Progress, KeyValues } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "My loans" };

const CURRENT = new Set(["pending_disbursement", "active", "overdue", "defaulted"]);
const LIVE = new Set(["active", "overdue", "defaulted"]);

export default async function MyLoans({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const actor = await requireActor("loan.view_own");
  const rows = await listMyLoans(await getDb(), actor);
  const current = rows.filter((r) => CURRENT.has(r.loan.status));
  const past = rows.filter((r) => !CURRENT.has(r.loan.status));
  const sp = await searchParams;
  const pg = paginate(past, sp.page, sp.size);
  const live = rows.filter((r) => LIVE.has(r.loan.status));
  const owed = (l: (typeof rows)[number]["loan"]) => dec(l.principalOutstanding).plus(l.interestOutstanding);

  return (
    <>
      <PageHeader title="My loans" description="Balances, repayments and statements." crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "My loans" }]} />
      <StatGrid>
        <Stat label="Active loans" value={current.length} tone="brand" />
        <Stat label="Outstanding balance" value={<Money value={sum(live.map((r) => owed(r.loan))).toFixed(2)} />} tone="warning" />
        <Stat label="Monthly instalments" value={<Money value={sum(live.map((r) => r.loan.monthlyInstalment)).toFixed(2)} />} />
        <Stat label="Repaid to date" value={<Money value={sum(rows.map((r) => r.loan.totalRepaid)).toFixed(2)} />} tone="success" />
      </StatGrid>

      {rows.length === 0 && (
        <Card><EmptyState title="No loans yet" description="Your loans will appear here once they have been approved." action={<Link href="/applications" className="btn-secondary">View applications</Link>} /></Card>
      )}

      {current.length > 0 && (
        <section aria-labelledby="current-loans" className="mb-8">
          <h2 id="current-loans" className="mb-3 text-base font-semibold text-ink">Active loans</h2>
          <div className={`grid gap-6 ${current.length > 1 ? "xl:grid-cols-2" : ""}`}>
            {current.map(({ loan, productName }) => {
              const total = dec(loan.totalRepayable);
              const pct = total.greaterThan(0) ? dec(loan.totalRepaid).div(total).times(100).toNumber() : 0;
              return (
                <Card key={loan.id} title={<Link href={`/loans/${loan.id}`} className="hover:underline">{loan.accountNumber}</Link>} description={productName} actions={<StatusBadge status={loan.status} />}>
                  {loan.status === "pending_disbursement" ? (
                    <p className="mb-4 rounded-md bg-brand-50 px-3 py-2 text-sm text-navy">Approved and awaiting payment by the Accounts Payable Officer.</p>
                  ) : (
                    <div className="mb-5"><Progress value={pct} label="Repaid" /></div>
                  )}
                  <KeyValues columns={current.length > 1 ? 3 : 6} items={[
                    ["Amount borrowed", <Money key="p" value={loan.principal} />],
                    ["Monthly instalment", <Money key="m" value={loan.monthlyInstalment} />],
                    ["Outstanding", <Money key="o" value={owed(loan).toFixed(2)} />],
                    ["Repaid", <Money key="r" value={loan.totalRepaid} />],
                    ["Tenor", `${monthsText(loan.tenorMonths)}`],
                    ["Final payment", loan.maturityDate ? <DateText key="f" value={loan.maturityDate} /> : "Set at disbursement"],
                  ]} />
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                    <Link href={`/loans/${loan.id}`} className="btn-primary">View loan</Link>
                    {LIVE.has(loan.status) && <Link href={`/loans/${loan.id}?tab=report`} className="btn-secondary">Report repayment</Link>}
                    {loan.disbursedAt && <a href={`/api/loans/${loan.id}/statement`} className="btn-secondary"><Download aria-hidden className="h-4 w-4" /> Statement</a>}
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section aria-labelledby="loan-history">
          <h2 id="loan-history" className="mb-3 text-base font-semibold text-ink">Loan history</h2>
          <Card bodyClassName="p-5 pt-0">
            <Table caption="Loan history">
              <thead><tr><Th>Reference</Th><Th>Product</Th><Th right>Amount borrowed</Th><Th right>Total repaid</Th><Th>Status</Th><Th>Closed</Th><Th><span className="sr-only">Documents</span></Th></tr></thead>
              <tbody>
                {pg.items.map(({ loan, productName }) => (
                  <tr key={loan.id} className="hover:bg-slate-50">
                    <Td><Link href={`/loans/${loan.id}`} className="link">{loan.accountNumber}</Link></Td>
                    <Td>{productName}</Td>
                    <Td right><Money value={loan.principal} /></Td>
                    <Td right><Money value={loan.totalRepaid} /></Td>
                    <Td><StatusBadge status={loan.status} /></Td>
                    <Td><DateText value={loan.closedAt} /></Td>
                    <Td>{loan.disbursedAt && <a href={`/api/loans/${loan.id}/statement`} className="link inline-flex items-center gap-1 text-xs"><Download aria-hidden className="h-3.5 w-3.5" /> Statement<span className="sr-only"> for {loan.accountNumber}</span></a>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination data={pg} base="/loans" label="loans" />
          </Card>
        </section>
      )}
    </>
  );
}
