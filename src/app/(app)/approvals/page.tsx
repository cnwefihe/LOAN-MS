import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { approvalStageName, getWording } from "@/server/wording";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { applicationQueue } from "@/server/services/hr";
import { myApprovalQueue } from "@/server/services/approvals";
import { departmentsHeadedBy } from "@/server/services/staff";
import { Card, PageHeader, Stat, StatGrid, Money } from "@/components/ui";
import { QueueTable, QueueFilters } from "@/components/queue-table";
import { paginate, Pagination } from "@/components/pagination";
import { sum } from "@/lib/finance/money";

export const metadata = { title: "Approvals" };

export default async function Approvals({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; size?: string }> }) {
  const actor = await requireActor();
  const db = await getDb();
  const heads = await departmentsHeadedBy(db, actor.userId);
  const seesAll = can(actor, "approval.queue.view");
  if (!seesAll && !heads.length) redirect("/forbidden");
  const sp = await searchParams;
  const w = await getWording(db);
  // "mine": waiting for this person's decision. Approvers with the queue permission can also look back at decided applications.
  const status = seesAll ? (sp.status ?? "mine") : "mine";
  const STATUSES = [
    { value: "mine", label: "Awaiting your decision" }, { value: "pending_approval", label: "All awaiting approval" },
    { value: "approved", label: "Approved" }, { value: "declined", label: "Declined" }, { value: "", label: "All submitted" },
  ];
  const mineIds = new Set(await myApprovalQueue(db, actor));
  const pending = await applicationQueue(db, actor, { statuses: ["pending_approval"] });
  const mine = pending.filter((r) => mineIds.has(r.app.id));
  const rows = status === "mine" ? mine.filter((r) => !sp.q || `${r.app.reference} ${r.applicantName} ${r.staffNumber ?? ""}`.toLowerCase().includes(sp.q.toLowerCase()))
    : status === "pending_approval" && !sp.q ? pending
    : await applicationQueue(db, actor, { statuses: status ? [status as "pending_approval"] : undefined, q: sp.q });
  // The stages this person decides at, named from their own point of view ("you"), never by their own title.
  const myLevels = new Set([heads.length ? 1 : 0, can(actor, "approval.hr_director") ? 2 : 0, can(actor, "approval.decide") ? 3 : 0].filter(Boolean));
  const ORDINAL = ["", "First approval", "Second approval", "Final approval"];
  const yourStages = [...myLevels].map((l) => ORDINAL[l]);
  const others = ["Line Manager", "HR Director", "Bursar"];
  const stageLabel = (l: number, t?: Parameters<typeof approvalStageName>[2]) => (myLevels.has(l) ? "Awaiting you" : approvalStageName(w, l, t));

  return (
    <>
      <PageHeader title="Approvals" description="Review each application and record your decision." />
      <StatGrid>
        <Stat label="Awaiting your decision" value={mine.length} tone={mine.length ? "warning" : "default"} />
        <Stat label="Value awaiting you" value={<Money value={sum(mine.map((r) => r.app.requestedAmount)).toFixed(2)} />} />
        <Stat label="In approval overall" value={pending.length} hint={[1, 2, 3].map((l) => `${myLevels.has(l) ? "With you" : l === 1 ? "Line Manager" : others[l - 1]}: ${pending.filter((r) => (r.app.currentApprovalLevel || 1) === l).length}`).join(" · ")} />
        <Stat label="Your stage" value={yourStages.join(", ") || "N/A"} hint="Never on your own loan or one you guarantee" />
      </StatGrid>
      <Card bodyClassName="p-5">
        {seesAll && <QueueFilters action="/approvals" q={sp.q} status={status} statuses={STATUSES} />}
        <QueueTable rows={paginate(rows, sp.page, sp.size).items} hrefBase="/approvals" stageName={stageLabel} empty={status === "mine" ? "Nothing is waiting for your decision." : undefined} />
        <Pagination data={paginate(rows, sp.page, sp.size)} base="/approvals" params={{ q: sp.q, status: sp.status }} label="applications" />
      </Card>
    </>
  );
}
