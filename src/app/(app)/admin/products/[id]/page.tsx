import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, loanProducts, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { listPolicyVersions } from "@/server/services/policies";
import { parsePolicy, POLICY_FIELD_LABELS, type PolicyParameters } from "@/lib/finance/policy";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, PageHeader, MENU_ACTION, MENU_FORM, Stat, StatGrid, StatusBadge, Badge, DateText, Table, Tabs, Th, Td } from "@/components/ui";
import { RowMenu } from "@/components/row-menu";
import { formatNaira } from "@/lib/finance/money";
import { setProductActiveAction, newPolicyDraftAction, savePolicyDraftAction, submitPolicyAction, approvePolicyAction, activatePolicyAction, rejectPolicyAction, retirePolicyAction, updateProductDetailsAction, deleteProductAction, discardDraftAction } from "@/app/actions/admin";
import { PolicyEditor } from "@/components/policy-editor";

export const metadata = { title: "Product policy" };

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
const versionStatus = (s: string) => (s === "pending_approval" ? "pending_confirmation" : s);

export default async function ProductPolicy({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ version?: string; tab?: string }> }) {
  const actor = await requireActor("admin.policy.manage", "admin.policy.approve");
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const [product] = await db.select().from(loanProducts).where(eq(loanProducts.id, id));
  if (!product) notFound();
  const versions = await listPolicyVersions(db, id);
  const people = new Map((await db.select({ id: users.id, n: users.displayName }).from(users)).map((u) => [u.id, u.n]));
  const selected = versions.find((v) => v.id === sp.version) ?? versions.find((v) => v.status === "draft" || v.status === "pending_approval") ?? versions.find((v) => v.status === "active") ?? versions[0];
  const p = selected ? parsePolicy(selected.parameters) : null;
  const editable = !!selected && (selected.status === "draft" || selected.status === "rejected") && can(actor, "admin.policy.manage");
  const canApprove = selected?.status === "pending_approval" && can(actor, "admin.policy.approve");
  const hasDraft = versions.some((v) => v.status === "draft" || v.status === "pending_approval");
  const manage = can(actor, "admin.policy.manage");
  const [used] = await db.select({ id: loanApplications.id }).from(loanApplications).where(eq(loanApplications.productId, id)).limit(1);

  const tab = sp.tab === "versions" || sp.tab === "settings" ? sp.tab : "policy";
  const base = `/admin/products/${id}${sp.version ? `?version=${sp.version}` : ""}`;
  const activeVersion = versions.find((v) => v.status === "active");

  return (
    <>
      <PageHeader title={product.name} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Products", href: "/admin/products" }, { label: product.name }]} description={product.description}
        actions={<>
          {product.isActive ? <Badge tone="success">Open for applications</Badge> : <Badge>Closed</Badge>}
          {manage && !hasDraft && <ActionForm inline action={newPolicyDraftAction.bind(null, id, null)} submitLabel="New policy version" submitClassName="btn-primary" />}
        </>} />
      <Tabs base={base} active={tab} tabs={[{ key: "policy", label: "Policy" }, { key: "versions", label: "Version history", count: versions.length }, { key: "settings", label: "Product settings" }]} />

      {tab === "policy" && selected && p && (
        <>
          {selected.status === "pending_approval" && <div className="mb-6"><Alert tone="warning" title="Awaiting approval">Review the terms below, then approve to make this version active.</Alert></div>}
          {editable ? (
            <div className="space-y-6">
              <PolicyEditor initial={p} changeNote={selected.changeNote ?? ""} action={savePolicyDraftAction.bind(null, selected.id)} productName={product.name} />
              <Card>
                {can(actor, "admin.policy.approve") ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted">Save the draft first, then activate it. New applications use it from then on; existing loans keep their terms.</p>
                    <ActionForm action={activatePolicyAction.bind(null, selected.id)} submitLabel="Activate" variant="primary" confirm="Activate this policy version now? New applications will use it." />
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-muted">Save the draft first. Once submitted, an administrator who approves policies can activate it.</p>
                    <ActionForm action={submitPolicyAction.bind(null, selected.id)} submitLabel="Submit for approval" variant="primary" confirm="Submit this policy version for approval? You will not be able to edit it while pending." />
                  </div>
                )}
              </Card>
            </div>
          ) : (
            <>
              <StatGrid>
                <Stat label="Interest" value={p.interestMethod === "interest_free" ? "Interest free" : `${p.annualInterestRate}% a year`} hint={p.interestMethod === "interest_free" ? undefined : sentence(p.interestMethod)} />
                <Stat label="Tenor" value={p.minTenorMonths === p.maxTenorMonths ? months(p.maxTenorMonths) : `${p.minTenorMonths} to ${months(p.maxTenorMonths)}`} />
                <Stat label="Deduction limit" value={`${p.maxDeductionPercent}%`} hint="Of net pay" />
                <Stat label="Guarantors" value={p.requiredGuarantors} />
              </StatGrid>
              <Card title={`Policy version ${selected.version}`} description={selected.status === "active" ? "Active versions cannot be edited. Start a new version to make changes." : selected.changeNote ?? undefined}
                actions={<StatusBadge status={versionStatus(selected.status)} />}>
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
                {canApprove && (
                  <div className="mt-5 flex flex-wrap items-start gap-4 border-t border-line pt-4">
                    <ActionForm action={approvePolicyAction.bind(null, selected.id)} submitLabel="Approve & activate" variant="success" confirm="Activate this policy for all new applications?" />
                    <ActionForm action={rejectPolicyAction.bind(null, selected.id)} submitLabel="Reject" variant="secondary"><label htmlFor="rej" className="sr-only">Reason</label><input id="rej" name="reason" required placeholder="Reason" className="input" /></ActionForm>
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}

      {tab === "versions" && (
        <Card bodyClassName="p-5 py-0">
          <Table caption="Policy versions">
            <thead><tr><Th>Version</Th><Th>Status</Th><Th>Change note</Th><Th>Record</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <Td className="font-medium">Version {v.version}</Td>
                  <Td><StatusBadge status={versionStatus(v.status)} /></Td>
                  <Td className="min-w-64 text-muted whitespace-normal!">{v.changeNote || "-"}</Td>
                  <Td className="text-muted">{v.approvedAt ? <>Approved <DateText value={v.approvedAt} />{v.approvedBy ? <> by {people.get(v.approvedBy)}</> : " at installation"}</> : <>Created by {people.get(v.createdBy ?? "")}</>}</Td>
                  <Td right>
                    <RowMenu label={`version ${v.version}`} items={[{ label: "View", href: `/admin/products/${id}?version=${v.id}` }]}>
                      {manage && !hasDraft && <ActionForm inline className={MENU_FORM} action={newPolicyDraftAction.bind(null, id, v.id)} submitLabel="New draft" submitClassName={MENU_ACTION} />}
                      {manage && (v.status === "draft" || v.status === "rejected") && <ActionForm inline className={MENU_FORM} action={discardDraftAction.bind(null, v.id)} submitLabel="Discard" submitClassName={`${MENU_ACTION} text-danger`} confirm={`Discard draft version ${v.version}? This cannot be undone.`} />}
                    </RowMenu>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === "settings" && (
        <div className="max-w-3xl space-y-6">
          {manage && (
            <Card title="Product details">
              <ActionForm action={updateProductDetailsAction.bind(null, id)} submitLabel="Save details">
                <label htmlFor="p-name" className="label">Name</label><input id="p-name" name="name" defaultValue={product.name} required minLength={3} maxLength={150} className="input" />
                <label htmlFor="p-desc" className="label mt-3">Description</label><textarea id="p-desc" name="description" rows={3} defaultValue={product.description ?? ""} maxLength={300} className="input" />
                <p className="hint">Code {product.code} cannot change.</p>
              </ActionForm>
            </Card>
          )}
          <Card title="Manage product" bodyClassName="p-0!">
            <ul className="divide-y divide-line">
              {manage && (
                <li className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="max-w-md"><p className="text-sm font-medium">{product.isActive ? "Close product" : "Open product"}</p><p className="text-xs text-muted">{product.isActive ? "Stops new applications. Existing applications and loans are unaffected." : "Lets staff apply for this product."}</p></div>
                  <ActionForm inline action={setProductActiveAction.bind(null, id, !product.isActive)} submitLabel={product.isActive ? "Close product" : "Open product"} submitClassName="btn-secondary" confirm={product.isActive ? "Close this product to new applications? Existing applications and loans are unaffected." : undefined} />
                </li>
              )}
              {activeVersion && can(actor, "admin.policy.approve") && (
                <li className="px-5 py-4">
                  <p className="text-sm font-medium">Deactivate policy</p>
                  <p className="text-xs text-muted">Retires version {activeVersion.version} and closes the product to new applications. Existing loans are unaffected.</p>
                  <ActionForm inline action={retirePolicyAction.bind(null, activeVersion.id)} submitLabel="Deactivate policy" submitClassName="btn-secondary text-danger" className="mt-3 flex flex-wrap gap-2" confirm="Deactivate this policy and close the product to new applications?">
                    <label htmlFor="retire-reason" className="sr-only">Reason</label><input id="retire-reason" name="reason" required minLength={5} placeholder="Reason" className="input min-w-0 flex-1" />
                  </ActionForm>
                </li>
              )}
              {manage && (
                <li className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div className="max-w-md"><p className="text-sm font-medium">Delete product</p><p className="text-xs text-muted">{used ? "This product has applications on record, so it cannot be deleted. Close it to stop new applications." : "Removes the product and all its policy versions. This cannot be undone."}</p></div>
                  {!used && <ActionForm inline action={deleteProductAction.bind(null, id)} submitLabel="Delete product" submitClassName="btn-danger" confirm={`Delete ${product.name} and all its policy versions? This cannot be undone.`} />}
                </li>
              )}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
