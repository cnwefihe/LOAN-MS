import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { searchUsers } from "@/server/services/admin";
import { ROLE_CODES, type RoleCode } from "@/lib/auth/permissions";
import { getWording, APPROVER_TITLES, type ApproverTitle } from "@/server/wording";
import { departments } from "@/db/schema";
import { isNotNull } from "drizzle-orm";
import { Card, PageHeader, Badge, DateText, EmptyState, Table, Th, Td } from "@/components/ui";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { RowMenu } from "@/components/row-menu";

export const metadata = { title: "Users & roles" };

/** Staff roles from highest to lowest. Roles an administrator created rank below these and above HOD and Line Manager. */
const STAFF_RANK: string[] = ["SUPER_ADMIN", "HEAD_OF_ACCOUNT", "HR_DIRECTOR", "PAYROLL_MANAGER", "HR_ADMIN", "BURSARY_OFFICER", "ACCOUNTS_ADMIN", "ACCOUNTS_OFFICER", "PAYROLL_OFFICER"];
const BASE_RANK = ["GUARANTOR", "APPLICANT"];

/** The highest role held: a staff role first, then a custom role, then Guarantor, then Applicant. */
function topRole(roles: string[]): string | null {
  const staff = STAFF_RANK.find((r) => roles.includes(r));
  if (staff) return staff;
  const custom = roles.find((r) => !(ROLE_CODES as readonly string[]).includes(r));
  if (custom) return custom;
  return BASE_RANK.find((r) => roles.includes(r)) ?? null;
}

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
                // One badge: the highest role held. Applicant shows only when the person holds nothing else.
                const approves = headed.filter((d) => d.userId === u.id);
                const top = topRole(u.roles);
                const roleName = (r: string) => w.role[r as RoleCode]?.name ?? r;
                const approverTitle = approves.length ? APPROVER_TITLES[approves[0].title as ApproverTitle] ?? "HOD" : null;
                // One department by name; several as a count, listed in full on hover.
                const approverName = approverTitle ? (approves.length === 1 ? `${approverTitle}, ${approves[0].name}` : `${approverTitle}, ${approves.length} departments`) : null;
                const approverFull = approverTitle ? `${approverTitle}: ${approves.map((d) => d.name).join(", ")}` : null;
                // A staff role outranks HOD and Line Manager; HOD and Line Manager outrank Guarantor and Applicant.
                const shown = top && (STAFF_RANK.includes(top) || !ROLE_CODES.includes(top as RoleCode)) ? { label: roleName(top), tone: top === "SUPER_ADMIN" ? "brand" as const : "info" as const }
                  : approverName ? { label: approverName, tone: "success" as const }
                  : { label: roleName(top ?? "APPLICANT"), tone: "info" as const };
                const all = [...(approverFull && approves.length > 1 ? [approverFull] : []), ...u.roles.filter((r) => r !== "APPLICANT").map(roleName)];
                return (
                  <tr key={u.id}>
                    <Td className="font-medium">{u.displayName}</Td>
                    <Td className="text-muted">{u.email}</Td>
                    <Td>{u.staff?.staffNumber ?? "-"}</Td>
                    <Td>{u.staff?.department ?? "-"}</Td>
                    <Td><span title={all.filter((a) => a !== shown.label).length ? all.filter((a) => a !== shown.label).join("; ") : undefined}><Badge tone={shown.tone}>{shown.label}</Badge></span></Td>
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
