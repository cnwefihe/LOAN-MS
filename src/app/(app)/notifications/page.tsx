import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader, DateText, EmptyState, Badge } from "@/components/ui";
import { markAllReadAction } from "@/app/actions/applicant";
import { paginate, Pagination } from "@/components/pagination";

export const metadata = { title: "Notifications" };

export default async function Notifications({ searchParams }: { searchParams: Promise<{ page?: string; size?: string }> }) {
  const actor = await requireActor();
  const db = await getDb();
  const rows = await db.select().from(notifications).where(eq(notifications.userId, actor.userId)).orderBy(desc(notifications.createdAt)).limit(1000);
  const unread = rows.filter((r) => !r.readAt).length;
  const sp = await searchParams;
  const pg = paginate(rows, sp.page, sp.size);
  return (
    <>
      <PageHeader title="Notifications" description={`${unread} unread.`} crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Notifications" }]}
        actions={unread > 0 ? <ActionForm action={markAllReadAction} submitLabel="Mark all as read" variant="secondary" /> : undefined} />
      <Card bodyClassName="p-0">
        {rows.length === 0 ? <div className="p-5"><EmptyState title="No notifications" /></div> : (
          <ul className="divide-y divide-line">
            {pg.items.map((n) => (
              <li key={n.id} className={`px-5 py-4 ${n.readAt ? "" : "bg-brand-50/50"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className={`text-sm ${n.readAt ? "" : "font-semibold"}`}>{!n.readAt && <Badge tone="info">New</Badge>} {n.title}</p>
                  <span className="text-xs text-muted"><DateText value={n.createdAt} withTime /></span>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{n.body}</p>
                {n.link && <Link href={n.link} className="link mt-1 inline-block text-sm">Open</Link>}
              </li>
            ))}
          </ul>
        )}
        <div className="px-5 pb-4"><Pagination data={pg} base="/notifications" label="notifications" /></div>
      </Card>
    </>
  );
}
