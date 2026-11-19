import { DateInput } from "@/components/date-input";
import { notFound } from "next/navigation";
import { ADVANCE_TYPES } from "@/lib/finance/policy";
import { getDb } from "@/db";
import { getWording } from "@/server/wording";
import { requireActor } from "@/lib/auth/session";
import { getApplicationDetail } from "@/server/services/applications";
import { bursaryWorksheet } from "@/server/services/bursary";
import { listDocumentsFor } from "@/server/services/documents";
import { can } from "@/server/actor";
import type { EligibilityResult } from "@/lib/finance/calculator";
import { ActionForm } from "@/components/action-form";
import { Alert, Badge, Card, PageHeader, StatusBadge, Money, KeyValues, DateText, SIDE_COLUMN } from "@/components/ui";
import { FundPoolCard } from "@/components/fund-pool";
import { LifecycleTracker } from "@/components/lifecycle";
import { PayslipBreakdown } from "@/components/payslip-breakdown";
import { dec } from "@/lib/finance/money";
import { FormDownloads } from "@/components/form-downloads";
import { DocumentList, GuarantorTable, MessageThread, QuoteSummary, WorkflowHistory } from "@/components/panels";
import { bursaryDecisionAction } from "@/app/actions/staff-ops";
import { postMessageAction } from "@/app/actions/applicant";
import { monthsText } from "@/lib/finance/dates";
import { departmentHeadOf } from "@/server/services/staff";

export const metadata = { title: "Bursary review" };

export default async function BursaryReview({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("bursary.review");
  const { id } = await params;
  const db = await getDb();
  const d = await getApplicationDetail(db, actor, id).catch(() => null);
  if (!d) notFound();
  const w = await bursaryWorksheet(db, id);
  const docs = await listDocumentsFor(db, actor, { applicationId: id });
  const quote = d.app.quote as unknown as EligibilityResult;
  const hr = w.hr;
  const conflicted = d.app.applicantId === actor.userId || d.guarantors.some((g) => g.g.guarantorId === actor.userId && g.g.status === "accepted");
  const canDecide = can(actor, "bursary.review") && d.app.status === "pending_bursary" && !conflicted;
  const t = w.deductions;
  const words = await getWording(db);
  const approver = (await departmentHeadOf(db, d.app.applicantId))?.approverTitle === "line_manager" ? "Line Manager" : "Head of Department";

  return (
    <>
      <PageHeader title={`${words.stage.bursary}: ${d.app.reference}`} crumbs={[{ label: words.stage.bursary, href: "/bursary/review" }, { label: d.app.reference }]}
        description={<>{d.applicant.user.displayName} · {d.applicant.department?.name ?? "No department"} · {d.product.name}{d.app.advanceType ? ` (against ${ADVANCE_TYPES[d.app.advanceType].toLowerCase()})` : ""} · <Money value={d.app.requestedAmount} /> over {monthsText(d.app.tenorMonths)}</>}
        actions={<><FormDownloads applicationId={d.app.id} status={d.app.status} /><StatusBadge status={d.app.status} /></>} />
      <Card className="mb-6"><LifecycleTracker applicantId={d.app.applicantId} appStatus={d.app.status} loanStatus={d.loan?.status} level={d.app.currentApprovalLevel} /></Card>
      {conflicted && <div className="mb-6"><Alert tone="warning" title="Conflict of interest">You are the applicant or a guarantor on this application and cannot review it.</Alert></div>}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Bursary information" description="Filled in from the University's records.">
            <KeyValues columns={3} items={[
              ["Date last loan taken", w.lastLoan ? <DateText key="t" value={w.lastLoan.takenOn} /> : "No previous loan"],
              ["Date fully repaid", w.lastLoan ? (w.lastLoan.repaidOn ? <DateText key="r" value={w.lastLoan.repaidOn} /> : <Badge key="o" tone="warning">Not yet repaid</Badge>) : "N/A"],
              ["Previous loan", w.lastLoan ? <>{w.lastLoan.accountNumber} · <Money value={w.lastLoan.principal} /></> : "N/A"],
            ]} />
          </Card>

          <Card title={`Deduction check: all deductions within ${t.capPercent}% of net pay`} actions={t.passed ? <Badge tone="success">Passed</Badge> : <Badge tone="danger">Failed</Badge>}>
            {w.elig.payslip ? (
              <div className="grid gap-6 lg:grid-cols-2">
                <PayslipBreakdown a={w.elig.payslip} period={t.period} guarantees={w.elig.guaranteeCommitment} instalment={t.deduction} who="the applicant's" />
                <KeyValues columns={1} items={[
                  ["Net pay", <Money key="n" value={t.net} />],
                  [`Deduction limit (${t.capPercent}% of net pay)`, <Money key="l" value={t.limit} />],
                  ["Already deducted", <Money key="c" value={t.committed} />],
                  ["This loan's monthly deduction", <Money key="d" value={t.deduction} />],
                  ["All deductions after this loan", <Money key="a" value={t.after} />],
                  ["As % of net pay", <span key="p" className={t.passed ? "font-semibold text-success" : "font-semibold text-danger"}>{t.percent}%</span>],
                  ["Most they can borrow now", <Money key="m" value={w.elig.maxEligibleAmount} />],
                ]} />
              </div>
            ) : <p className="text-sm text-danger">No payslip is on file for this application.</p>}
          </Card>

          {d.app.advanceType ? (
            <Card title="Fund position" description="Advances are paid from the payment they are taken against, not from the fund pool.">
              <KeyValues columns={3} items={[["This request", <Money key="r" value={d.app.requestedAmount} />], ["Paid out this month", <Money key="m" value={w.funding.paidThisMonth} />]]} />
            </Card>
          ) : (
            <>
              {w.fund ? <FundPoolCard pos={w.fund} className="" /> : <Alert tone="danger" title="No fund pool">{d.applicant.department?.name ?? "The applicant's department"} is not in a school, so there is no fund pool to draw from. An administrator can put the department in a school under Organisation.</Alert>}
              {w.fund?.set && (Number(d.app.requestedAmount) > Number(w.fund.free)
                ? <Alert tone="danger" title="Not enough left in the fund pool">This request of <Money value={d.app.requestedAmount} /> is more than the <Money value={w.fund.free} /> free to lend, so it cannot be cleared even though the applicant is eligible.</Alert>
                : <Alert tone="success" title="Funds available">This request of <Money value={d.app.requestedAmount} /> fits within the <Money value={w.fund.free} /> free to lend.</Alert>)}
            </>
          )}

          {hr && (
            <Card title={words.stage.hr} actions={<StatusBadge status="verified" />}>
              <KeyValues columns={3} items={[
                ["Verified by", hr.officer], ["Date", <DateText key="d" value={hr.v.createdAt} withTime />], ["Loan status of employee", `${d.applicant.profile?.employmentStatus?.replace("_", " ") ?? "N/A"}, ${hr.v.serviceMonths} months' service`],
              ]} />
              <p className="mt-4 text-xs text-muted">Due-diligence notes</p><p className="text-sm">{hr.v.dueDiligenceNotes}</p>
            </Card>
          )}
          <Card title="Request and repayment terms"><QuoteSummary quote={quote} /><p className="mt-4 text-xs text-muted">Purpose</p><p className="text-sm">{d.app.purpose}</p></Card>
          <Card title="Guarantors"><GuarantorTable guarantors={d.guarantors.filter((g) => g.g.status === "accepted")} assessments={d.assessments} /></Card>

          {canDecide && (
            <Card title="Your decision">
              <ActionForm action={bursaryDecisionAction.bind(null, id)} submitLabel="Record decision" confirm="Record this decision? It cannot be edited afterwards.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><label htmlFor="lastLoanDate" className="label">Date last loan taken</label><DateInput id="lastLoanDate" name="lastLoanDate" defaultValue={w.lastLoan?.takenOn ?? ""} /><p className="hint">Change only for a loan taken before this system.</p></div>
                  <div><label htmlFor="lastLoanRepaidDate" className="label">Date fully repaid</label><DateInput id="lastLoanRepaidDate" name="lastLoanRepaidDate" defaultValue={w.lastLoan?.repaidOn ?? ""} /></div>
                </div>
                <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" name="fundsAvailable" className="mt-1" /> I confirm that funds are available to pay out this loan.</label>
                <div className="mt-4"><label htmlFor="comments" className="label">Comments</label><textarea id="comments" name="comments" rows={3} required minLength={5} className="input" /></div>
                <fieldset className="mt-4">
                  <legend className="label">Decision</legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="cleared" required disabled={!t.passed} /> Affirm and send to the {approver}</label>
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="returned" /> Return to applicant</label>
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="refer_hr" /> Refer back to Human Resources</label>
                    <label className="flex items-center gap-2"><input type="radio" name="decision" value="declined" /> Decline</label>
                  </div>
                  {!t.passed && <p className="hint mt-2">The deduction check has failed, so the application cannot be cleared.</p>}
                </fieldset>
              </ActionForm>
            </Card>
          )}
        </div>
        <div className={SIDE_COLUMN}>
          <Card title={`Previous ${words.stage.bursary.toLowerCase()} decisions`}>
            {w.reviews.length === 0 ? <p className="text-sm text-muted">None yet.</p> : (
              <ul className="space-y-3 text-sm">{w.reviews.map(({ r, reviewer }) => (
                <li key={r.id}><StatusBadge status={r.decision === "cleared" ? "approved" : r.decision === "declined" ? "declined" : "returned"} /> <span className="text-xs text-muted">{reviewer} · <DateText value={r.createdAt} /></span>
                  <p>{r.comments}</p><p className="text-xs text-muted">Funds available: {r.fundsAvailable ? "Yes" : "No"} · Deductions {r.takeHomePercent}% of net pay</p></li>
              ))}</ul>
            )}
          </Card>
          <Card title="Documents"><DocumentList docs={docs} /></Card>
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
