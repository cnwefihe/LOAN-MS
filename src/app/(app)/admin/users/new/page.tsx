import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { departmentOptions } from "@/server/services/staff";
import { addUserAction, importUsersAction } from "@/app/actions/user-setup";
import { ActionForm } from "@/components/action-form";
import { Card, Field, PageHeader, Tabs } from "@/components/ui";

export const metadata = { title: "Add users" };

export default async function AddUsers({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireActor("admin.users.manage");
  const tab = (await searchParams).tab === "many" ? "many" : "one";
  const db = await getDb();
  const depts = await departmentOptions(db);
  const approvers = can(actor, "admin.org.manage");
  return (
    <>
      <PageHeader title="Add users" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Users", href: "/admin/users" }, { label: "Add users" }]}
        description="Set staff up before they first sign in. Their account is linked by email when they sign in with their university account." />
      <Tabs base="/admin/users/new" active={tab} tabs={[{ key: "one", label: "One at a time" }, { key: "many", label: "Many at once" }]} />
      {tab === "one" ? (
        <Card title="Add a user" className="max-w-2xl">
          <ActionForm action={addUserAction} submitLabel="Add user" resetOnSuccess listChanges confirm="Add this user?">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name" htmlFor="name"><input id="name" name="name" required maxLength={200} className="input" /></Field>
              <Field label="University email" htmlFor="email"><input id="email" name="email" type="email" required className="input" /></Field>
              <Field label="Department" htmlFor="departmentId">
                <select id="departmentId" name="departmentId" defaultValue="" className="input">
                  <option value="">Not set</option>
                  {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </Field>
              {approvers && (
                <Field label="Approver for the department" htmlFor="approver" hint="Replaces the department's current approver.">
                  <select id="approver" name="approver" defaultValue="" className="input">
                    <option value="">No</option>
                    <option value="hod">HOD</option>
                    <option value="line_manager">Line Manager</option>
                  </select>
                </Field>
              )}
            </div>
          </ActionForm>
          <p className="hint mt-4">Other roles are given from the user&apos;s page in <Link href="/admin/users" className="link">Users</Link>.</p>
        </Card>
      ) : (
        <Card title="Add many at once" className="max-w-3xl"
          description={`One person per line: full name, university email, department${approvers ? ", then HOD or Line Manager for an approver" : ""}. Separate with commas, or paste rows from a spreadsheet. Someone already known is updated.`}>
          <ActionForm action={importUsersAction} submitLabel="Add users" resetOnSuccess confirm="Add these users?">
            <label htmlFor="lines" className="label">Users</label>
            <textarea id="lines" name="lines" rows={10} required className="input font-mono text-xs"
              placeholder={`Ada Obi, ada.obi@example.edu.ng, ${depts[0]?.name ?? "Bursary"}, HOD\nTunde Bello, tunde.bello@example.edu.ng, ${depts[1]?.name ?? depts[0]?.name ?? "Bursary"}`} />
            <p className="hint">The department is matched by its name or code, as in <Link href="/admin/organisation" className="link">Organisation</Link>. Lines that cannot be read are listed and left out.</p>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
