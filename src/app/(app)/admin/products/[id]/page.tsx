import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, loanProducts, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { listPolicyVersions } from "@/server/services/policies";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { parsePolicy, POLICY_FIELD_LABELS, type PolicyParameters } from "@/lib/finance/policy";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader, Stat, StatGrid, Badge, DateText, Tabs } from "@/components/ui";
import { formatNaira } from "@/lib/finance/money";
import { setProductActiveAction, saveProductTermsAction, updateProductDetailsAction, deleteProductAction } from "@/app/actions/admin";
import { productSummary } from "@/lib/finance/product-summary";
import { PolicyEditor } from "@/components/policy-editor";

export const metadata = { title: "Product" };

const GROUPS: { title: string; fields: (keyof PolicyParameters)[] }[] = [
  { title: "Eligibility", fields: ["productType", "minServiceMonths", "maxActiveLoans", "eligibleEmploymentStatuses"] },
  { title: "Interest", fields: ["interestMethod", "annualInterestRate"] },
  { title: "Tenor and deduction limit", fields: ["minTenorMonths", "maxTenorMonths", "maxDeductionPercent", "cafeteriaAmount"] },
  { title: "Guarantors", fields: ["requiredGuarantors", "guarantorMinServiceMonths", "guarantorMustBeConfirmed", "maxGuarantorExposure", "maxGuaranteesPerGuarantor"] },
  { title: "Servicing", fields: ["repaymentFrequency", "repaymentDayOfMonth", "gracePeriodMonths", "overdueAfterDays", "defaultAfterDays", "reminderDaysBeforeDue", "allowRestructuring", "maxRestructuredTenorMonths"] },
  { title: "Requirements", fields: ["requiredDocumentCodes"] },
];
const sentence = (s: string) => { const x = s.replace(/_/g, " ").toLowerCase(); return x.charAt(0).toUpperCase() + x.slice(1); };
function display(k: keyof PolicyParameters, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => sentence(String(x))).join(", ") || "N/A";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (k === "cafeteriaAmount" || k === "maxGuarantorExposure") return formatNaira(String(v));
  return typeof v === "string" ? sentence(v) : String(v);
}
const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireActor("admin.policy.manage", "admin.policy.approve");
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [product] = await db.select().from(loanProducts).where(eq(loanProducts.id, id));
  if (!product) notFound();
  const versions = await listPolicyVersions(db, id);
  // The terms in use; a new product starts from the standard terms until they are saved.
  const current = versions.find((v) => v.status === "active") ?? null;
  const p = current ? parsePolicy(current.parameters) : DEFAULT_POLICY;
  const [by] = current?.approvedBy ? await db.select({ n: users.displayName }).from(users).where(eq(users.id, current.approvedBy)) : [];
  const manage = can(actor, "admin.policy.manage");
  const [used] = await db.select({ id: loanApplications.id }).from(loanApplications).where(eq(loanApplications.productId, id)).limit(1);
  const tab = sp.tab === "settings" ? "settings" : "terms";
  const updated = current ? <>Last updated <DateText value={current.effectiveFrom ?? current.approvedAt ?? current.createdAt} />{by ? <> by {by.n}</> : null}.</> : "Not saved yet. Save the terms, then open the product.";

  return (
    <>
      <PageHeader title={product.name} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Products", href: "/admin/products" }, { label: product.name }]} description={current ? productSummary(p) : product.description}
        actions={product.isActive ? <Badge tone="success">Open for applications</Badge> : <Badge>Closed</Badge>} />
      <Tabs base={`/admin/products/${id}`} active={tab} tabs={[{ key: "terms", label: "Loan terms" }, { key: "settings", label: "Product settings" }]} />

      {tab === "terms" && (manage ? (
        <PolicyEditor key={String(current?.effectiveFrom ?? current?.id ?? "new")} initial={p} action={saveProductTermsAction.bind(null, id)} productName={product.name}
          description={<>{updated} Changes apply to new applications at once; loans already taken keep the terms they were approved on.</>} />
      ) : (
        <>
          <StatGrid>
            <Stat label="Interest" value={p.interestMethod === "interest_free" ? "Interest free" : `${p.annualInterestRate}% a year`} hint={p.interestMethod === "interest_free" ? undefined : sentence(p.interestMethod)} />
            <Stat label="Tenor" value={p.minTenorMonths === p.maxTenorMonths ? months(p.maxTenorMonths) : `${p.minTenorMonths} to ${months(p.maxTenorMonths)}`} />
            <Stat label="Deduction limit" value={`${p.maxDeductionPercent}%`} hint="Of net pay" />
            <Stat label="Guarantors" value={p.requiredGuarantors} />
          </StatGrid>
          <Card title="Loan terms" description={updated}>
            <div className="grid gap-x-10 gap-y-6 md:grid-cols-2 2xl:grid-cols-3">
              {GROUPS.map((g) => (
                <section key={g.title}>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand">{g.title}</h3>
                  <dl className="divide-y divide-line text-sm">
                    {g.fields.map((k) => <div key={k} className="flex justify-between gap-4 py-1.5"><dt className="text-muted">{POLICY_FIELD_LABELS[k]}</dt><dd className="text-right font-medium">{display(k, p[k])}</dd></div>)}
                  </dl>
                </section>
              ))}
            </div>
          </Card>
        </>
      ))}

      {tab === "settings" && (
        <div className="max-w-3xl space-y-6">
          {manage && (
            <Card title="Product details">
              <ActionForm action={updateProductDetailsAction.bind(null, id)} submitLabel="Save details" listChanges confirm="Save these changes to the product?">
                <label htmlFor="p-name" className="label">Name</label><input id="p-name" name="name" defaultValue={product.name} required minLength={3} maxLength={150} className="input" />
                <p className="mt-3 text-sm"><span className="font-medium text-ink">Description shown to staff:</span> <span className="text-muted">{productSummary(p)}</span></p>
                <p className="hint">Written from the loan terms, so it changes whenever they do.</p>
                <label htmlFor="p-desc" className="label mt-3">Extra note for staff (optional)</label><textarea id="p-desc" name="description" rows={2} defaultValue={product.description ?? ""} maxLength={300} className="input" />
                <p className="hint">Shown under the description. Do not repeat the terms here. Code {product.code} cannot change.</p>
              </ActionForm>
            </Card>
          )}
          {manage && (
            <Card title="Manage product" bodyClassName="p-0!">
              <ul className="divide-y divide-line">
                <li className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="max-w-md"><p className="text-sm font-medium">{product.isActive ? "Close product" : "Open product"}</p><p className="text-xs text-muted">{product.isActive ? "Stops new applications. Existing applications and loans are unaffected." : "Lets staff apply for this product."}</p></div>
                  <ActionForm inline action={setProductActiveAction.bind(null, id, !product.isActive)} submitLabel={product.isActive ? "Close product" : "Open product"} submitClassName="btn-secondary" confirm={product.isActive ? "Close this product to new applications? Existing applications and loans are unaffected." : "Open this product to applications?"} />
                </li>
                <li className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="max-w-md"><p className="text-sm font-medium">Delete product</p><p className="text-xs text-muted">{used ? "This product has applications on record, so it cannot be deleted. Close it to stop new applications." : "Removes the product. This cannot be undone."}</p></div>
                  {!used && <ActionForm inline action={deleteProductAction.bind(null, id)} submitLabel="Delete product" submitClassName="btn-danger" confirm={`Delete ${product.name}? This cannot be undone.`} />}
                </li>
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
