import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { listMyGuarantees, guarantorExposure } from "@/server/services/guarantors";
import { Card, PageHeader, Stat, StatGrid, Table, Th, Td, Money, StatusBadge, DateText, EmptyState, Alert } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Guarantor requests" };

export default async function GuarantorDashboard({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const sp = await searchParams;
  const actor = await requireActor("guarantee.view_own");
  const db = await getDb();
  const rows = await listMyGuarantees(db, actor);
  const exp = await guarantorExposure(db, actor.userId);
  const pending = rows.filter((r) => ["pending", "clarification_requested"].includes(r.g.status) && r.app.status === "pending_guarantor");
  const history = rows.filter((r) => !pending.includes(r));
  const pg = paginate(history, sp.page, sp.size);
  return (
    <>
      <PageHeader title="Guarantor requests" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Guarantor" }]}
        description="Requests to guarantee colleagues' loans." />
      <StatGrid>
        <Stat label="Awaiting your response" value={pending.length} tone={pending.length ? "warning" : "default"} />
        <Stat label="Potential liability" value={<Money value={exp.potential} />} hint="Not yet paid out" />
        <Stat label="Current exposure" value={<Money value={exp.actual} />} hint="Share of outstanding balances" tone="brand" />
        <Stat label="Reserved each month" value={<Money value={exp.monthlyCommitment} />} hint="From your borrowing limit" href="/eligibility" />
      </StatGrid>
      <Card title="Pending invitations" className="mb-6">
        {pending.length === 0 ? <EmptyState title="No pending requests" /> : (
          <Table caption="Pending guarantor invitations">
            <thead><tr><Th>Applicant</Th><Th>Application</Th><Th right>Loan amount</Th><Th right>Your obligation</Th><Th>Invited</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {pending.map(({ g, app, applicantName, productName }) => (
                <tr key={g.id}>
                  <Td className="font-medium">{applicantName}</Td>
                  <Td>{app.reference}<p className="text-xs text-muted">{productName} · {monthsText(app.tenorMonths)}</p></Td>
                  <Td right><Money value={app.requestedAmount} /></Td>
                  <Td right><Money value={g.guaranteedAmount} /></Td>
                  <Td><DateText value={g.invitedAt} /></Td>
                  <Td><StatusBadge status={g.status} /></Td>
                  <Td><Link href={`/guarantor/requests/${g.id}`} className="btn-primary h-8 px-3 text-xs">Review<span className="sr-only"> request from {applicantName}</span></Link></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Existing guarantees and history">
        {exp.items.length > 0 && <div className="mb-4"><Alert tone="info">Your share is reserved from your borrowing limit until the loan is closed. <Link className="link" href="/eligibility">See what you may still borrow</Link>.</Alert></div>}
        {history.length === 0 ? <p className="text-sm text-muted">No history yet.</p> : (
          <Table caption="Guarantee history">
            <thead><tr><Th>Applicant</Th><Th>Application</Th><Th right>Guaranteed</Th><Th right>Current exposure</Th><Th right>Reserved each month</Th><Th>Your response</Th><Th>Application</Th></tr></thead>
            <tbody>
              {pg.items.map(({ g, app, applicantName }) => {
                const e = exp.items.find((i) => i.guaranteeId === g.id);
                return (
                  <tr key={g.id}>
                    <Td>{applicantName}</Td>
                    <Td><Link className="link" href={`/guarantor/requests/${g.id}`}>{app.reference}</Link></Td>
                    <Td right><Money value={g.guaranteedAmount} /></Td>
                    <Td right>{e ? <Money value={e.currentExposure} /> : "N/A"}</Td>
                    <Td right>{e ? <Money value={e.monthlyCommitment} /> : "N/A"}</Td>
                    <Td><StatusBadge status={g.status} /></Td>
                    <Td><StatusBadge status={e?.loanStatus ?? app.status} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/guarantor" label="guarantees" />
      </Card>
    </>
  );
}
