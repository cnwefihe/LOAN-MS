import { requireActor } from "@/lib/auth/session";
import { importGuarantorsAction, saveGuarantorEntryAction } from "@/app/actions/guarantor-pool";
import { ActionForm } from "@/components/action-form";
import { GuarantorFields } from "@/components/guarantor-fields";
import { Card, PageHeader, Tabs } from "@/components/ui";

export const metadata = { title: "Add guarantors" };

export default async function AddGuarantors({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireActor("admin.policy.manage");
  const tab = (await searchParams).tab === "many" ? "many" : "one";
  return (
    <>
      <PageHeader title="Add guarantors" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Guarantors", href: "/admin/guarantors" }, { label: "Add guarantors" }]}
        description="Applicants see names only. The email receives the request." />
      <Tabs base="/admin/guarantors/new" active={tab} tabs={[{ key: "one", label: "One at a time" }, { key: "many", label: "Many at once" }]} />
      {tab === "one" ? (
        <Card title="Add a guarantor" className="max-w-2xl">
          <ActionForm action={saveGuarantorEntryAction.bind(null, null)} submitLabel="Add" resetOnSuccess confirm="Add this person to the list of guarantors?" listChanges>
            <GuarantorFields />
          </ActionForm>
        </Card>
      ) : (
        <Card title="Add many at once" className="max-w-3xl" description="One person per line: full name, then work email. A name already on the list is updated.">
          <ActionForm action={importGuarantorsAction} submitLabel="Add to the list" resetOnSuccess confirm="Add these people to the list of guarantors?">
            <label htmlFor="lines" className="label">Names and emails</label>
            <textarea id="lines" name="lines" rows={10} required className="input font-mono text-xs" placeholder={"Ada Obi, ada.obi@example.edu.ng\nTunde Bello, tunde.bello@example.edu.ng"} />
            <label htmlFor="cadre-many" className="label mt-3">Cadre</label>
            <input id="cadre-many" name="cadre" defaultValue="Managerial" className="input" />
          </ActionForm>
        </Card>
      )}
    </>
  );
}
