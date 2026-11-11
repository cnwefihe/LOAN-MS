import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documentRequirements, loanProducts } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";
import { saveRequirementAction } from "@/app/actions/admin";

export const metadata = { title: "Document requirement" };

const UUID = /^[0-9a-f-]{36}$/i;

/** Handles both a new requirement ("new") and an existing one. */
export default async function EditRequirement({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> }) {
  await requireActor("admin.content.manage");
  const { id } = await params;
  const sp = await searchParams;
  const isNew = id === "new";
  if (!isNew && !UUID.test(id)) notFound();
  const db = await getDb();
  const [r] = isNew ? [] : await db.select().from(documentRequirements).where(eq(documentRequirements.id, id));
  if (!isNew && !r) notFound();
  const products = await db.select().from(loanProducts).orderBy(loanProducts.name);
  const title = r?.label ?? "New requirement";
  return (
    <>
      <PageHeader title={title} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Templates", href: (sp.from?.startsWith("/admin/content") ? sp.from : "/admin/content?tab=documents") }, { label: title }]} />
      <Card className="max-w-2xl">
        <ActionForm action={saveRequirementAction.bind(null, r?.id ?? null)} submitLabel={isNew ? "Add requirement" : "Save requirement"} listChanges={!isNew} confirm={isNew ? "Add this document requirement?" : "Save these changes to the document requirement?"}>
          <label htmlFor="label" className="label">Label shown to staff</label>
          <input id="label" name="label" defaultValue={r?.label} required className="input" />
          <label htmlFor="code" className="label mt-3">Code</label>
          <input id="code" name="code" defaultValue={r?.code} required className="input" placeholder="e.g. PAYSLIP" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="productId" className="label">Product</label>
              <select id="productId" name="productId" defaultValue={r?.productId ?? ""} className="input"><option value="">All products</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </div>
            <div>
              <label htmlFor="appliesTo" className="label">Applies to</label>
              <select id="appliesTo" name="appliesTo" defaultValue={r?.appliesTo ?? "applicant"} className="input"><option value="applicant">Applicant</option><option value="guarantor">Guarantor</option></select>
            </div>
          </div>
          <div className="mt-4 flex gap-6 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="isRequired" defaultChecked={r?.isRequired ?? true} className="h-4 w-4 accent-brand" />Required before submission</label>
            {!isNew && <label className="flex items-center gap-2"><input type="checkbox" name="isActive" defaultChecked={r?.isActive} className="h-4 w-4 accent-brand" />Active</label>}
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
