import Link from "next/link";
import { Plus } from "lucide-react";
import { getDb } from "@/db";
import { schools, departments, staffCategories, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { Badge, Card, EmptyState, MENU_ACTION, MENU_FORM, PageHeader, Table, Tabs, Th, Td } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { deleteOrgAction } from "@/app/actions/admin";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { RowMenu } from "@/components/row-menu";

export const metadata = { title: "Organisation" };

const TAB = {
  departments: { kind: "department", add: "New department", search: "Search name or code" },
  schools: { kind: "school", add: "New school", search: "Search name or code" },
  categories: { kind: "category", add: "New category", search: "Search name or code" },
} as const;

const Status = ({ on }: { on: boolean }) => (on ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>);

export default async function Organisation({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; page?: string; size?: string }> }) {
  await requireActor("admin.org.manage");
  const sp = await searchParams;
  const tab = sp.tab === "schools" || sp.tab === "categories" ? sp.tab : "departments";
  const db = await getDb();
  const [s, d, c, people] = await Promise.all([
    db.select().from(schools).orderBy(schools.name),
    db.select().from(departments).orderBy(departments.name),
    db.select().from(staffCategories).orderBy(staffCategories.name),
    db.select({ id: users.id, name: users.displayName }).from(users),
  ]);
  const needle = sp.q?.trim().toLowerCase();
  const match = <T extends { code: string; name: string }>(rows: T[]) => (needle ? rows.filter((r) => `${r.name} ${r.code}`.toLowerCase().includes(needle)) : rows);
  const paged = <T,>(rows: T[]) => paginate(rows, sp.page, sp.size);
  const deptPage = paged(match(d)), schoolPage = paged(match(s)), catPage = paged(match(c));
  const current = tab === "departments" ? deptPage : tab === "schools" ? schoolPage : catPage;
  const editHref = (id: string) => `/admin/organisation/${TAB[tab].kind}/${id}`;
  return (
    <>
      <PageHeader title="Organisation structure" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Organisation" }]}
        description="Departments with their approver, schools and staff categories."
        actions={<Link href={`/admin/organisation/${TAB[tab].kind}/new`} className="btn-primary h-8 px-3 text-xs"><Plus aria-hidden className="h-3.5 w-3.5" />{TAB[tab].add}</Link>} />
      <Tabs base="/admin/organisation" active={tab} tabs={[{ key: "departments", label: "Departments", count: d.length }, { key: "schools", label: "Schools and faculties", count: s.length }, { key: "categories", label: "Staff categories", count: c.length }]} />
      <Card bodyClassName="p-5">
        <SearchFilter q={sp.q} placeholder={TAB[tab].search} hidden={{ tab }} />
        {current.items.length === 0 ? <EmptyState title="Nothing found" description="Try a different search." /> : tab === "departments" ? (
          <Table caption="Departments">
            <thead><tr><Th>Name</Th><Th>Code</Th><Th>School</Th><Th>Approved by</Th><Th>Approver</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {deptPage.items.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="font-mono text-xs text-muted">{r.code}</Td>
                  <Td>{s.find((x) => x.id === r.schoolId)?.name ?? "-"}</Td>
                  <Td>{r.approverTitle === "line_manager" ? "Line Manager" : "HOD"}</Td>
                  <Td>{r.headUserId ? people.find((p) => p.id === r.headUserId)?.name ?? "Inactive user" : <Badge tone="warning">Not set</Badge>}</Td>
                  <Td><Status on={r.isActive} /></Td>
                  <Td right><RowMenu label={r.name} items={[{ label: "Edit", href: editHref(r.id) }]}><ActionForm inline className={MENU_FORM} action={deleteOrgAction.bind(null, "department", r.id)} submitLabel="Delete" submitClassName={`${MENU_ACTION} text-danger`} confirm={`Delete ${r.name}? This cannot be undone.`} /></RowMenu></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : tab === "schools" ? (
          <Table caption="Schools and faculties">
            <thead><tr><Th>Name</Th><Th>Code</Th><Th right>Departments</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {schoolPage.items.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="font-mono text-xs text-muted">{r.code}</Td>
                  <Td right>{d.filter((x) => x.schoolId === r.id).length}</Td>
                  <Td><Status on={r.isActive} /></Td>
                  <Td right><RowMenu label={r.name} items={[{ label: "Edit", href: editHref(r.id) }]}><ActionForm inline className={MENU_FORM} action={deleteOrgAction.bind(null, "school", r.id)} submitLabel="Delete" submitClassName={`${MENU_ACTION} text-danger`} confirm={`Delete ${r.name}? This cannot be undone.`} /></RowMenu></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Table caption="Staff categories">
            <thead><tr><Th>Name</Th><Th>Code</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {catPage.items.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="font-mono text-xs text-muted">{r.code}</Td>
                  <Td><Status on={r.isActive} /></Td>
                  <Td right><RowMenu label={r.name} items={[{ label: "Edit", href: editHref(r.id) }]}><ActionForm inline className={MENU_FORM} action={deleteOrgAction.bind(null, "category", r.id)} submitLabel="Delete" submitClassName={`${MENU_ACTION} text-danger`} confirm={`Delete ${r.name}? This cannot be undone.`} /></RowMenu></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination data={current} base="/admin/organisation" params={{ tab, q: sp.q }} label={tab === "departments" ? "departments" : tab === "schools" ? "schools" : "categories"} />
      </Card>
    </>
  );
}
