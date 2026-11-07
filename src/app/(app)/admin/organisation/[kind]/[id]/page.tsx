import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { schools, departments, staffCategories, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";
import { saveOrgAction } from "@/app/actions/admin";

export const metadata = { title: "Organisation" };

const KINDS = {
  department: { table: departments, tab: "departments", noun: "department" },
  school: { table: schools, tab: "schools", noun: "school" },
  category: { table: staffCategories, tab: "categories", noun: "category" },
} as const;

const UUID = /^[0-9a-f-]{36}$/i;

/** Adds ("new") or edits a department, school or staff category. */
export default async function OrgRecord({ params }: { params: Promise<{ kind: string; id: string }> }) {
  await requireActor("admin.org.manage");
  const { kind, id } = await params;
  if (kind !== "department" && kind !== "school" && kind !== "category") notFound();
  const isNew = id === "new";
  if (!isNew && !UUID.test(id)) notFound();
  const db = await getDb();
  const { table, tab, noun } = KINDS[kind];
  const [row] = isNew ? [] : await db.select().from(table).where(eq(table.id, id));
  if (!isNew && !row) notFound();
  const dept = kind === "department" ? (row as typeof departments.$inferSelect | undefined) : undefined;
  const [schoolList, staff] = kind === "department"
    ? await Promise.all([
        db.select().from(schools).orderBy(schools.name),
        db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.isActive, true)).orderBy(users.displayName),
      ])
    : [[], []];
  const title = row?.name ?? `New ${noun}`;
  return (
    <>
      <PageHeader title={title} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Organisation", href: `/admin/organisation?tab=${tab}` }, { label: title }]} />
      <Card className="max-w-2xl">
        <ActionForm action={saveOrgAction.bind(null, kind, row?.id ?? null)} submitLabel={isNew ? `Add ${noun}` : "Save changes"}>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div><label htmlFor="name" className="label">Name</label><input id="name" name="name" defaultValue={row?.name} required className="input" /></div>
            <div><label htmlFor="code" className="label">Code</label><input id="code" name="code" defaultValue={row?.code} required className="input" /></div>
          </div>
          {kind === "department" && (
            <>
              <label htmlFor="schoolId" className="label mt-3">School</label>
              <select id="schoolId" name="schoolId" defaultValue={dept?.schoolId ?? ""} className="input"><option value="">Not set</option>{schoolList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="approverTitle" className="label">Approved by</label>
                  <select id="approverTitle" name="approverTitle" defaultValue={dept?.approverTitle ?? "hod"} className="input"><option value="hod">HOD</option><option value="line_manager">Line Manager</option></select>
                </div>
                <div>
                  <label htmlFor="headUserId" className="label">Approver</label>
                  <select id="headUserId" name="headUserId" defaultValue={dept?.headUserId ?? ""} className="input"><option value="">Choose the person</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                </div>
              </div>
              <p className="hint">Approves loan applications from this department after the Bursary Officer.</p>
            </>
          )}
          {!isNew && <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={row?.isActive} className="h-4 w-4 accent-brand" />Active</label>}
        </ActionForm>
      </Card>
    </>
  );
}
