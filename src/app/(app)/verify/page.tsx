import Link from "next/link";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { canVerifyDocuments, findByReference, findBySha } from "@/server/services/verification";
import { ActionForm } from "@/components/action-form";
import { Card, PageHeader, Table, Th, Td, DateText } from "@/components/ui";
import { verifyDocumentAction } from "@/app/actions/verify";
import { redirect } from "next/navigation";

export const metadata = { title: "Authenticate" };

const KIND: Record<string, string> = {
  loan_agreement: "Loan agreement", guarantor_agreement: "Guarantor agreement", disbursement_advice: "Disbursement advice", receipt: "Repayment receipt",
  statement: "Loan statement", clearance_letter: "Clearance letter", report: "Report export", sample: "Branding sample (not valid)",
};

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ sha?: string; ref?: string; name?: string }> }) {
  const actor = await requireActor();
  if (!canVerifyDocuments(actor)) redirect("/forbidden");
  const sp = await searchParams;
  const db = await getDb();
  const bySha = sp.sha ? await findBySha(db, actor, sp.sha) : null;
  const byRef = sp.ref ? await findByReference(db, actor, sp.ref) : null;
  const rows = bySha ?? byRef ?? [];

  return (
    <>
      <PageHeader title="Authenticate" description="Check that a PDF issued by this system is genuine and has not been changed." />
      <div className="mb-6 rounded-lg border border-line bg-white px-5 py-4 text-sm text-slate-700">
        <p className="font-semibold text-ink">How it works</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Every PDF this system issues (loan agreements, guarantor forms, receipts, statements, clearance letters and reports) carries a reference such as LMS-261101-007, and its digital fingerprint is recorded when it is issued.</li>
          <li><b className="text-ink">Check a PDF file</b> when someone presents a copy: a match proves it is the document the system issued, unchanged. An edited or made-up copy will not match.</li>
          <li><b className="text-ink">Look up a reference</b> for a printed copy: compare the name, loan and date the system recorded with what is on the paper.</li>
          <li>Documents staff upload, such as payslips, are not checked here; they are reviewed on the application.</li>
        </ul>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Check a PDF file" description="Upload the PDF you were given. It is compared, not stored.">
          <ActionForm action={verifyDocumentAction} encType="multipart/form-data" submitLabel="Check file">
            <label htmlFor="document" className="label">PDF document</label>
            <input id="document" name="document" type="file" accept="application/pdf,.pdf" required className="input py-1.5" />
          </ActionForm>
        </Card>
        <Card title="Look up a document reference" description="Enter the reference shown on the document, e.g. LMS-261101-007.">
          <form action="/verify" method="get">
            <label htmlFor="ref" className="label">Document reference</label>
            <input id="ref" name="ref" defaultValue={sp.ref ?? ""} required pattern="[Ll][Mm][Ss]-\d{6}-\d{3,}" placeholder="LMS-261101-007" className="input" />
            <div className="mt-4"><button type="submit" className="btn-primary">Look up</button></div>
          </form>
        </Card>
      </div>

      {bySha && (
        <div className="mt-6" role="status">
          {bySha.length ? (
            <div className="flex gap-3 rounded-lg border border-green-300 bg-success-50 p-4 text-green-900">
              <ShieldCheck aria-hidden className="h-6 w-6 shrink-0" />
              <div><p className="font-semibold">Genuine and unaltered</p><p className="text-sm">{sp.name ? `"${sp.name}" is` : "This file is"} identical to document {bySha[0].reference}, issued by this system on <DateText value={bySha[0].issuedAt} />.</p></div>
            </div>
          ) : (
            <div className="flex gap-3 rounded-lg border border-red-300 bg-danger-50 p-4 text-red-900">
              <ShieldAlert aria-hidden className="h-6 w-6 shrink-0" />
              <div><p className="font-semibold">Not recognised</p><p className="text-sm">{sp.name ? `"${sp.name}"` : "This file"} does not match any document issued by this system. It may have been altered, re-saved or printed to PDF again, or it was not produced here. Ask for the original file, or look up its reference to see what was issued.</p></div>
            </div>
          )}
        </div>
      )}
      {byRef && !byRef.length && <p role="status" className="mt-6 rounded-md border border-line bg-white p-4 text-sm">No document with reference {sp.ref} has been issued.</p>}

      {rows.length > 0 && (
        <Card title="Register entry" className="mt-6" bodyClassName="p-0">
          <Table caption="Issued document register">
            <thead><tr><Th>Reference</Th><Th>Document</Th><Th>Concerning</Th><Th>Loan</Th><Th>Issued</Th><Th>Issued to</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.reference}>
                <Td className="font-mono text-xs">{r.reference}</Td><Td>{KIND[r.kind] ?? r.kind}<span className="block text-xs text-muted">{r.title}</span></Td>
                <Td>{r.subjectName ?? "Not applicable"}</Td>
                <Td>{r.accountNumber && r.loanAccountId ? <Link className="link" href={`/accounts/loans/${r.loanAccountId}`}>{r.accountNumber}</Link> : "Not applicable"}</Td>
                <Td><DateText value={r.issuedAt} /></Td><Td>{r.issuedByName ?? "System"}</Td>
              </tr>
            ))}</tbody>
          </Table>
          {byRef && byRef.length > 0 && <p className="px-5 py-3 text-xs text-muted">A matching reference does not prove the file is unaltered; check the file itself.</p>}
        </Card>
      )}
    </>
  );
}
