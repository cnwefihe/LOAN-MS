import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getApplicationDetail, requiredDocumentsFor } from "@/server/services/applications";
import { getActiveTerms } from "@/server/services/policies";
import { listDocumentsFor } from "@/server/services/documents";
import type { EligibilityResult } from "@/lib/finance/calculator";
import { approvalStageName, getWording } from "@/server/wording";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { departmentHeadOf } from "@/server/services/staff";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, KeyValues, Money, PageHeader, StatusBadge, DateText } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { FormDownloads } from "@/components/form-downloads";
import { DocumentList, GuarantorTable, MessageThread, QuoteSummary, UploadForm, WorkflowHistory } from "@/components/panels";
import { submitApplicationAction, cancelApplicationAction, replaceGuarantorAction, postMessageAction, uploadApplicationDocumentAction } from "@/app/actions/applicant";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Application" };

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const db = await getDb();
  const d = await getApplicationDetail(db, actor, id).catch(() => null);
  if (!d) notFound();
  const w = await getWording(db);
  // Guarantors use their own scoped view; this page also shows other guarantors' identities and responses.
  if (!d.access.isApplicant && !d.access.isStaff) {
    const mine = d.guarantors.find((g) => g.user.id === actor.userId);
    if (mine) redirect(`/guarantor/requests/${mine.g.id}`);
    notFound();
  }
  const { app } = d;
  const quote = app.quote as unknown as EligibilityResult;
  const docs = await listDocumentsFor(db, actor, { applicationId: id, loanAccountId: d.loan?.id });
  const editable = d.access.isApplicant && (app.status === "draft" || app.status === "returned");
  const required = editable ? await requiredDocumentsFor(db, app.productId, d.policy.params) : [];
  const uploadedCodes = new Set(docs.filter((x) => x.requirementCode).map((x) => x.requirementCode));
  const missingDocs = required.filter((r) => !uploadedCodes.has(r.code));
  const terms = editable ? await getActiveTerms(db, "loan_terms") : null;
  const cancellable = d.access.isApplicant && ["draft", "pending_guarantor", "pending_hr", "pending_bursary", "returned", "pending_approval"].includes(app.status);
  const liveGuarantors = d.guarantors.filter((g) => !["replaced", "withdrawn"].includes(g.g.status));
  const pendingClarification = d.guarantors.some((g) => g.g.status === "clarification_requested");

  return (
    <>
      <PageHeader title={`Application ${app.reference}`} crumbs={[{ label: "My applications", href: "/applications" }, { label: app.reference }]}
        description={<>{d.product.name} · submitted <DateText value={app.submittedAt} /></>}
        actions={<>
          {(d.access.isApplicant || d.access.isStaff) && <FormDownloads applicationId={app.id} status={app.status} />}
          <StatusBadge status={app.status} />
          {editable && <Link href={`/applications/${id}/edit`} className="btn-secondary">Edit details</Link>}
          {d.loan && <Link href={`/loans/${d.loan.id}`} className="btn-primary">View loan {d.loan.accountNumber}</Link>}
        </>} />

      <Card className="mb-6"><LifecycleTracker applicantId={app.applicantId} appStatus={app.status} loanStatus={d.loan?.status} level={app.currentApprovalLevel} /></Card>

      {app.status === "returned" && <div className="mb-6"><Alert tone="warning" title="Returned for correction">Please read the comments below, update your application and submit it again.</Alert></div>}
      {pendingClarification && d.access.isApplicant && <div className="mb-6"><Alert tone="warning" title="A guarantor has asked a question">Please reply in the Messages section so that they can reach a decision.</Alert></div>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Loan request">
            <KeyValues columns={3} items={[
              ["Product", d.app.advanceType ? `${d.product.name} (against ${ADVANCE_TYPES[d.app.advanceType].toLowerCase()})` : d.product.name], ["Amount requested", <Money key="a" value={app.requestedAmount} />], ["Tenor", `${monthsText(app.tenorMonths)}`],
              ["Policy version", `v${d.policy.version}`], ["Salary basis used", (app.salarySnapshot as { source?: string }).source?.replace("_", " ")], ["Approval stage", app.status === "pending_approval" ? approvalStageName(w, app.currentApprovalLevel || 1, (await departmentHeadOf(db, app.applicantId))?.approverTitle) : "N/A"],
              ["Cooperative loan", app.cooperativeMonthlyDeduction ? <span key="c"><Money value={app.cooperativeMonthlyDeduction} /> a month{app.cooperativeBalance && <>, <Money value={app.cooperativeBalance} /> outstanding</>}</span> : "None declared"],
            ]} />
            <p className="mt-4 text-xs text-muted">Purpose</p>
            <p className="text-sm">{app.purpose}</p>
            <hr className="my-4 border-line" />
            <QuoteSummary quote={quote} />
            {quote.reasons?.length > 0 && editable && <div className="mt-4"><Alert tone="danger" title="Eligibility issues">{quote.reasons.join(" ")}</Alert></div>}
          </Card>

          <Card title="Guarantors" description={`${d.policy.params.requiredGuarantors} required`}>
            {app.status === "draft" || app.status === "returned" ? (
              app.nominatedGuarantors.length ? <ul className="list-disc pl-5 text-sm">{app.nominatedGuarantors.map((e) => <li key={e}>{e}</li>)}</ul> : <p className="text-sm text-muted">No guarantors nominated yet.</p>
            ) : <GuarantorTable guarantors={liveGuarantors} assessments={d.access.isStaff ? d.assessments : undefined} />}
            {d.access.isApplicant && app.status === "pending_guarantor" && d.guarantors.filter((g) => ["declined", "pending", "clarification_requested"].includes(g.g.status)).map((g) => (
              <details key={g.g.id} className="mt-3 rounded-md border border-line p-3">
                <summary className="cursor-pointer text-sm font-medium">Replace {g.user.displayName}{g.g.status === "declined" ? " (declined)" : ""}</summary>
                <ActionForm action={replaceGuarantorAction.bind(null, g.g.id)} submitLabel="Invite replacement" variant="secondary">
                  <label htmlFor={`rep-${g.g.id}`} className="label mt-2">Colleague&apos;s university email address</label>
                  <input id={`rep-${g.g.id}`} name="email" type="email" required className="input" />
                </ActionForm>
              </details>
            ))}
          </Card>

          <Card title="Supporting documents">
            {editable && missingDocs.length > 0 && <div className="mb-4"><Alert tone="warning" title="Required before submission">{missingDocs.map((r) => r.label).join(", ")}</Alert></div>}
            <DocumentList docs={docs} />
            {d.access.isApplicant && ["draft", "returned", "pending_guarantor", "pending_hr"].includes(app.status) && (
              <div className="mt-4 border-t border-line pt-4">
                <UploadForm action={uploadApplicationDocumentAction.bind(null, id)} requirements={required.length ? required : [{ code: "", label: "Supporting document" }]} />
              </div>
            )}
          </Card>

          {editable && terms && (
            <Card title="Terms, conditions and submission" description={`${terms.title}, version ${terms.version}`}>
              <div className="max-h-56 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-slate-50 p-3 text-sm" tabIndex={0} aria-label="Loan terms and conditions">{terms.body}</div>
              <ActionForm action={submitApplicationAction.bind(null, id)} submitLabel={app.status === "returned" ? "Resubmit application" : "Submit application"} confirm="Submit this application? Your guarantors will be notified.">
                <label className="mt-4 flex items-start gap-2 text-sm">
                  <input type="checkbox" name="termsAccepted" required className="mt-1" />
                  <span>I have read and accept the loan terms and conditions (v{terms.version}). I confirm the information provided is accurate and authorise salary deductions for repayment.</span>
                </label>
              </ActionForm>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Messages">
            <MessageThread messages={d.messages} />
            {(d.access.isApplicant || d.access.isGuarantor) && !["approved", "declined", "cancelled"].includes(app.status) && (
              <ActionForm action={postMessageAction.bind(null, id, "clarification")} submitLabel="Send" variant="secondary" resetOnSuccess>
                <label htmlFor="msg" className="label mt-4">Your reply</label>
                <textarea id="msg" name="body" rows={3} required className="input" />
              </ActionForm>
            )}
          </Card>
          <Card title="History"><WorkflowHistory history={d.history} /></Card>
          {d.approvals.length > 0 && (
            <Card title="Decisions">
              <ul className="space-y-3 text-sm">
                {d.approvals.map(({ a, approverName }) => (
                  <li key={a.id}><StatusBadge status={a.decision === "approved" ? "approved" : a.decision === "declined" ? "declined" : "returned"} /> <span className="text-xs text-muted">Level {a.level} · {approverName} · <DateText value={a.createdAt} /></span><p className="mt-1">{a.comments}</p></li>
                ))}
              </ul>
            </Card>
          )}
          {cancellable && (
            <Card title="Cancel application">
              <ActionForm action={cancelApplicationAction.bind(null, id)} submitLabel="Cancel application" variant="danger" confirm="Cancel this application? This cannot be undone.">
                <label htmlFor="reason" className="label">Reason (optional)</label>
                <input id="reason" name="reason" className="input" />
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
