import { notFound } from "next/navigation";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { getDb } from "@/db";
import { approvalStageName, getWording } from "@/server/wording";
import { requireActor } from "@/lib/auth/session";
import { getApplicationDetail } from "@/server/services/applications";
import { listDocumentsFor } from "@/server/services/documents";
import { canDecideAt } from "@/server/services/approvals";
import { departmentHeadOf } from "@/server/services/staff";
import { APPROVAL_LEVEL } from "@/server/workflow";
import { can } from "@/server/actor";
import type { EligibilityResult } from "@/lib/finance/calculator";
import { dec } from "@/lib/finance/money";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, PageHeader, StatusBadge, Money, KeyValues, DateText } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { FormDownloads } from "@/components/form-downloads";
import { DocumentList, GuarantorTable, MessageThread, QuoteSummary, UploadForm, WorkflowHistory } from "@/components/panels";
import { ApplicantRecord, loadReviewContext } from "@/components/review-context";
import { approvalDecisionAction, uploadStaffDocumentAction } from "@/app/actions/staff-ops";
import { postMessageAction } from "@/app/actions/applicant";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Approval review" };

export default async function ApprovalReview({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const db = await getDb();
  const d = await getApplicationDetail(db, actor, id).catch(() => null);
  if (!d || !d.access.isStaff) notFound();
  const ctx = await loadReviewContext(db, d);
  const docs = await listDocumentsFor(db, actor, { applicationId: id });
  const quote = d.app.quote as unknown as EligibilityResult;
  const hr = d.hr[0]?.v;
  const conflicted = d.app.applicantId === actor.userId || ctx.guarantors.some((g) => g.g.guarantorId === actor.userId);
  const level = d.app.currentApprovalLevel || APPROVAL_LEVEL.HOD;
  const canDecide = !conflicted && (await canDecideAt(db, actor, d.app));
  const isBursar = level === APPROVAL_LEVEL.BURSAR;
  const p = d.policy.params;
  const w = await getWording(db);
  const title = (await departmentHeadOf(db, d.app.applicantId))?.approverTitle;
  const stage = approvalStageName(w, level, title);
  const maxApprovable = hr?.recomputedEligibleAmount ? (dec(hr.recomputedEligibleAmount).lessThan(d.app.requestedAmount) ? hr.recomputedEligibleAmount : d.app.requestedAmount) : d.app.requestedAmount;

  return (
    <>
      <PageHeader title={`${d.app.status === "pending_approval" ? stage : "Approval"}: ${d.app.reference}`} crumbs={[{ label: "Approvals", href: "/approvals" }, { label: d.app.reference }]}
        description={<>{d.applicant.user.displayName} · {d.product.name}{d.app.advanceType ? ` (against ${ADVANCE_TYPES[d.app.advanceType].toLowerCase()})` : ""} · <Money value={d.app.requestedAmount} /> over {monthsText(d.app.tenorMonths)}</>}
        actions={<><FormDownloads applicationId={d.app.id} status={d.app.status} /><StatusBadge status={d.app.status} /></>} />
      <Card className="mb-6"><LifecycleTracker applicantId={d.app.applicantId} appStatus={d.app.status} loanStatus={d.loan?.status} level={d.app.currentApprovalLevel} /></Card>
      {conflicted && <div className="mb-6"><Alert tone="warning" title="Conflict of interest">You are the applicant or a guarantor on this application and cannot decide it.</Alert></div>}
      {!canDecide && !conflicted && d.app.status === "pending_approval" && (
        <div className="mb-6"><Alert tone="info" title={`Now at: ${stage}`}>You can follow its progress here; the decision at this stage belongs to someone else.</Alert></div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {canDecide && (
            <Card title={`Your decision: ${stage}`} description={isBursar ? "You may approve a lower amount or shorter period." : "Approve to send it to the next approver, or decline or return it to the applicant."}>
              <ActionForm action={approvalDecisionAction.bind(null, id)} submitLabel="Record decision" confirm="Record this decision? It cannot be edited afterwards.">
                {isBursar && (
                  <div className="mb-4 grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor="approvedAmount" className="label">Approved amount (₦)</label><input id="approvedAmount" name="approvedAmount" inputMode="decimal" defaultValue={maxApprovable} className="input" aria-describedby="amt-hint" /><p id="amt-hint" className="hint">Max: <Money value={maxApprovable} /></p></div>
                    <div><label htmlFor="approvedTenorMonths" className="label">Approved tenor (months)</label><input id="approvedTenorMonths" name="approvedTenorMonths" type="number" min={p.minTenorMonths} max={p.maxTenorMonths} defaultValue={d.app.tenorMonths} className="input" /></div>
                  </div>
                )}
                <div><label htmlFor="comments" className="label">Basis for decision</label><textarea id="comments" name="comments" rows={3} required minLength={5} className="input" /></div>
                <fieldset className="mt-4">
                  <legend className="label">Decision</legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="approved" required /> {isBursar ? "Give final approval" : "Approve"}</label>
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="declined" /> Decline</label>
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="returned" /> Return to applicant</label>
                    {isBursar && <label className="flex items-center gap-2"><input type="radio" name="decision" value="refer_hr" /> Refer back to Human Resources</label>}
                  </div>
                </fieldset>
              </ActionForm>
            </Card>
          )}
          {hr && (
            <Card title={w.stage.hr} actions={<StatusBadge status="verified" />}>
              <KeyValues columns={3} items={[
                ["Verified by", d.hr[0].officerName], ["Date", <DateText key="d" value={hr.createdAt} withTime />], ["Service", `${monthsText(hr.serviceMonths)}`],
                ["Verified net salary", <Money key="n" value={hr.verifiedMonthlyNet} />], ["Eligible amount (verified)", <Money key="e" value={hr.recomputedEligibleAmount} />], ["Existing monthly obligations", <Money key="o" value={hr.existingObligations} />],
              ]} />
              <p className="mt-4 text-xs text-muted">Due-diligence notes</p><p className="text-sm">{hr.dueDiligenceNotes}</p>
            </Card>
          )}
          <Card title="Request and quote">
            <QuoteSummary quote={quote} />
            <p className="mt-4 text-xs text-muted">Cooperative loan</p>
            <p className="text-sm">{d.app.cooperativeMonthlyDeduction ? <><Money value={d.app.cooperativeMonthlyDeduction} /> a month{d.app.cooperativeBalance && <>, <Money value={d.app.cooperativeBalance} /> outstanding</>}</> : "None declared"}</p>
            <p className="mt-4 text-xs text-muted">Purpose</p><p className="text-sm">{d.app.purpose}</p>
          </Card>
          <Card title="Guarantors"><GuarantorTable guarantors={d.guarantors.filter((g) => g.g.status === "accepted")} assessments={d.assessments} /></Card>
          <ApplicantRecord d={d} ctx={ctx} />
          {d.loan && <Alert tone="success" title={`Loan account ${d.loan.accountNumber} opened`}>Status: {d.loan.status.replace("_", " ")}. The Accounts Payable Officer will pay it out.</Alert>}
        </div>
        <div className="space-y-6">
          <Card title="Documents">
            <DocumentList docs={docs} />
            {can(actor, "approval.decide") && !conflicted && (
              <div className="mt-4 border-t border-line pt-4">
                <UploadForm action={uploadStaffDocumentAction.bind(null, "approval", id)} defaultTitle="Approval minute / memo" />
              </div>
            )}
          </Card>
          <Card title="Approvals so far">
            {d.approvals.length === 0 ? <p className="text-sm text-muted">None yet.</p> : <ul className="space-y-2 text-sm">{d.approvals.map(({ a, approverName }) => <li key={a.id}><StatusBadge status={a.decision === "approved" ? "approved" : a.decision === "declined" ? "declined" : "returned"} /> <span className="text-xs text-muted">{approvalStageName(w, a.level, title)} · {approverName} · <DateText value={a.createdAt} /></span><p>{a.comments}</p>{a.approvedAmount && <p className="text-xs text-muted"><Money value={a.approvedAmount} /> · {monthsText(a.approvedTenorMonths)}</p>}</li>)}</ul>}
          </Card>
          <Card title="Messages and notes">
            <MessageThread messages={d.messages} />
            <ActionForm action={postMessageAction.bind(null, id, "internal")} submitLabel="Add internal note" variant="secondary" resetOnSuccess>
              <label htmlFor="note" className="label mt-4">Internal note</label><textarea id="note" name="body" rows={2} required className="input" />
            </ActionForm>
          </Card>
          <Card title="Workflow history"><WorkflowHistory history={d.history} /></Card>
        </div>
      </div>
    </>
  );
}
