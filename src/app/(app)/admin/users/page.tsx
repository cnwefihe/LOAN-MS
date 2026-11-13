import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { searchUsers } from "@/server/services/admin";
import type { RoleCode } from "@/lib/auth/permissions";
import { getWording, APPROVER_TITLES, type ApproverTitle } from "@/server/wording";
import { departments } from "@/db/schema";
import { isNotNull } from "drizzle-orm";
import { Card, PageHeader, Badge, DateText, EmptyState, Table, Th, Td } from "@/components/ui";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { RowMenu } from "@/components/row-menu";

export const metadata = { title: "Users & roles" };

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("admin.users.manage");
  const { q, page, size } = await searchParams;
  const db = await getDb();
  const rows = await searchUsers(db, actor, q);
  const w = await getWording(db);
  // HOD and Line Manager are kept on the department, not as roles: whoever approves for it.
  const headed = await db.select({ userId: departments.headUserId, title: departments.approverTitle, name: departments.name }).from(departments).where(isNotNull(departments.headUserId));
  const pg = paginate(rows, page, size);
  return (
    <>
      <PageHeader title="Users" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Users" }]}
        description="Staff who have signed in or been added here. Manage roles, departments, access and two-step verification."
        actions={<RowMenu label="Add users" items={[{ label: "Add a user", href: "/admin/users/new" }, { label: "Add many at once", href: "/admin/users/new?tab=many" }]} />} />
      <Card bodyClassName="p-5">
        <SearchFilter q={q} placeholder="Search name or email" />
        {pg.items.length === 0 ? <EmptyState title="No users found" description="Try a different name or email." /> : (
          <Table caption="Users">
            <thead><tr><Th>Name</Th><Th>Email</Th><Th>Staff no.</Th><Th>Department</Th><Th>Role</Th><Th>Status</Th><Th>Last sign-in</Th><Th className="sticky right-0"><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {pg.items.map((u) => {
                // Everyone holds Applicant, so it only shows when the user has no other role and approves for no department.
                const approves = headed.filter((d) => d.userId === u.id);
                const shown = u.roles.filter((r) => r !== "APPLICANT" || !approves.length);
                return (
                  <tr key={u.id}>
                    <Td className="font-medium">{u.displayName}</Td>
                    <Td className="text-muted">{u.email}</Td>
                    <Td>{u.staff?.staffNumber ?? "-"}</Td>
                    <Td>{u.staff?.department ?? "-"}</Td>
                    <Td><div className="flex flex-wrap gap-1">
                      {approves.map((d) => <Badge key={d.name} tone="success"><span title={d.name}>{APPROVER_TITLES[d.title as ApproverTitle] ?? "HOD"}, {d.name}</span></Badge>)}
                      {(shown.length || approves.length ? shown : u.roles).map((r) => <Badge key={r} tone={r === "SUPER_ADMIN" ? "brand" : "info"}>{w.role[r as RoleCode]?.name ?? r}</Badge>)}
                    </div></Td>
                    <Td>{u.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}</Td>
                    <Td>{u.lastLoginAt ? <DateText value={u.lastLoginAt} withTime /> : "Never"}</Td>
                    <Td right className="sticky right-0 bg-white"><RowMenu label={u.displayName} items={[{ label: "Manage", href: `/admin/users/${u.id}` }, ...(u.staff && can(actor, "hr.staff.view") ? [{ label: "Staff record", href: `/hr/staff/${u.id}` }] : [])]} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pagination data={pg} base="/admin/users" params={{ q }} label="users" />
      </Card>
    </>
  );
}
