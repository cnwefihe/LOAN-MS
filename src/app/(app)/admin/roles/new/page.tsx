import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { roleMatrix } from "@/server/services/admin";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";
import { createRoleAction } from "@/app/actions/admin";

export const metadata = { title: "New role" };

export default async function NewRole() {
  const actor = await requireActor("admin.roles.manage");
  const { roles } = await roleMatrix(await getDb(), actor);
  return (
    <>
      <PageHeader title="New role" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Roles", href: "/admin/roles" }, { label: "New role" }]} />
      <Card className="max-w-2xl">
        <ActionForm action={createRoleAction} submitLabel="Create role" confirm="Create this role?">
          <label htmlFor="name" className="label">Title</label>
          <input id="name" name="name" required minLength={2} maxLength={60} className="input" />
          <label htmlFor="description" className="label mt-3">Description</label>
          <input id="description" name="description" maxLength={200} className="input" />
          <label htmlFor="copyFrom" className="label mt-3">Start from</label>
          <select id="copyFrom" name="copyFrom" className="input" defaultValue="">
            <option value="">No permissions</option>
            {roles.map((r) => <option key={r.id} value={r.id}>Same as {r.name}</option>)}
          </select>
          <p className="hint">You can change the permissions on the next page.</p>
        </ActionForm>
      </Card>
    </>
  );
}
