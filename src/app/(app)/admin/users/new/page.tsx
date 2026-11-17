import Link from "next/link";
import { getDb } from "@/db";
import { schools } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
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
  const schoolList = await db.select({ name: schools.name }).from(schools).where(eq(schools.isActive, true)).orderBy(asc(schools.name));
  const approvers = can(actor, "admin.org.manage");
  return (
    <>
      <PageHeader title="Add users" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Users", href: "/admin/users" }, { label: "Add users" }]}
        description="Set up staff before their first sign-in. Accounts link by email." />
      <Tabs base="/admin/users/new" active={tab} tabs={[{ key: "one", label: "One at a time" }, { key: "many", label: "Many at once" }]} />
      {tab === "one" ? (
        <Card title="Add a user" className="max-w-2xl">
          <ActionForm action={addUserAction} submitLabel="Add user" resetOnSuccess listChanges confirm="Add this user?">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name" htmlFor="name"><input id="name" name="name" required maxLength={200} className="input" /></Field>
              <Field label="Work email" htmlFor="email"><input id="email" name="email" type="email" required className="input" /></Field>
              <Field label="Employee code (optional)" htmlFor="staffNumber" hint="Filled from Microsoft at first sign-in if left empty."><input id="staffNumber" name="staffNumber" maxLength={50} className="input" /></Field>
              <Field label="Department" htmlFor="departmentName" hint="Choose one, or type a new name to create it.">
                <input id="departmentName" name="departmentName" list="department-list" maxLength={200} autoComplete="off" className="input" />
                <datalist id="department-list">{depts.map((d) => <option key={d.id} value={d.name} />)}</datalist>
              </Field>
              <Field label="School or faculty (optional)" htmlFor="schoolName" hint="For a new department. Choose one, or type a new name to create it.">
                <input id="schoolName" name="schoolName" list="school-list" maxLength={200} autoComplete="off" className="input" />
                <datalist id="school-list">{schoolList.map((s) => <option key={s.name} value={s.name} />)}</datalist>
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
          description={`One person per line: full name, work email, department, school (optional)${approvers ? ", then HOD or Line Manager for an approver" : ""}. Separate with commas, or paste rows from a spreadsheet. Someone already known is updated.`}>
          <ActionForm action={importUsersAction} submitLabel="Add users" resetOnSuccess confirm="Add these users?">
            <label htmlFor="lines" className="label">Users</label>
            <textarea id="lines" name="lines" rows={10} required className="input font-mono text-xs"
              placeholder={`Ada Obi, ada.obi@example.edu.ng, ${depts[0]?.name ?? "Bursary"}, HOD\nTunde Bello, tunde.bello@example.edu.ng, Library, Central Administration\nKemi Ade, kemi.ade@example.edu.ng, Library`} />
            <p className="hint">Departments and schools are matched by name or code, as in <Link href="/admin/organisation" className="link">Organisation</Link>; any not set up yet are created. Lines that cannot be read are listed and left out.</p>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
