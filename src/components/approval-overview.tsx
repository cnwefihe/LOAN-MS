import Link from "next/link";
import { and, count, eq, gte } from "drizzle-orm";
import type { Executor } from "@/db";
import { approvals } from "@/db/schema";
import type { Actor } from "@/server/actor";
import { applicationQueue } from "@/server/services/hr";
import { myApprovalQueue } from "@/server/services/approvals";
import { sum } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { Card, Money, Stat, StatGrid } from "@/components/ui";
import { QueueTable } from "@/components/queue-table";

const DAY_MS = 86_400_000;
const SHOWN = 5;

export function OverviewHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-sm font-semibold text-navy">{children}</h2>;
}

/** The same approvals summary for every approver. `children` joins the stat cards; `aside` sits beside the list. */
export async function ApprovalOverview({ db, actor, aside, children }: { db: Executor; actor: Actor; aside?: React.ReactNode; children?: React.ReactNode }) {
  const ids = new Set(await myApprovalQueue(db, actor));
  const queue = (await applicationQueue(db, actor, { statuses: ["pending_approval"] })).filter((r) => ids.has(r.app.id));
  const oldestFirst = [...queue].sort((a, b) => a.app.updatedAt.getTime() - b.app.updatedAt.getTime());
  const oldest = oldestFirst[0];
  const days = oldest ? Math.floor((Date.now() - oldest.app.updatedAt.getTime()) / DAY_MS) : 0;
  const decided = await db.select({ decision: approvals.decision, n: count() }).from(approvals)
    .where(and(eq(approvals.approverId, actor.userId), gte(approvals.createdAt, new Date(`${todayLagos().slice(0, 7)}-01T00:00:00+01:00`))))
    .groupBy(approvals.decision);
  const made = (d: string) => decided.find((x) => x.decision === d)?.n ?? 0;
  const total = decided.reduce((n, x) => n + x.n, 0);

  return (
    <>
      <OverviewHeading>Approvals</OverviewHeading>
      <StatGrid>
        <Stat label="Awaiting your decision" value={queue.length} hint={queue.length === 1 ? "Application" : "Applications"} tone={queue.length ? "warning" : "default"} href="/approvals" />
        <Stat label="Value awaiting decision" value={<Money value={sum(queue.map((r) => r.app.requestedAmount)).toFixed(2)} />} hint="Total requested" />
        <Stat label="Longest wait" value={oldest ? (days === 1 ? "1 day" : `${days} days`) : "None"} hint={oldest ? oldest.app.reference : "Nothing outstanding"} tone={days >= 2 ? "warning" : "default"} />
        <Stat label="Decided this month" value={total} hint={`${made("approved")} approved, ${made("declined")} declined`} />
      </StatGrid>
      {children}
      <div className={`mb-6 grid gap-6 ${aside ? "lg:grid-cols-3" : ""}`}>
      <Card title="Applications awaiting your decision" description={queue.length > SHOWN ? `Longest waiting first. Showing ${SHOWN} of ${queue.length}.` : "Longest waiting first."}
        actions={<Link href="/approvals" className="link text-sm">All approvals</Link>} className={aside ? "h-full lg:col-span-2" : undefined} bodyClassName={queue.length ? "p-5 pt-0" : undefined}>
        <QueueTable rows={oldestFirst.slice(0, SHOWN)} hrefBase="/approvals" stageName={() => "Awaiting you"} empty="No applications awaiting your decision." />
      </Card>
      {aside}
      </div>
    </>
  );
}
