import Link from "next/link";
import { and, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { applicationGuarantors, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { listGuarantorPool } from "@/server/services/guarantor-pool";
import { LIVE_GUARANTEE_STATUSES } from "@/server/services/guarantors";
import { removeGuarantorEntryAction, saveGuarantorEntryAction } from "@/app/actions/guarantor-pool";
import { RowMenu } from "@/components/row-menu";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { GuarantorFields } from "@/components/guarantor-fields";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, PageHeader, Stat, StatGrid, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Guarantors" };

export default async function Guarantors({ searchParams }: { searchParams: Promise<{ edit?: string; q?: string; page?: string; size?: string }> }) {
  await requireActor("admin.policy.manage");
  const sp = await searchParams;
  const db = await getDb();
  const all = await listGuarantorPool(db);
  // Live guarantees for each person on the list, matched by email.
  const counts = all.length ? await db.select({ email: sql<string>`lower(${users.email})`, n: sql<number>`count(*)` })
    .from(applicationGuarantors).innerJoin(users, sql`${users.id} = ${applicationGuarantors.guarantorId}`)
    .where(and(inArray(applicationGuarantors.status, [...LIVE_GUARANTEE_STATUSES]), inArray(sql`lower(${users.email})`, all.map((r) => r.email.toLowerCase()))))
    .groupBy(sql`lower(${users.email})`) : [];
  const live = new Map(counts.map((c) => [c.email, Number(c.n)]));
  const q = sp.q?.trim().toLowerCase();
  const list = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)) : all;
  const pg = paginate(list, sp.page, sp.size);
  const editing = sp.edit ? all.find((r) => r.id === sp.edit) : undefined;
  const available = all.filter((r) => r.isActive).length;

  return (
    <>
      <PageHeader title="Guarantors" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Guarantors" }]}
        description="Staff who may stand as guarantors (the managerial cadre). Applicants choose from these names; emails are not shown to them, and are used only to send the guarantor the request."
        actions={<RowMenu label="Add guarantors" items={[{ label: "Add a guarantor", href: "/admin/guarantors/new" }, { label: "Add many at once", href: "/admin/guarantors/new?tab=many" }]} />} />
      <StatGrid>
        <Stat label="On the list" value={all.length} />
        <Stat label="Available" value={available} tone="success" />
        <Stat label="Not available" value={all.length - available} />
        <Stat label="Guaranteeing a loan now" value={[...live.values()].filter((n) => n > 0).length} tone="brand" />
      </StatGrid>

      {editing && (
        <Card title={`Manage ${editing.name}`} className="mb-6 max-w-2xl" actions={<Link href="/admin/guarantors" className="link text-xs">Close</Link>}>
          <ActionForm key={editing.id} action={saveGuarantorEntryAction.bind(null, editing.id)} submitLabel="Save changes" listChanges confirm="Save these changes to the guarantor?">
            <GuarantorFields name={editing.name} email={editing.email} cadre={editing.cadre} />
            <label className="mt-3 flex items-center gap-2 text-sm"><input id="isActive" type="checkbox" name="isActive" defaultChecked={editing.isActive} className="h-4 w-4" /> Available to be chosen</label>
          </ActionForm>
          <div className="mt-4 border-t border-line pt-4">
            <ActionForm action={removeGuarantorEntryAction.bind(null, editing.id)} submitLabel="Remove from the list" variant="danger"
              confirm={`Remove ${editing.name} from the list? Loans they already guarantee are not affected.`} />
          </div>
        </Card>
      )}

      <Card title="Eligible guarantors" className="min-w-0" bodyClassName="p-5">
        <SearchFilter q={sp.q} placeholder="Search name or email" />
        {pg.items.length === 0 ? <EmptyState title={all.length ? "No one matches that search" : "No guarantors on the list yet"} description={all.length ? undefined : "Use the menu at the top to add them one at a time, or paste the whole list."} /> : (
          <Table caption="Eligible guarantors">
            <thead><tr><Th>Name</Th><Th>Email</Th><Th>Cadre</Th><Th>Status</Th><Th right>Live guarantees</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {pg.items.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="text-muted">{r.email}</Td>
                  <Td>{r.cadre}</Td>
                  <Td>{r.isActive ? <Badge tone="success">Available</Badge> : <Badge>Not available</Badge>}</Td>
                  <Td right className="tabular">{live.get(r.email.toLowerCase()) ?? 0}</Td>
                  <Td right><RowMenu label={r.name} items={[{ label: "Manage", href: `/admin/guarantors?edit=${r.id}` }]} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/admin/guarantors" params={{ q: sp.q }} label="guarantors" />
      </Card>
    </>
  );
}
