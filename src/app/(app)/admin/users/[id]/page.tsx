import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { searchUsers } from "@/server/services/admin";
import type { RoleCode } from "@/lib/auth/permissions";
import { getWording } from "@/server/wording";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader, Badge, DateText, KeyValues, Table, Th, Td } from "@/components/ui";
import { setUserRoleAction, setUserActiveAction, revokeSessionsAction, resetMfaAction, assignApproverAction, removeApproverAction } from "@/app/actions/admin";
import { departments } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { can } from "@/server/actor";
import { APPROVER_TITLES, type ApproverTitle } from "@/server/wording";

export const metadata = { title: "Manage user" };

export default async function ManageUser({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("admin.users.manage");
  const { id } = await params;
  const db = await getDb();
  const u = (await searchUsers(db, actor)).find((x) => x.id === id);
  if (!u) notFound();
  const w = await getWording(db);
  // HOD and Line Manager are set per department: whoever approves for it.
  const depts = can(actor, "admin.org.manage") ? await db.select().from(departments).where(eq(departments.isActive, true)).orderBy(asc(departments.name)) : [];
  return (
    <>
      <PageHeader title={u.displayName} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Users", href: "/admin/users" }, { label: u.displayName }]} />
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card title="Details">
            <KeyValues items={[
              ["Email", u.email],
              ["Staff no.", u.staff?.staffNumber ?? "-"],
              ["Designation", u.staff?.designation ?? "-"],
              ["Department", u.staff?.department ?? "-"],
              ["Status", <span key="status" className="flex gap-1">{u.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}{u.isDevFixture && <Badge tone="warning">Dev fixture</Badge>}</span>],
              ["Two-step verification", u.mfaEnabledAt ? "On" : "Off"],
              ["Last sign-in", u.lastLoginAt ? <DateText key="login" value={u.lastLoginAt} withTime /> : "Never"],
              ["Staff record", u.staff ? <Link key="staff" className="link" href={`/hr/staff/${u.id}`}>View</Link> : "-"],
            ]} />
          </Card>
          <Card title="Access">
            <div className="flex flex-wrap gap-2">
              {u.id !== actor.userId && <ActionForm inline action={setUserActiveAction.bind(null, u.id, !u.isActive)} submitLabel={u.isActive ? "Deactivate account" : "Reactivate account"} variant={u.isActive ? "danger" : "secondary"} submitClassName={u.isActive ? "btn-danger" : "btn-secondary"} confirm={u.isActive ? `Deactivate ${u.displayName}? Their sessions will be revoked.` : undefined} />}
              <ActionForm inline action={revokeSessionsAction.bind(null, u.id)} submitLabel="Revoke sessions" submitClassName="btn-secondary" />
              {u.mfaEnabledAt && u.id !== actor.userId && <ActionForm inline action={resetMfaAction.bind(null, u.id)} submitLabel="Reset two-step verification" submitClassName="btn-secondary" confirm={`Reset two-step verification for ${u.displayName}? Confirm their identity first.`} />}
            </div>
          </Card>
        </div>
        <Card title="Roles" bodyClassName="px-5 py-0">
          <Table caption="Roles" className="[&_td]:align-middle">
            <thead><tr><Th>Role</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {(Object.keys(w.role) as RoleCode[]).filter((r) => r !== "APPLICANT").map((r) => {
                const has = u.roles.includes(r);
                const name = w.role[r].name;
                return (
                  <tr key={r}>
                    <Td className="font-medium">{name}</Td>
                    <Td>{has ? <Badge tone="success">Assigned</Badge> : <span className="text-muted">Not assigned</span>}</Td>
                    <Td right><ActionForm inline action={setUserRoleAction.bind(null, u.id, r, !has)} submitLabel={has ? "Remove" : "Grant"} submitClassName="btn-secondary h-8 text-xs" confirm={r === "SUPER_ADMIN" ? `${has ? "Remove" : "Grant"} ${name} for ${u.displayName}?` : undefined} /></Td>
                  </tr>
                );
              })}
              {depts.length > 0 && (["hod", "line_manager"] as ApproverTitle[]).map((title) => {
                const mine = depts.filter((d) => d.headUserId === u.id && d.approverTitle === title);
                const label = APPROVER_TITLES[title];
                return (
                  <tr key={title}>
                    <Td className="font-medium">{label}</Td>
                    <Td className="whitespace-normal!" colSpan={2}>
                      {mine.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {mine.map((d) => (
                            <span key={d.id} className="inline-flex items-center gap-1 rounded-full bg-success-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-success ring-1 ring-inset ring-green-200">
                              {d.name}
                              <ActionForm inline action={removeApproverAction.bind(null, u.id, d.id)} submitLabel="×" submitClassName="grid h-4 w-4 place-items-center rounded-full leading-none hover:bg-green-200" confirm={`Remove ${u.displayName} as ${label} of ${d.name}? It will have no approver until you choose another.`} />
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-muted">Not assigned</span>}
                      <ActionForm inline className="mt-2 flex flex-wrap items-center gap-2" action={assignApproverAction.bind(null, u.id, title)} submitLabel="Grant" submitClassName="btn-secondary h-8 text-xs" confirm={`Make ${u.displayName} the ${label} of the chosen department? This replaces its current approver.`}>
                        <label htmlFor={`dept-${title}`} className="sr-only">{label} of</label>
                        <select id={`dept-${title}`} name="departmentId" required defaultValue="" className="input h-8 w-44 py-0 text-xs">
                          <option value="" disabled>Choose department</option>
                          {depts.filter((d) => !(d.headUserId === u.id && d.approverTitle === title)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </ActionForm>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
