import Link from "next/link";
import { requireActor } from "@/lib/auth/session";
import { importOrganisationAction } from "@/app/actions/user-setup";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";

export const metadata = { title: "Add departments and schools" };

export default async function ImportOrganisation() {
  await requireActor("admin.org.manage");
  return (
    <>
      <PageHeader title="Add departments and schools" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Organisation", href: "/admin/organisation" }, { label: "Add many at once" }]}
        description="Add many departments with their schools in one go." />
      <Card title="Add many at once" className="max-w-3xl"
        description="One department per line: department, school, then HOD or Line Manager for who approves (optional, HOD if left out). Separate with commas, or paste rows from a spreadsheet.">
        <ActionForm action={importOrganisationAction} submitLabel="Add departments" resetOnSuccess confirm="Add these departments and schools?">
          <label htmlFor="lines" className="label">Departments</label>
          <textarea id="lines" name="lines" rows={12} required className="input font-mono text-xs"
            placeholder={"Accounting, School of Management and Social Sciences\nComputer Science, School of Science and Technology\nRegistry, Central Administration, Line Manager"} />
          <p className="hint">Schools not set up yet are created. A department already in <Link href="/admin/organisation" className="link">Organisation</Link> is moved to the school named. Each school&apos;s fund pool pays for loans to staff in its departments. Set the approver for each department afterwards, or when adding users.</p>
        </ActionForm>
      </Card>
    </>
  );
}
