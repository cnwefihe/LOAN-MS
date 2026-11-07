import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { applicationQueue } from "@/server/services/hr";
import { Card, PageHeader } from "@/components/ui";
import { QueueTable, QueueFilters } from "@/components/queue-table";
import { paginate, Pagination } from "@/components/pagination";

export const metadata = { title: "Human Resources verification queue" };

const STATUSES = [
  { value: "pending_hr", label: "Awaiting your verification" }, { value: "pending_guarantor", label: "Awaiting guarantors" }, { value: "returned", label: "Returned" },
  { value: "pending_bursary", label: "With the Bursary" }, { value: "pending_approval", label: "Awaiting approval" }, { value: "approved", label: "Approved" }, { value: "declined", label: "Declined" }, { value: "", label: "All submitted" },
];

export default async function HrQueue({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("hr.queue.view");
  const sp = await searchParams;
  const status = sp.status ?? "pending_hr";
  const rows = await applicationQueue(await getDb(), actor, { statuses: status ? [status as "pending_hr"] : undefined, q: sp.q });
  return (
    <>
      <PageHeader title="Verification queue" crumbs={[{ label: "Human Resources", href: "/hr" }, { label: "Queue" }]} description="Applications awaiting your review." />
      <Card bodyClassName="p-5 pt-5">
        <QueueFilters action="/hr/applications" q={sp.q} status={status} statuses={STATUSES} />
        <QueueTable rows={paginate(rows, sp.page, sp.size).items} hrefBase="/hr/applications" />
        <Pagination data={paginate(rows, sp.page, sp.size)} base="/hr/applications" params={{ q: sp.q, status: sp.status }} label="applications" />
      </Card>
    </>
  );
}
