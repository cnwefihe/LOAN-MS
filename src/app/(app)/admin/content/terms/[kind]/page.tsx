import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { termsDocuments } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, DateText, PageHeader, Table, Th, Td } from "@/components/ui";
import { publishTermsAction } from "@/app/actions/admin";

export const metadata = { title: "Edit terms" };

const LABELS = { loan_terms: "Loan terms & conditions", guarantor_agreement: "Guarantor agreement" } as const;

export default async function EditTerms({ params }: { params: Promise<{ kind: string }> }) {
  await requireActor("admin.content.manage");
  const { kind } = await params;
  if (kind !== "loan_terms" && kind !== "guarantor_agreement") notFound();
  const db = await getDb();
  const list = await db.select().from(termsDocuments).where(eq(termsDocuments.kind, kind)).orderBy(desc(termsDocuments.version));
  const active = list.find((t) => t.isActive);
  return (
    <>
      <PageHeader title={LABELS[kind]} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Templates", href: "/admin/content" }, { label: LABELS[kind] }]} />
      {active?.body.includes("[PLACEHOLDER") && <div className="mb-6"><Alert tone="warning" title="Placeholder text">Replace with the approved institutional text before go-live.</Alert></div>}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Card title="Current text" description="Publishing creates a new version. It applies to new submissions only." className="xl:col-span-2">
          <ActionForm action={publishTermsAction} submitLabel="Publish as new version" confirm="Publish this version? It applies to new submissions only.">
            <input type="hidden" name="kind" value={kind} />
            <label htmlFor="title" className="label">Title</label><input id="title" name="title" defaultValue={active?.title} required className="input" />
            <label htmlFor="body" className="label mt-3">Text</label><textarea id="body" name="body" rows={18} defaultValue={active?.body} required className="input text-sm" />
          </ActionForm>
        </Card>
        <Card title="Version history" bodyClassName="px-5 py-0">
          <Table caption="Version history">
            <thead><tr><Th>Version</Th><Th>Published</Th><Th>Status</Th></tr></thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium">Version {t.version}</Td>
                  <Td><DateText value={t.createdAt} /></Td>
                  <Td>{t.isActive ? <Badge tone="success">Active</Badge> : <Badge>Replaced</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
