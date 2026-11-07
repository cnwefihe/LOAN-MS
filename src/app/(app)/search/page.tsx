import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { searchRecords } from "@/server/services/search";
import { Card, PageHeader, StatusBadge, Money, EmptyState } from "@/components/ui";

export const metadata = { title: "Search" };

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const actor = await requireActor();
  const { q, staff, apps, loans, people } = await searchRecords(await getDb(), actor, (await searchParams).q ?? "");

  return (
    <>
      <PageHeader title={q ? `Results for “${q}”` : "Search"} description={staff ? "Searching all records you are authorised to see." : "Searching your own applications and loans."} />
      {!q ? <EmptyState title="Type a reference, account number or name in the search bar" /> : (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title={`Applications (${apps.length})`}>
            <ul className="space-y-2 text-sm">{apps.map(({ app, name, href }) => <li key={app.id} className="flex justify-between gap-2"><Link className="link" href={href}>{app.reference}</Link><span className="truncate text-muted">{name}</span><StatusBadge status={app.status} /></li>)}</ul>
            {!apps.length && <p className="text-sm text-muted">No matches.</p>}
          </Card>
          <Card title={`Loans (${loans.length})`}>
            <ul className="space-y-2 text-sm">{loans.map(({ loan, name, href }) => <li key={loan.id} className="flex justify-between gap-2"><Link className="link" href={href}>{loan.accountNumber}</Link><span className="truncate text-muted">{name}</span><Money value={loan.principal} /></li>)}</ul>
            {!loans.length && <p className="text-sm text-muted">No matches.</p>}
          </Card>
          {can(actor, "hr.staff.view") && (
            <Card title={`Staff (${people.length})`}>
              <ul className="space-y-2 text-sm">{people.map(({ u, staffNumber, href }) => <li key={u.id}><Link className="link" href={href}>{u.displayName}</Link> <span className="text-muted">{staffNumber ?? u.email}</span></li>)}</ul>
              {!people.length && <p className="text-sm text-muted">No matches.</p>}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
