import Link from "next/link";
import { sql, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, hrVerifications, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { applicationQueue } from "@/server/services/hr";
import { Card, PageHeader, Stat, StatGrid, StatusBadge, DateText, Table, Th, Td } from "@/components/ui";
import { QueueTable } from "@/components/queue-table";

export const metadata = { title: "Human Resources dashboard" };

export default async function HrDashboard() {
  const actor = await requireActor("hr.queue.view");
  const db = await getDb();
  const [counts] = await db.select({
    pendingHr: sql<number>`count(*) filter (where ${loanApplications.status} = 'pending_hr')`,
    awaitingGuarantors: sql<number>`count(*) filter (where ${loanApplications.status} = 'pending_guarantor')`,
    returned: sql<number>`count(*) filter (where ${loanApplications.status} = 'returned')`,
    forwarded: sql<number>`count(*) filter (where ${loanApplications.status} = 'pending_bursary')`,
  }).from(loanApplications);
  const queue = await applicationQueue(db, actor, { statuses: ["pending_hr"], limit: 5 });
  const recent = await db.select({ v: hrVerifications, officer: users.displayName, ref: loanApplications.reference, appId: loanApplications.id })
    .from(hrVerifications).innerJoin(users, eq(users.id, hrVerifications.officerId)).innerJoin(loanApplications, eq(loanApplications.id, hrVerifications.applicationId))
    .orderBy(sql`${hrVerifications.createdAt} desc`).limit(5);
  return (
    <>
      <PageHeader title="Overview" description="Employment, salary and guarantor checks." actions={<Link href="/hr/applications" className="btn-primary">Open verification queue</Link>} />
      {/* Only the stage Human Resources works on links to its queue; the others are for information. */}
      <StatGrid>
        <Stat label="Awaiting guarantors" value={Number(counts.awaitingGuarantors)} hint="Before Human Resources" />
        <Stat label="Awaiting verification" value={Number(counts.pendingHr)} tone="warning" href="/hr/applications?status=pending_hr" />
        <Stat label="Returned to applicants" value={Number(counts.returned)} hint="For the applicant to correct" />
        <Stat label="With the Bursary" value={Number(counts.forwarded)} tone="brand" hint="After Human Resources" />
      </StatGrid>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Next in queue" className="xl:col-span-2" bodyClassName="p-5 pt-0"><QueueTable rows={queue} hrefBase="/hr/applications" empty="No applications awaiting verification." /></Card>
        <Card title="Recent decisions" bodyClassName="p-5 pt-0">
          <Table caption="Recent decisions">
            <thead><tr><Th>Application</Th><Th>Outcome</Th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.v.id}><Td><Link className="link" href={`/hr/applications/${r.appId}`}>{r.ref}</Link><p className="text-xs text-muted">{r.officer} · <DateText value={r.v.createdAt} /></p></Td><Td><StatusBadge status={r.v.outcome === "returned" ? "returned" : r.v.outcome === "declined" ? "declined" : "verified"} /></Td></tr>
              ))}
              {!recent.length && <tr><Td colSpan={2} className="text-muted">No decisions yet.</Td></tr>}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
