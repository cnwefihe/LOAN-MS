import { Fragment } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { termsDocuments, documentRequirements, notificationTemplates, loanProducts } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { Card, EmptyState, PageHeader, Badge, Tabs, DateText, Table, Th, Td } from "@/components/ui";
import { SearchFilter } from "@/components/search-filter";
import { paginate, Pagination } from "@/components/pagination";
import { RowMenu } from "@/components/row-menu";

export const metadata = { title: "Terms & templates" };

const KINDS = [["loan_terms", "Loan terms & conditions"], ["guarantor_agreement", "Guarantor agreement"]] as const;

const CATEGORIES = ["Accounts", "Applications", "Guarantors", "Loans", "Repayments", "Reminders", "Other"];

function categoryOf(code: string) {
  const area = code.split(".")[0];
  if (area === "account") return "Accounts";
  if (area === "application") return "Applications";
  if (area === "guarantor") return "Guarantors";
  if (area === "loan" || area === "restructure") return "Loans";
  if (area === "repayment") return "Repayments";
  if (area === "reminder") return "Reminders";
  return "Other";
}

/** Shows {{reference}} as a small "Reference" tag, so subjects read as plain sentences. */
function Subject({ text }: { text: string }) {
  return text.split(/(\{\{\w+\}\})/).map((part, i) => {
    const token = part.match(/^\{\{(\w+)\}\}$/)?.[1];
    if (!token) return part;
    const label = token.replace(/([A-Z])/g, " $1").toLowerCase();
    return <span key={i} className="mx-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{label.charAt(0).toUpperCase() + label.slice(1)}</span>;
  });
}

export default async function Content({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; category?: string; page?: string; size?: string }> }) {
  await requireActor("admin.content.manage");
  const { tab = "terms", q, category, page, size } = await searchParams;
  // Edit pages link back here with the same tab, search, filter and page.
  const here = new URLSearchParams(Object.entries({ tab, q, category, page, size }).filter(([, v]) => v) as [string, string][]).toString();
  const back = `?from=${encodeURIComponent(`/admin/content?${here}`)}`;
  const db = await getDb();
  const [terms, reqs, templates, products] = await Promise.all([
    db.select().from(termsDocuments).orderBy(termsDocuments.kind, desc(termsDocuments.version)),
    db.select().from(documentRequirements).orderBy(documentRequirements.label),
    db.select().from(notificationTemplates).orderBy(notificationTemplates.name),
    db.select().from(loanProducts),
  ]);
  const needle = q?.trim().toLowerCase();
  const shown = templates
    .filter((t) => (!needle || `${t.name} ${t.code} ${t.subject}`.toLowerCase().includes(needle)) && (!category || categoryOf(t.code) === category))
    .sort((a, b) => CATEGORIES.indexOf(categoryOf(a.code)) - CATEGORIES.indexOf(categoryOf(b.code)) || a.name.localeCompare(b.name));
  const pg = paginate(shown, page, size);
  return (
    <>
      <PageHeader title="Terms, documents & templates" crumbs={[{ label: "Administration", href: "/admin" }, { label: "Templates" }]}
        description="The wording staff agree to, the documents they upload and the notifications they receive."
        actions={tab === "documents" ? <Link href="/admin/content/documents/new" className="btn-primary h-8 px-3 text-xs"><Plus aria-hidden className="h-3.5 w-3.5" />New requirement</Link> : undefined} />
      <Tabs base="/admin/content" active={tab} tabs={[{ key: "terms", label: "Terms & agreements", count: KINDS.length }, { key: "documents", label: "Document requirements", count: reqs.length }, { key: "templates", label: "Notification templates", count: templates.length }]} />

      {tab === "terms" && (
        <Card bodyClassName="p-5 py-0">
          <Table caption="Terms and agreements">
            <thead><tr><Th>Document</Th><Th>Title</Th><Th>Version</Th><Th>Published</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
            <tbody>
              {KINDS.map(([kind, label]) => {
                const active = terms.find((t) => t.kind === kind && t.isActive);
                return (
                  <tr key={kind}>
                    <Td className="font-medium">{label}</Td>
                    <Td>{active?.title ?? "-"}</Td>
                    <Td>{active ? `Version ${active.version}` : "-"}</Td>
                    <Td>{active ? <DateText value={active.createdAt} /> : "-"}</Td>
                    <Td>{!active ? <Badge tone="warning">None active</Badge> : active.body.includes("[PLACEHOLDER") ? <Badge tone="warning">Placeholder text</Badge> : <Badge tone="success">Active</Badge>}</Td>
                    <Td right><RowMenu label={label} items={[{ label: "Edit", href: `/admin/content/terms/${kind}${back}` }]} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === "documents" && (
        <Card bodyClassName="p-5 py-0">
          {reqs.length === 0 ? <div className="py-5"><EmptyState title="No document requirements" /></div> : (
            <Table caption="Document requirements">
              <thead><tr><Th>Document</Th><Th>Code</Th><Th>Product</Th><Th>Applies to</Th><Th>Required</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
              <tbody>
                {reqs.map((r) => (
                  <tr key={r.id}>
                    <Td className="min-w-64 font-medium whitespace-normal!">{r.label}</Td>
                    <Td className="font-mono text-xs text-muted">{r.code}</Td>
                    <Td>{products.find((p) => p.id === r.productId)?.name ?? "All products"}</Td>
                    <Td>{r.appliesTo === "guarantor" ? "Guarantor" : "Applicant"}</Td>
                    <Td>{r.isRequired ? "Yes" : "No"}</Td>
                    <Td>{r.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                    <Td right><RowMenu label={r.label} items={[{ label: "Edit", href: `/admin/content/documents/${r.id}${back}` }]} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === "templates" && (
        <Card bodyClassName="p-5">
          <SearchFilter q={q} placeholder="Search name or subject" hidden={{ tab: "templates" }}
            filter={{ name: "category", value: category, options: [{ value: "", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c, label: c }))] }} />
          {pg.items.length === 0 ? <EmptyState title="No templates found" description="Try a different search." /> : (
            <Table caption="Notification templates">
              <thead><tr><Th>Template</Th><Th>Subject</Th><Th>Sent by</Th><Th>Status</Th><Th><span className="sr-only">Action</span></Th></tr></thead>
              <tbody>
                {pg.items.map((t, i) => (
                  <Fragment key={t.id}>
                    {(i === 0 || categoryOf(pg.items[i - 1].code) !== categoryOf(t.code)) && <tr><th colSpan={5} scope="colgroup" className="border-b border-line bg-white px-5 pb-2 pt-4 text-left text-xs font-semibold uppercase tracking-wide text-brand">{categoryOf(t.code)}</th></tr>}
                    <tr>
                      <Td className="font-medium">{t.name}</Td>
                      <Td className="max-w-md truncate text-muted"><Subject text={t.subject} /></Td>
                      <Td>{t.sendEmail ? "Email and in-app" : "In-app only"}</Td>
                      <Td>{t.isActive ? <Badge tone="success">Active</Badge> : <Badge>Disabled</Badge>}</Td>
                      <Td right><RowMenu label={t.name} items={[{ label: "Edit", href: `/admin/content/templates/${t.code}${back}` }]} /></Td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </Table>
          )}
          <Pagination data={pg} base="/admin/content" params={{ tab: "templates", q, category }} label="templates" />
        </Card>
      )}
    </>
  );
}
