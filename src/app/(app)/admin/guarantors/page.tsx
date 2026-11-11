import Link from "next/link";
import { and, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { applicationGuarantors, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { listGuarantorPool } from "@/server/services/guarantor-pool";
import { LIVE_GUARANTEE_STATUSES } from "@/server/services/guarantors";
import { importGuarantorsAction, removeGuarantorEntryAction, saveGuarantorEntryAction } from "@/app/actions/guarantor-pool";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, EmptyState, Field, PageHeader, Stat, StatGrid, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Guarantors" };

export default async function Guarantors({ searchParams }: { searchParams: Promise<{ edit?: string; q?: string }> }) {
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
  const editing = sp.edit ? all.find((r) => r.id === sp.edit) : undefined;
  const available = all.filter((r) => r.isActive).length;

  return (
    <>
      <PageHeader title="Guarantors" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Guarantors" }]}
        description="Staff who may stand as guarantors (the managerial cadre). Applicants choose from these names; emails are not shown to them, and are used only to send the guarantor the request." />
      <StatGrid>
        <Stat label="On the list" value={all.length} />
        <Stat label="Available" value={available} tone="success" />
        <Stat label="Not available" value={all.length - available} />
        <Stat label="Guaranteeing a loan now" value={[...live.values()].filter((n) => n > 0).length} tone="brand" />
      </StatGrid>

      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Card title="Eligible guarantors" className="min-w-0 xl:col-span-2" bodyClassName="px-5 py-0"
          actions={<form className="flex gap-2" role="search"><label htmlFor="q" className="sr-only">Search</label><input id="q" name="q" defaultValue={sp.q} placeholder="Search name or email" className="input h-8 w-48 text-xs" /></form>}>
          {list.length === 0 ? <div className="py-5"><EmptyState title={all.length ? "No one matches that search" : "No guarantors on the list yet"} description={all.length ? undefined : "Add them one at a time, or paste the whole list."} /></div> : (
            <Table caption="Eligible guarantors">
              <thead><tr><Th>Name</Th><Th>Email</Th><Th>Cadre</Th><Th>Status</Th><Th right>Live guarantees</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <Td className="font-medium">{r.name}</Td>
                    <Td className="text-muted">{r.email}</Td>
                    <Td>{r.cadre}</Td>
                    <Td>{r.isActive ? <Badge tone="success">Available</Badge> : <Badge>Not available</Badge>}</Td>
                    <Td right className="tabular">{live.get(r.email.toLowerCase()) ?? 0}</Td>
                    <Td right><Link href={`/admin/guarantors?edit=${r.id}`} className="link text-xs">Edit</Link></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="space-y-6">
          {editing ? (
            <Card title={`Edit ${editing.name}`} actions={<Link href="/admin/guarantors" className="link text-xs">Close</Link>}>
              <ActionForm key={editing.id} action={saveGuarantorEntryAction.bind(null, editing.id)} submitLabel="Save changes" listChanges confirm="Save these changes to the guarantor?">
                <GuarantorFields name={editing.name} email={editing.email} cadre={editing.cadre} />
                <label className="mt-3 flex items-center gap-2 text-sm"><input id="isActive" type="checkbox" name="isActive" defaultChecked={editing.isActive} className="h-4 w-4" /> Available to be chosen</label>
              </ActionForm>
              <div className="mt-4 border-t border-line pt-4">
                <ActionForm action={removeGuarantorEntryAction.bind(null, editing.id)} submitLabel="Remove from the list" variant="danger"
                  confirm={`Remove ${editing.name} from the list? Loans they already guarantee are not affected.`} />
              </div>
            </Card>
          ) : (
            <Card title="Add a guarantor">
              <ActionForm action={saveGuarantorEntryAction.bind(null, null)} submitLabel="Add" resetOnSuccess confirm="Add this person to the list of guarantors?" listChanges>
                <GuarantorFields />
              </ActionForm>
            </Card>
          )}
          <Card title="Add many at once" description="One person per line: full name, then university email. A name already on the list is updated.">
            <ActionForm action={importGuarantorsAction} submitLabel="Add to the list" resetOnSuccess confirm="Add these people to the list of guarantors?">
              <label htmlFor="lines" className="label">Names and emails</label>
              <textarea id="lines" name="lines" rows={7} required className="input font-mono text-xs" placeholder={"Ada Obi, ada.obi@example.edu.ng\nTunde Bello, tunde.bello@example.edu.ng"} />
              <label htmlFor="cadre-many" className="label mt-3">Cadre</label>
              <input id="cadre-many" name="cadre" defaultValue="Managerial" className="input" />
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}

function GuarantorFields({ name, email, cadre }: { name?: string; email?: string; cadre?: string }) {
  return (
    <div className="grid gap-3">
      <Field label="Full name" htmlFor="name"><input id="name" name="name" required defaultValue={name} className="input" /></Field>
      <Field label="University email" htmlFor="email" hint="Not shown to applicants."><input id="email" name="email" type="email" required defaultValue={email} className="input" /></Field>
      <Field label="Cadre" htmlFor="cadre"><input id="cadre" name="cadre" defaultValue={cadre ?? "Managerial"} className="input" /></Field>
    </div>
  );
}
