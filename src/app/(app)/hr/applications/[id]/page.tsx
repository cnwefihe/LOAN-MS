import { notFound } from "next/navigation";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { getApplicationDetail, computeEligibilityFor, assessedWith } from "@/server/services/applications";
import { listDocumentsFor } from "@/server/services/documents";
import { can } from "@/server/actor";
import type { EligibilityResult } from "@/lib/finance/calculator";
import { EMPLOYMENT_STATUSES } from "@/lib/finance/policy";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, PageHeader, StatusBadge, Money, KeyValues, DateText, Badge } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { FormDownloads } from "@/components/form-downloads";
import { DocumentList, GuarantorTable, MessageThread, QuoteSummary, UploadForm, WorkflowHistory } from "@/components/panels";
import { ApplicantRecord, loadReviewContext } from "@/components/review-context";
import { hrDecisionAction, hrUploadAction } from "@/app/actions/staff-ops";
import { postMessageAction } from "@/app/actions/applicant";
import { PayslipDetails } from "@/components/payslip-details";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Human Resources review" };

export default async function HrReview({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("hr.queue.view");
  const { id } = await params;
  const db = await getDb();
  const d = await getApplicationDetail(db, actor, id).catch(() => null);
  if (!d) notFound();
  const ctx = await loadReviewContext(db, d);
  const docs = await listDocumentsFor(db, actor, { applicationId: id });
  const quote = d.app.quote as unknown as EligibilityResult;
  const p = d.applicant.profile;
  const current = await computeEligibilityFor(db, d.app.applicantId, d.policy.params, { requestedAmount: d.app.requestedAmount, tenorMonths: d.app.tenorMonths, excludeApplicationId: id, ...assessedWith(d.app) }).catch(() => null);
  const canDecide = can(actor, "hr.verify") && d.app.status === "pending_hr" && d.app.applicantId !== actor.userId && !ctx.guarantors.some((g) => g.g.guarantorId === actor.userId);
  const guaranteeIds = ctx.guarantors.map((g) => g.g.id);

  return (
    <>
      <PageHeader title={`Human Resources review: ${d.app.reference}`} crumbs={[{ label: "Human Resources", href: "/hr" }, { label: "Queue", href: "/hr/applications" }, { label: d.app.reference }]}
        description={<>{d.applicant.user.displayName} · {d.product.name}{d.app.advanceType ? ` (against ${ADVANCE_TYPES[d.app.advanceType].toLowerCase()})` : ""} · <Money value={d.app.requestedAmount} /> over {monthsText(d.app.tenorMonths)}</>} actions={<><FormDownloads applicationId={d.app.id} status={d.app.status} /><StatusBadge status={d.app.status} /></>} />
      <Card className="mb-6"><LifecycleTracker applicantId={d.app.applicantId} appStatus={d.app.status} loanStatus={d.loan?.status} level={d.app.currentApprovalLevel} /></Card>
      {d.app.applicantId === actor.userId && <div className="mb-6"><Alert tone="warning" title="This is your own application">You cannot verify it. Another Human Resources officer must do so.</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Request and quote at submission"><QuoteSummary quote={quote} /><p className="mt-4 text-xs text-muted">Cooperative loan (declared by the applicant)</p><p className="text-sm">{d.app.cooperativeMonthlyDeduction ? <><Money value={d.app.cooperativeMonthlyDeduction} /> a month{d.app.cooperativeBalance && <>, <Money value={d.app.cooperativeBalance} /> outstanding</>}</> : "None declared"}</p><p className="mt-4 text-xs text-muted">Purpose</p><p className="text-sm">{d.app.purpose}</p></Card>
          {(() => {
            const status = d.applicant.profile?.employmentStatus;
            const allowed = d.policy.params.eligibleEmploymentStatuses as string[];
            if (status && allowed.includes(status)) return null;
            return <Alert tone="warning" title="Check employment status">{status
              ? `The Human Resources record shows ${status.replace("_", " ")}. ${d.product.name} is for ${allowed.map((s) => s.replace("_", " ")).join(" and ")} staff, so decline the application if this is correct.`
              : `No employment status is recorded. Confirm it below before forwarding; ${d.product.name} is for ${allowed.map((s) => s.replace("_", " ")).join(" and ")} staff.`}</Alert>;
          })()}
          {current && (
            <Card title="Eligibility from the latest payslip" actions={current.eligible ? <Badge tone="success">Eligible</Badge> : <Badge tone="danger">Not eligible</Badge>}>
              {current.reasons.length > 0 && <div className="mb-3"><Alert tone="danger">{current.reasons.join(" ")}</Alert></div>}
              <KeyValues columns={3} items={[["Maximum eligible", <Money key="m" value={current.maxEligibleAmount} />], ["Available each month (33.3% limit)", <Money key="c" value={current.availableMonthlyCapacity} />], ["Monthly repayment requested", <Money key="i" value={current.quote?.monthlyInstalment} />]]} />
            </Card>
          )}
          <ApplicantRecord d={d} ctx={ctx} />
          <Card title="Payslip details" description="Entered by each person from their payslip. Confirm they match the personnel record before verifying.">
            <div className="space-y-5">
              <PayslipDetails who={`Applicant: ${d.applicant.user.displayName}`} userId={d.app.applicantId} displayName={d.applicant.user.displayName} profile={p} canConfirm={canDecide} back={`/hr/applications/${id}`} />
              {ctx.guarantors.map((g) => <PayslipDetails key={g.g.id} who={`Guarantor: ${g.user.displayName}`} userId={g.g.guarantorId} displayName={g.user.displayName} profile={g.rec.profile} canConfirm={canDecide} back={`/hr/applications/${id}`} />)}
            </div>
          </Card>
          <Card title="Guarantor responses"><GuarantorTable guarantors={d.guarantors} assessments={d.assessments} /></Card>

          {canDecide && (
            <Card title="Record due diligence" description="Your verification updates the Human Resources record and is logged.">
              <ActionForm action={hrDecisionAction.bind(null, id, guaranteeIds)} submitLabel="Record decision" confirm="Record this Human Resources decision?">
                <fieldset className="grid gap-4 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-semibold text-navy">Employment</legend>
                  <div><label htmlFor="employmentStatus" className="label">Employment status</label>
                    <select id="employmentStatus" name="employmentStatus" defaultValue={p?.employmentStatus ?? ""} className="input"><option value="">Keep unchanged</option>{EMPLOYMENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
                  <div><label htmlFor="employmentDate" className="label">Employment date</label><input id="employmentDate" name="employmentDate" type="date" defaultValue={p?.employmentDate ?? ""} className="input" /></div>
                </fieldset>
                <fieldset className="mt-5 grid gap-2 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-semibold text-navy">Checks</legend>
                  {[["employmentVerified", "Employment confirmed against personnel file"], ["salaryVerified", "Payslip figures confirmed against payroll"], ["staffStatusVerified", "Staff status (active, not on notice/suspension) confirmed"], ["departmentVerified", "Department and designation confirmed"]].map(([n, l]) => (
                    <label key={n} className="flex gap-2 text-sm"><input type="checkbox" name={n} className="mt-1" /> {l}</label>
                  ))}
                </fieldset>
                {ctx.guarantors.length > 0 && (
                  <fieldset className="mt-5 space-y-3">
                    <legend className="mb-2 text-sm font-semibold text-navy">Guarantor assessment</legend>
                    {ctx.guarantors.map((g) => (
                      <div key={g.g.id} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-3">
                        <div className="text-sm"><p className="font-medium">{g.user.displayName}</p><p className="text-xs text-muted">Exposure <Money value={g.exp.total} /> · net <Money value={g.rec.profile?.monthlyNet} /></p></div>
                        <div><label htmlFor={`g_${g.g.id}`} className="label">Outcome</label><select id={`g_${g.g.id}`} name={`g_${g.g.id}`} className="input" defaultValue=""><option value="">Not assessed</option><option value="capable">Capable</option><option value="not_capable">Not capable</option><option value="needs_review">Needs review</option></select></div>
                        <div><label htmlFor={`gn_${g.g.id}`} className="label">Notes</label><input id={`gn_${g.g.id}`} name={`gn_${g.g.id}`} className="input" /></div>
                      </div>
                    ))}
                  </fieldset>
                )}
                <div className="mt-5"><label htmlFor="notes" className="label">Due-diligence notes / comments to applicant</label><textarea id="notes" name="notes" rows={4} required minLength={10} className="input" /></div>
                <fieldset className="mt-4">
                  <legend className="label">Outcome</legend>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2"><input type="radio" name="outcome" value="verified" required /> Verify &amp; forward for approval</label>
                    <label className="flex items-center gap-2"><input type="radio" name="outcome" value="returned" /> Return to applicant for correction</label>
                    <label className="flex items-center gap-2"><input type="radio" name="outcome" value="declined" /> Decline</label>
                  </div>
                </fieldset>
              </ActionForm>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Documents">
            <DocumentList docs={docs} />
            {can(actor, "hr.verify") && <div className="mt-4 border-t border-line pt-4"><UploadForm action={hrUploadAction.bind(null, id)} defaultTitle="Employment verification" /></div>}
          </Card>
          <Card title="Verification history">
            {d.hr.length === 0 ? <p className="text-sm text-muted">No Human Resources decisions yet.</p> : (
              <ul className="space-y-3 text-sm">{d.hr.map(({ v, officerName }) => (
                <li key={v.id} className="rounded-md border border-line p-3"><StatusBadge status={v.outcome === "verified" ? "verified" : v.outcome} /> <span className="text-xs text-muted">{officerName} · <DateText value={v.createdAt} withTime /></span>
                  <p className="mt-1 text-xs text-muted">Verified net <Money value={v.verifiedMonthlyNet} /> · eligible <Money value={v.recomputedEligibleAmount} /> · {v.serviceMonths} months&apos; service</p>
                  <p className="mt-1">{v.dueDiligenceNotes}</p></li>))}</ul>
            )}
          </Card>
          <Card title="Messages & internal notes">
            <MessageThread messages={d.messages} />
            <ActionForm action={postMessageAction.bind(null, id, "internal")} submitLabel="Add internal note" variant="secondary" resetOnSuccess>
              <label htmlFor="note" className="label mt-4">Internal note (staff only)</label><textarea id="note" name="body" rows={2} required className="input" />
            </ActionForm>
          </Card>
          <Card title="Workflow history"><WorkflowHistory history={d.history} /></Card>
        </div>
      </div>
    </>
  );
}
