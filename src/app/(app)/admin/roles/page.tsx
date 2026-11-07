import Link from "next/link";
import { Check, Plus } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { roleMatrix } from "@/server/services/admin";
import { Badge, Card, EmptyState, PageHeader, Table, Tabs, Th, Td } from "@/components/ui";
import { RowMenu } from "@/components/row-menu";
import { SearchFilter } from "@/components/search-filter";
import { PERMISSION_CATEGORIES, PERMISSIONS, type Permission } from "@/lib/auth/permissions";

export const metadata = { title: "Roles and permissions" };

const TABS = [{ key: "roles", label: "Roles" }, { key: "compare", label: "Compare permissions" }];

export default async function Roles({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; category?: string }> }) {
  const actor = await requireActor("admin.roles.manage");
  const { tab, q, category } = await searchParams;
  const { roles, permissions, grants, holders } = await roleMatrix(await getDb(), actor);
  const textOf = (p: { code: string; description: string | null }) => PERMISSIONS[p.code as Permission]?.description ?? p.description ?? p.code;
  const needle = q?.trim().toLowerCase();
  const visible = permissions.filter((p) => (!category || p.category === category) && (!needle || textOf(p).toLowerCase().includes(needle)));
  const categories = PERMISSION_CATEGORIES.filter((c) => visible.some((p) => p.category === c));
  const countFor = (roleId: string) => permissions.filter((p) => grants.has(`${roleId}:${p.id}`)).length;
  return (
    <>
      <PageHeader title="Roles and permissions" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Roles" }]}
        description="What each role is called and what it can do."
        actions={<Link href="/admin/roles/new" className="btn-primary h-8 px-3 text-xs"><Plus aria-hidden className="h-3.5 w-3.5" />New role</Link>} />
      <Tabs base="/admin/roles" active={tab === "compare" ? "compare" : "roles"} tabs={TABS} />
      {tab === "compare" ? (
        <>
          <SearchFilter q={q} placeholder="Search permissions" hidden={{ tab: "compare" }}
            filter={{ name: "category", value: category, options: [{ value: "", label: "All areas" }, ...PERMISSION_CATEGORIES.map((c) => ({ value: c, label: c }))] }} />
          <Card bodyClassName="p-0!">
            {visible.length === 0 ? <div className="p-5"><EmptyState title="No permissions found" description="Try a different search." /></div> : (
              <div className="relative max-h-[calc(100vh-15rem)] min-h-96 overflow-auto rounded-lg" role="region" aria-label="Permissions by role" tabIndex={0}>
                <table className="min-w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">Permissions by role</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="sticky left-0 top-0 z-30 min-w-80 border-b border-line bg-slate-50 px-5 py-2.5 text-left text-sm font-semibold text-slate-700">Permission</th>
                      {roles.map((r) => <th key={r.id} scope="col" className="sticky top-0 z-20 min-w-24 border-b border-l border-line bg-slate-50 px-2 py-2.5 text-center align-middle text-xs font-semibold text-ink"><Link href={`/admin/roles/${r.id}`} className="hover:text-brand hover:underline">{r.name}</Link></th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((c) => [
                      <tr key={c}><th colSpan={roles.length + 1} scope="colgroup" className="border-b border-line bg-brand-50 px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-brand">{c}</th></tr>,
                      ...visible.filter((p) => p.category === c).map((p) => (
                        <tr key={p.id} className="group">
                          <th scope="row" className="sticky left-0 z-10 border-b border-line bg-white px-5 py-1.5 text-left font-normal text-ink group-hover:bg-slate-50">{textOf(p)}</th>
                          {roles.map((r) => (
                            <td key={r.id} className="border-b border-l border-line px-2 py-1.5 text-center group-hover:bg-slate-50">
                              {grants.has(`${r.id}:${p.id}`)
                                ? <span className="mx-auto flex h-5 w-5 items-center justify-center rounded-full bg-success-50"><Check aria-label="Granted" className="h-3.5 w-3.5 text-success" /></span>
                                : <span aria-label="Not granted" className="text-slate-300">-</span>}
                            </td>
                          ))}
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card bodyClassName="p-5 py-0">
          <Table caption="Roles">
            <thead><tr><Th>Role</Th><Th>Description</Th><Th right>Users</Th><Th right>Permissions</Th><Th>Type</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="min-w-72 text-muted whitespace-normal!">{r.description ?? "-"}</Td>
                  <Td right>{holders(r.id)}</Td>
                  <Td right>{countFor(r.id)} of {permissions.length}</Td>
                  <Td>{r.isSystem ? <Badge>Built-in</Badge> : <Badge tone="info">Custom</Badge>}</Td>
                  <Td right><RowMenu label={r.name} items={[{ label: "Manage", href: `/admin/roles/${r.id}` }]} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
