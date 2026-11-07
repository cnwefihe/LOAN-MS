import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { loanBook } from "@/server/services/reports";
import { dec, sum } from "@/lib/finance/money";
import { Card, PageHeader, Money, DateText, StatusBadge, Table, Th, Td, Badge } from "@/components/ui";
import { SearchFilter } from "@/components/search-filter";

import { paginate, Pagination } from "@/components/pagination";
export const metadata = { title: "Loan accounts" };

const STATUSES = ["", "pending_disbursement", "active", "overdue", "defaulted", "closed"];
const label = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "All");

export default async function LoanBook({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("accounts.view");
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status ?? "") ? sp.status : "";
  const rows = await loanBook(await getDb(), actor, status || undefined);
  const q = sp.q?.toLowerCase();
  const filtered = q ? rows.filter((r) => `${r.accountNumber} ${r.borrower} ${r.staffNumber ?? ""}`.toLowerCase().includes(q)) : rows;
  const pg = paginate(filtered, sp.page, sp.size);
  const outstanding = sum(filtered.map((r) => dec(r.principalOutstanding).plus(r.interestOutstanding)));

  return (
    <>
      <PageHeader title="Loan accounts" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Loan accounts" }]} description={<>{filtered.length} loan(s) · outstanding <Money value={outstanding.toFixed(2)} /></>} />
      <Card bodyClassName="p-5">
        <SearchFilter q={sp.q} placeholder="Search account, borrower or staff number" filter={{ name: "status", value: status, options: STATUSES.map((s) => ({ value: s, label: label(s) })) }} />
        <Table caption="Loan book">
          <thead><tr><Th>Account</Th><Th>Borrower</Th><Th>Product</Th><Th right>Principal</Th><Th right>Repaid</Th><Th right>Outstanding</Th><Th right>DPD</Th><Th>Status</Th><Th>Maturity</Th></tr></thead>
          <tbody>
            {pg.items.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td><Link className="link" href={`/accounts/loans/${r.id}`}>{r.accountNumber}</Link></Td>
                <Td>{r.borrower}<p className="text-xs text-muted">{r.staffNumber ?? ""}</p></Td>
                <Td>{r.product}</Td>
                <Td right><Money value={r.principal} /></Td>
                <Td right><Money value={r.totalRepaid} /></Td>
                <Td right><Money value={dec(r.principalOutstanding).plus(r.interestOutstanding).toFixed(2)} /></Td>
                <Td right>{r.daysPastDue ? <Badge tone="warning">{r.daysPastDue}</Badge> : 0}</Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td><DateText value={r.maturityDate} /></Td>
              </tr>
            ))}
            {!filtered.length && <tr><Td colSpan={9} className="text-muted">No loans match.</Td></tr>}
          </tbody>
        </Table>
        <Pagination data={pg} base="/accounts/loans" params={{ status: sp.status, q: sp.q }} label="loans" />
      </Card>
    </>
  );
}
