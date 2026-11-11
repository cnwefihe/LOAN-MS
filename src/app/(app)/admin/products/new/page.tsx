import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";
import { createProductAction } from "@/app/actions/admin";

export const metadata = { title: "New product" };

export default async function NewProduct() {
  await requireActor("admin.policy.manage");
  return (
    <>
      <PageHeader title="New product" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Products", href: "/admin/products" }, { label: "New product" }]} />
      <Card className="max-w-2xl">
        <ActionForm action={createProductAction} submitLabel="Create product" confirm="Create this product? It starts closed.">
          <label htmlFor="name" className="label">Name</label>
          <input id="name" name="name" required className="input" />
          <label htmlFor="code" className="label mt-3">Code</label>
          <input id="code" name="code" required pattern="[A-Za-z0-9_\-]{2,30}" className="input" placeholder="e.g. HOUSING" />
          <label htmlFor="description" className="label mt-3">Description</label>
          <textarea id="description" name="description" rows={3} className="input" />
          <p className="hint">Created closed. Set its loan terms and save, then open it.</p>
        </ActionForm>
      </Card>
    </>
  );
}
