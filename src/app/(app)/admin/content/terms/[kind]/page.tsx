import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { termsDocuments } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, DateText, PageHeader, Table, Th, Td } from "@/components/ui";
import { publishTermsAction } from "@/app/actions/admin";

export const metadata = { title: "Edit terms" };

import { DEFAULT_PRIVACY_BODY, DEFAULT_PRIVACY_TITLE } from "@/lib/privacy-default";

const LABELS = { loan_terms: "Loan terms & conditions", guarantor_agreement: "Guarantor agreement", privacy_notice: "Privacy notice" } as const;

export default async function EditTerms({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ from?: string }> }) {
  await requireActor("admin.content.manage");
  const { kind } = await params;
  const sp = await searchParams;
  if (kind !== "loan_terms" && kind !== "guarantor_agreement" && kind !== "privacy_notice") notFound();
  const db = await getDb();
  const list = await db.select().from(termsDocuments).where(eq(termsDocuments.kind, kind)).orderBy(desc(termsDocuments.version));
  const active = list.find((t) => t.isActive);
  const privacy = kind === "privacy_notice";
  // The privacy notice starts from the built-in wording, so it can be edited rather than typed from scratch.
  const title = active?.title ?? (privacy ? DEFAULT_PRIVACY_TITLE : undefined);
  const body = active?.body ?? (privacy ? DEFAULT_PRIVACY_BODY : undefined);
  return (
    <>
      <PageHeader title={LABELS[kind]} crumbs={[{ label: "Administration", href: "/admin" }, { label: "Templates", href: (sp.from?.startsWith("/admin/content") ? sp.from : "/admin/content") }, { label: LABELS[kind] }]} />
      {active?.body.includes("[PLACEHOLDER") && <div className="mb-6"><Alert tone="warning" title="Placeholder text">Replace with the approved institutional text before go-live.</Alert></div>}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Card title="Current text" description={privacy ? "Shown on the privacy page. Start a line with ## for a heading or - for a list item. Separate table cells with | (first row is the header). Wrap words in ** for bold. {dpo} is filled in with the DPO email from Settings." : "Publishing creates a new version. It applies to new submissions only."} className="xl:col-span-2">
          <ActionForm action={publishTermsAction} submitLabel="Publish as new version" confirm={privacy ? "Publish this privacy notice? It replaces the one staff see now." : "Publish this version? It applies to new submissions only."}>
            <input type="hidden" name="kind" value={kind} />
            <label htmlFor="title" className="label">Title</label><input id="title" name="title" defaultValue={title} required className="input" />
            <label htmlFor="body" className="label mt-3">Text</label><textarea id="body" name="body" rows={18} defaultValue={body} required className="input text-sm" />
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
