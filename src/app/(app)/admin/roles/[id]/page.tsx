import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { roleMatrix } from "@/server/services/admin";
import { ActionForm } from "@/components/action-form";
import { Switch } from "@/components/switch";
import { Badge, Card, PageHeader, Tabs } from "@/components/ui";
import { deleteRoleAction, setRolePermissionsAction, updateRoleDetailsAction } from "@/app/actions/admin";
import { LOCKED_SUPER_ADMIN_PERMISSIONS, PERMISSION_CATEGORIES, PERMISSIONS, type Permission } from "@/lib/auth/permissions";

export const metadata = { title: "Manage role" };

export default async function ManageRole({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireActor("admin.roles.manage");
  const { id } = await params;
  const { tab } = await searchParams;
  const { roles, permissions, grants, holders } = await roleMatrix(await getDb(), actor);
  const role = roles.find((r) => r.id === id);
  if (!role) notFound();
  const superAdmin = role.code === "SUPER_ADMIN";
  const categories = PERMISSION_CATEGORIES.filter((c) => permissions.some((p) => p.category === c));
  const granted = (list: typeof permissions) => list.filter((p) => grants.has(`${role.id}:${p.id}`)).length;
  const users = holders(role.id);
  return (
    <>
      <PageHeader title={role.name} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Roles", href: "/admin/roles" }, { label: role.name }]} description={role.description ?? undefined}
        actions={<>
          {role.isSystem ? <Badge>Built-in</Badge> : <Badge tone="info">Custom</Badge>}
          <Badge>{users} active {users === 1 ? "user" : "users"}</Badge>
        </>} />
      <Tabs base={`/admin/roles/${role.id}`} active={tab === "details" ? "details" : "permissions"} tabs={[{ key: "permissions", label: "Permissions", count: granted(permissions) }, { key: "details", label: "Role details" }]} />
      {tab === "details" ? (
        <div className="max-w-2xl space-y-6">
          <Card title="Role details">
            <ActionForm action={updateRoleDetailsAction.bind(null, role.id)} submitLabel="Save details">
              <label htmlFor="name" className="label">Title</label>
              <input id="name" name="name" defaultValue={role.name} required minLength={2} maxLength={60} className="input" />
              <label htmlFor="description" className="label mt-3">Description</label>
              <textarea id="description" name="description" defaultValue={role.description ?? ""} rows={3} maxLength={200} className="input" />
              <p className="hint">Shown across menus, dashboards and printed forms.</p>
            </ActionForm>
          </Card>
          {!role.isSystem && (
            <Card title="Delete role">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="max-w-md text-sm text-muted">{users ? "Remove this role from every user before deleting it." : "Removes this role. This cannot be undone."}</p>
                <ActionForm inline action={deleteRoleAction.bind(null, role.id)} submitLabel="Delete role" submitClassName="btn-danger" confirm={`Delete the ${role.name} role?`} />
              </div>
            </Card>
          )}
        </div>
      ) : (
        <Card bodyClassName="p-0!">
          <ActionForm action={setRolePermissionsAction.bind(null, role.id)} submitLabel="Save permissions" className="pb-5 [&>div:last-child]:px-5 [&>[role=alert]]:mx-5 [&>[role=status]]:mx-5">
            {superAdmin && <p className="border-b border-line px-5 py-3 text-sm text-muted">Locked permissions keep administrators from being locked out, and keep financial duties separate.</p>}
            <div className="divide-y divide-line border-b border-line">
              {categories.map((c) => {
                const list = permissions.filter((p) => p.category === c);
                const n = granted(list);
                return (
                  <details key={c} open={n > 0} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                      <ChevronRight aria-hidden className="h-4 w-4 text-muted transition-transform group-open:rotate-90" />
                      <span className="text-sm font-semibold text-ink">{c}</span>
                      <span className="tabular ml-auto text-xs text-muted">{n} of {list.length}</span>
                    </summary>
                    <div className="grid gap-x-8 gap-y-1 px-5 pb-4 pl-11 md:grid-cols-2">
                      {list.map((p) => {
                        const locked = superAdmin && (LOCKED_SUPER_ADMIN_PERMISSIONS.includes(p.code as Permission) || p.code === "transaction.approve");
                        return (
                          <label key={p.id} className={`flex items-center gap-3 rounded-md py-1.5 text-sm ${locked ? "text-muted" : "cursor-pointer"}`}>
                            <Switch name="perm" value={p.code} defaultChecked={grants.has(`${role.id}:${p.id}`)} disabled={locked} />
                            <span>{PERMISSIONS[p.code as Permission]?.description ?? p.description}{locked && " (locked)"}</span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
