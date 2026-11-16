import { ChevronRight } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { roleMatrix } from "@/server/services/admin";
import { ActionForm } from "@/components/action-form";
import { Switch } from "@/components/switch";
import { Card, PageHeader } from "@/components/ui";
import { createRoleAction } from "@/app/actions/admin";
import { PERMISSION_CATEGORIES, PERMISSIONS, IMPLIED_PERMISSIONS, type Permission } from "@/lib/auth/permissions";

export const metadata = { title: "New role" };

export default async function NewRole({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const actor = await requireActor("admin.roles.manage");
  const { from } = await searchParams;
  const { roles, permissions, grants } = await roleMatrix(await getDb(), actor);
  const base = roles.find((r) => r.id === from);
  const categories = PERMISSION_CATEGORIES.filter((c) => permissions.some((p) => p.category === c));
  return (
    <>
      <PageHeader title="New role" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Roles", href: "/admin/roles" }, { label: "New role" }]}
        description="Give the role a title and description, then choose what people with it may do." />
      <Card title="Start from an existing role" className="mb-6 max-w-3xl" description="Optional: tick the same permissions as another role, then adjust them below.">
        <form className="flex flex-wrap items-end gap-2" method="get">
          <div className="min-w-56 flex-1">
            <label htmlFor="from" className="sr-only">Start from</label>
            <select id="from" name="from" className="input" defaultValue={base?.id ?? ""}>
              <option value="">No permissions</option>
              {roles.map((r) => <option key={r.id} value={r.id}>Same as {r.name}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-secondary">Apply</button>
        </form>
      </Card>
      <Card bodyClassName="p-0!" className="max-w-3xl">
        <ActionForm key={base?.id ?? "none"} action={createRoleAction} submitLabel="Create role" confirm="Create this role with the permissions ticked?"
          className="pb-5 [&>[role=alert]]:mx-5 [&>[role=status]]:mx-5" footerClassName="px-5">
          <div className="grid gap-3 border-b border-line p-5">
            <div>
              <label htmlFor="name" className="label">Title</label>
              <input id="name" name="name" required minLength={2} maxLength={60} className="input" />
            </div>
            <div>
              <label htmlFor="description" className="label">Description</label>
              <textarea id="description" name="description" rows={2} maxLength={200} className="input" />
              <p className="hint">Shown across menus, dashboards and printed forms.</p>
            </div>
          </div>
          <input type="hidden" name="withPermissions" value="1" />
          <h2 className="px-5 pt-4 text-sm font-semibold text-ink">Permissions</h2>
          <p className="px-5 pb-2 text-xs text-muted">{base ? `Ticked as for ${base.name}.` : "None ticked yet."} Everyone given this role may do what is ticked. Open a group to see its permissions.</p>
          <div className="divide-y divide-line border-y border-line">
            {categories.map((c) => (
              <details key={c} className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden className="h-4 w-4 text-muted transition-transform group-open:rotate-90" />
                  <span className="text-sm font-semibold text-ink">{c}</span>
                  <span className="tabular ml-auto text-xs text-muted">{permissions.filter((p) => p.category === c).length} permissions</span>
                </summary>
                <div className="grid gap-x-8 gap-y-1 px-5 pb-4 pl-11 md:grid-cols-2">
                  {permissions.filter((p) => p.category === c).map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-md py-1.5 text-sm">
                      <Switch name="perm" value={p.code} defaultChecked={!!base && grants.has(`${base.id}:${p.id}`)} />
                      <span>{PERMISSIONS[p.code as Permission]?.description ?? p.description}{IMPLIED_PERMISSIONS[p.code as Permission] && <span className="block text-xs text-muted">Includes: {IMPLIED_PERMISSIONS[p.code as Permission]!.map((c) => PERMISSIONS[c].description).join("; ")}</span>}</span>
                    </label>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
