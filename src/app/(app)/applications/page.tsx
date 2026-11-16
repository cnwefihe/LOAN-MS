import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listMyApplications } from "@/server/services/applications";
import { Card, PageHeader, Table, Th, Td, Money, StatusBadge, DateText, EmptyState, KeyValues } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { paginate, Pagination } from "@/components/pagination";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "My applications" };

const IN_PROGRESS = new Set(["draft", "pending_guarantor", "pending_hr", "pending_bursary", "returned", "pending_approval"]);

export default async function MyApplications({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const actor = await requireActor("application.view_own");
  const rows = await listMyApplications(await getDb(), actor);
  const open = rows.filter((r) => IN_PROGRESS.has(r.app.status));
  const past = rows.filter((r) => !IN_PROGRESS.has(r.app.status));
  const sp = await searchParams;
  const pg = paginate(past, sp.page, sp.size);

  return (
    <>
      <PageHeader title="My applications" description="Track each request from submission to decision."
        crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "My applications" }]}
        actions={rows.length ? <Link href="/applications/new" className="btn-primary">New application</Link> : undefined} />

      {rows.length === 0 && (
        <Card><EmptyState title="No applications yet" action={<Link href="/applications/new" className="btn-primary">Start an application</Link>} /></Card>
      )}

      {open.length > 0 && (
        <section aria-labelledby="in-progress" className="mb-8">
          <h2 id="in-progress" className="mb-3 text-base font-semibold text-ink">In progress</h2>
          <div className="space-y-6">
            {open.map(({ app, productName }) => (
              <Card key={app.id} title={<Link href={`/applications/${app.id}`} className="hover:underline">{app.reference}</Link>} description={productName} actions={<StatusBadge status={app.status} />}>
                <KeyValues columns={3} items={[
                  ["Amount requested", <Money key="a" value={app.requestedAmount} />],
                  ["Tenor", `${monthsText(app.tenorMonths)}`],
                  ["Submitted", app.submittedAt ? <DateText key="s" value={app.submittedAt} /> : "Not yet submitted"],
                ]} />
                <div className="mt-5 rounded-md bg-slate-50 px-4 py-3"><LifecycleTracker applicantId={app.applicantId} appStatus={app.status} level={app.currentApprovalLevel} /></div>
                <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                  <Link href={`/applications/${app.id}`} className="btn-primary">{app.status === "draft" || app.status === "returned" ? "Continue" : "View progress"}</Link>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section aria-labelledby="past-applications">
          <h2 id="past-applications" className="mb-3 text-base font-semibold text-ink">Decided applications</h2>
          <Card bodyClassName="p-5 pt-0">
            <Table caption="Decided applications">
              <thead><tr><Th>Reference</Th><Th>Product</Th><Th right>Amount requested</Th><Th right>Tenor</Th><Th>Outcome</Th><Th>Decided</Th><Th>Loan</Th></tr></thead>
              <tbody>
                {pg.items.map(({ app, productName, loanId, accountNumber }) => (
                  <tr key={app.id} className="hover:bg-slate-50">
                    <Td><Link href={`/applications/${app.id}`} className="link">{app.reference}</Link></Td>
                    <Td>{productName}</Td>
                    <Td right><Money value={app.requestedAmount} /></Td>
                    <Td right>{monthsText(app.tenorMonths)}</Td>
                    <Td><StatusBadge status={app.status} /></Td>
                    <Td><DateText value={app.decidedAt} /></Td>
                    <Td>{loanId ? <Link href={`/loans/${loanId}`} className="link">View loan<span className="sr-only"> {accountNumber}</span></Link> : <span className="text-muted">N/A</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination data={pg} base="/applications" label="applications" />
          </Card>
        </section>
      )}
    </>
  );
}
