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
import { Alert, Card, PageHeader, StatusBadge, Money, KeyValues, DateText, Badge, SIDE_COLUMN, Table, Th, Td } from "@/components/ui";
import { LifecycleTracker } from "@/components/lifecycle";
import { FormDownloads } from "@/components/form-downloads";
import { DocumentList, GuarantorTable, MessageThread, QuoteSummary, UploadForm, WorkflowHistory } from "@/components/panels";
import { ApplicantRecord, loadReviewContext } from "@/components/review-context";
import { hrDecisionAction, hrUploadAction } from "@/app/actions/staff-ops";
import { postMessageAction } from "@/app/actions/applicant";
import { payslipDetailsBadge } from "@/components/payslip-details";
import { payslipDetailsConfirmed } from "@/server/services/staff";
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
  const people = [
    { userId: d.app.applicantId, role: "Applicant", displayName: d.applicant.user.displayName, profile: p, confirmable: true },
    ...ctx.guarantors.map((g) => ({ userId: g.g.guarantorId, role: "Guarantor", displayName: g.user.displayName, profile: g.rec.profile, confirmable: g.g.status === "accepted" })),
  ];
  const applicantPerson = people[0];
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
          <ApplicantRecord d={d} ctx={ctx} assessments={d.assessments} />

          {canDecide && (
            <Card title="Record due diligence" description="Updates the Human Resources record and is logged.">
              <ActionForm action={hrDecisionAction.bind(null, id, guaranteeIds)} submitLabel="Record decision" confirm="Record this Human Resources decision?">
                <fieldset className="rounded-md border border-line p-4">
                  <legend className="px-1 text-sm font-semibold text-navy">Applicant: {d.applicant.user.displayName}</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div><label htmlFor="employmentStatus" className="label">Employment status</label>
                      <select id="employmentStatus" name="employmentStatus" defaultValue={p?.employmentStatus ?? ""} className="input"><option value="">Keep unchanged</option>{EMPLOYMENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
                    <div><label htmlFor="employmentDate" className="label">Employment date</label><input id="employmentDate" name="employmentDate" type="date" defaultValue={p?.employmentDate ?? ""} className="input" /></div>
                  </div>
                  <div className="mt-4 grid gap-2">
                    {[["employmentVerified","Employment confirmed against the personnel file"],["salaryVerified","Payslip figures confirmed against payroll"],["staffStatusVerified","Staff status confirmed (active, not on notice or suspension)"],["departmentVerified","Department and designation confirmed"]].map(([n, l]) => (
                      <label key={n} className="flex gap-2 text-sm"><input type="checkbox" name={n} className="mt-1" /> {l}</label>
                    ))}
                    <label className="flex gap-2 text-sm"><input type="checkbox" name="detailsVerified" value={applicantPerson.userId} defaultChecked={payslipDetailsConfirmed(applicantPerson.profile)} className="mt-1" /> Payslip details ({applicantPerson.profile?.payslipName ?? applicantPerson.displayName}, {applicantPerson.profile?.staffNumber ?? "no employee code"}, {applicantPerson.profile?.payGrade ?? "no pay grade"}) match the personnel record</label>
                  </div>
                </fieldset>
                {ctx.guarantors.length > 0 && !can(actor, "hr.guarantor.assess") && (
                  <p className="mt-5 text-sm text-muted">Assessing the guarantors needs the &quot;Assess guarantor eligibility and capacity&quot; permission, which you do not have. You can still return or decline the application.</p>
                )}
                {can(actor, "hr.guarantor.assess") && ctx.guarantors.map((g) => {
                  const person = people.find((x) => x.userId === g.g.guarantorId)!;
                  return (
                    <fieldset key={g.g.id} className="mt-4 rounded-md border border-line p-4">
                      <legend className="px-1 text-sm font-semibold text-navy">Guarantor: {g.user.displayName}</legend>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div><label htmlFor={`g_${g.g.id}`} className="label">Can cover their share</label><select id={`g_${g.g.id}`} name={`g_${g.g.id}`} className="input" defaultValue=""><option value="">Not assessed</option><option value="capable">Capable</option><option value="not_capable">Not capable</option><option value="needs_review">Needs review</option></select></div>
                        <div><label htmlFor={`gn_${g.g.id}`} className="label">Notes</label><input id={`gn_${g.g.id}`} name={`gn_${g.g.id}`} className="input" /></div>
                      </div>
                      {person.confirmable && <div className="mt-3"><label className="flex gap-2 text-sm"><input type="checkbox" name="detailsVerified" value={person.userId} defaultChecked={payslipDetailsConfirmed(person.profile)} className="mt-1" /> Payslip details ({person.profile?.payslipName ?? person.displayName}, {person.profile?.staffNumber ?? "no employee code"}, {person.profile?.payGrade ?? "no pay grade"}) match the personnel record</label></div>}
                    </fieldset>
                  );
                })}
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

        <div className={SIDE_COLUMN}>
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
