import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanAccounts } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { getGuaranteeForGuarantor, guarantorCoverInputs, guarantorExposure, GUARANTOR_RELATIONSHIPS } from "@/server/services/guarantors";
import { getStaffRecord } from "@/server/services/staff";
import { getApplicationDetail } from "@/server/services/applications";
import { getActiveTerms } from "@/server/services/policies";
import { listDocumentsFor } from "@/server/services/documents";
import { instalmentLabel, type EligibilityResult } from "@/lib/finance/calculator";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, KeyValues, Money, PageHeader, StatusBadge, DateText } from "@/components/ui";
import { DocumentList, MessageThread, UploadForm } from "@/components/panels";
import { GuarantorAccept } from "@/components/guarantor-accept";
import { respondGuaranteeAction, uploadGuarantorDocumentAction } from "@/app/actions/guarantor";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Guarantor request" };

export default async function GuaranteeRequest({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("guarantee.view_own");
  const { id } = await params;
  const db = await getDb();
  const g = await getGuaranteeForGuarantor(db, actor, id).catch(() => null);
  if (!g) notFound();
  const d = await getApplicationDetail(db, actor, g.applicationId).catch(() => null);
  const terms = await getActiveTerms(db, "guarantor_agreement");
  const exp = await guarantorExposure(db, actor.userId);
  const [loan] = await db.select().from(loanAccounts).where(eq(loanAccounts.applicationId, g.applicationId));
  if (!d) {
    return <Alert tone="info" title="This request is closed">Your response ({g.status}) has been recorded and the application is no longer active.</Alert>;
  }
  const quote = (d.app.quote as unknown as EligibilityResult).quote;
  const docs = await listDocumentsFor(db, actor, { applicationId: g.applicationId });
  const open = ["pending", "clarification_requested"].includes(g.status) && d.app.status === "pending_guarantor";
  const p = d.applicant.profile;
  const me = await getStaffRecord(db, actor.userId);
  const cover = await guarantorCoverInputs(db, actor.userId, g.id);

  return (
    <>
      <PageHeader title={`Guarantee request: ${d.applicant.user.displayName}`} crumbs={[{ label: "Guarantor", href: "/guarantor" }, { label: d.app.reference }]}
        actions={<><StatusBadge status={g.status} />{loan && <Link href={`/loans/${loan.id}`} className="btn-secondary">View loan</Link>}</>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Your obligation">
            <p className="text-xs uppercase tracking-wide text-muted">Amount you would guarantee</p>
            <p className="tabular text-3xl font-semibold text-navy"><Money value={g.guaranteedAmount} /></p>
            <p className="mt-1 text-sm text-muted">If {d.applicant.user.displayName} defaults, the University may recover up to this amount (or your share of what remains outstanding) from your salary or entitlements.</p>
            <div className="mt-4">
              <KeyValues columns={3} items={[
                ["Loan amount requested", <Money key="a" value={d.app.requestedAmount} />], ["Tenor", `${monthsText(d.app.tenorMonths)}`], [`Expected ${instalmentLabel(quote?.periodMonths).toLowerCase()}`, <Money key="m" value={quote?.monthlyInstalment} />],
                ["Total repayable by borrower", <Money key="t" value={quote?.totalRepayable} />], ["Number of guarantors", d.policy.params.requiredGuarantors], ["Your existing exposure", <Money key="e" value={exp.total} />],
              ]} />
            </div>
          </Card>
          <Card title="Applicant's details">
            <KeyValues columns={3} items={[
              ["Full name", d.applicant.user.displayName], ["Loan amount applied for", <Money key="a" value={d.app.requestedAmount} />], ["Department", d.applicant.department?.name],
              ["Phone number", p?.phone ?? "Not given"], ["Email address", d.applicant.user.email], ["Residential address", p?.residentialAddress ?? "Not given"],
              ["Designation", p?.designation], ["Length of service", `${monthsText(d.applicant.serviceMonths)}`], ["Purpose", d.app.purpose],
            ]} />
          </Card>
          <Card title="Supporting documents"><DocumentList docs={docs} /></Card>
          {open && terms && (
            <Card title="Your decision">
              <h3 className="text-sm font-semibold">{terms.title} (version {terms.version})</h3>
              <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-slate-50 p-3 text-sm" tabIndex={0} aria-label="Guarantor agreement text">{terms.body}</div>
              <div className="mt-6 grid gap-6 lg:grid-cols-3">
                <div className="lg:col-span-3">
                  <GuarantorAccept action={respondGuaranteeAction.bind(null, id)} policy={d.policy.params} cover={cover} payslipOnFile={cover.uploaded}
                    applicantName={d.applicant.user.displayName} guaranteedAmount={g.guaranteedAmount} termsVersion={terms.version} relationships={GUARANTOR_RELATIONSHIPS}
                    phone={me.profile?.phone ?? ""} name={actor.displayName} details={`Department: ${me.department?.name ?? "Not recorded"} · Email: ${actor.email}`} />
                </div>
                <div className="rounded-md border border-line p-4 lg:col-span-2">
                  <h4 className="text-sm font-semibold">Ask the applicant a question</h4>
                  <ActionForm action={respondGuaranteeAction.bind(null, id)} submitLabel="Request clarification" variant="secondary">
                    <input type="hidden" name="decision" value="clarify" />
                    <label htmlFor="question" className="sr-only">Your question</label>
                    <textarea id="question" name="question" rows={3} required className="input mt-2" />
                  </ActionForm>
                </div>
                <div className="rounded-md border border-red-200 p-4">
                  <h4 className="text-sm font-semibold text-danger">Decline</h4>
                  <ActionForm action={respondGuaranteeAction.bind(null, id)} submitLabel="Decline" variant="danger" confirm="Decline this guarantor request?">
                    <input type="hidden" name="decision" value="decline" />
                    <label htmlFor="reason" className="sr-only">Reason</label>
                    <textarea id="reason" name="reason" rows={3} required placeholder="Brief reason" className="input mt-2" />
                  </ActionForm>
                </div>
              </div>
            </Card>
          )}
          {g.status === "accepted" && (
            <Card title="Your acknowledgement">
              <KeyValues items={[["Signed as", g.acknowledgedName], ["Account", g.acknowledgedEmail], ["When", <DateText key="w" value={g.respondedAt} withTime />], ["Agreement version", g.agreementVersion], ["IP address", g.acknowledgedIp], ["Fingerprint (SHA-256)", <code key="h" className="break-all text-xs">{g.acknowledgementHash}</code>]]} />
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Messages with the applicant"><MessageThread messages={d.messages.filter((m) => m.msg.kind === "clarification")} /></Card>
          <Card title="Your supporting documents" description="Optional: for example, if Human Resources asks for evidence of your capacity.">
            <UploadForm action={uploadGuarantorDocumentAction.bind(null, id)} defaultTitle="Guarantor supporting document" />
          </Card>
        </div>
      </div>
    </>
  );
}

