import { getDb } from "@/db";
import { approvalStageName, getWording } from "@/server/wording";
import { requireActor } from "@/lib/auth/session";
import { applicationQueue } from "@/server/services/hr";
import { Card, PageHeader, Stat, StatGrid, Money } from "@/components/ui";
import { QueueTable, QueueFilters } from "@/components/queue-table";
import { paginate, Pagination } from "@/components/pagination";
import { sum } from "@/lib/finance/money";

export const metadata = { title: "Bursary review" };

export default async function BursaryQueue({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("bursary.review");
  const sp = await searchParams;
  const status = sp.status ?? "pending_bursary";
  const db = await getDb();
  const rows = await applicationQueue(db, actor, { statuses: status ? [status as "pending_bursary"] : undefined, q: sp.q });
  const pending = status === "pending_bursary" ? rows : await applicationQueue(db, actor, { statuses: ["pending_bursary"] });
  const cleared = await applicationQueue(db, actor, { statuses: ["pending_approval"] });
  const w = await getWording(db);
  const STATUSES = [{ value: "pending_bursary", label: "Awaiting your review" }, { value: "pending_approval", label: "Sent for approval" }, { value: "", label: "All submitted" }];
  return (
    <>
      <PageHeader title="Reviews" description="Check pay, loans and funds, then send to the Line Manager." />
      <StatGrid>
        <Stat label="Awaiting review" value={pending.length} tone={pending.length ? "warning" : "default"} />
        <Stat label="Value awaiting review" value={<Money value={sum(pending.map((r) => r.app.requestedAmount)).toFixed(2)} />} />
        <Stat label="Sent for approval" value={cleared.length} />
        <Stat label="Value cleared" value={<Money value={sum(cleared.map((r) => r.app.requestedAmount)).toFixed(2)} />} tone="brand" />
      </StatGrid>
      <Card bodyClassName="p-5">
        <QueueFilters action="/bursary/review" q={sp.q} status={status} statuses={STATUSES} />
        <QueueTable rows={paginate(rows, sp.page, sp.size).items} hrefBase="/bursary/review" stageName={(l, t) => approvalStageName(w, l, t)} />
        <Pagination data={paginate(rows, sp.page, sp.size)} base="/bursary/review" params={{ q: sp.q, status: sp.status }} label="applications" />
      </Card>
    </>
  );
}
