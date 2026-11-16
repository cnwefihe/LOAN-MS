import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanAccounts } from "@/db/schema";
import { getApplicationDetail, type SalarySnapshot } from "@/server/services/applications";
import { getStaffRecord, getObligations } from "@/server/services/staff";
import { guarantorExposure } from "@/server/services/guarantors";
import { dec } from "@/lib/finance/money";
import { Card, KeyValues, Money, Table, Th, Td, StatusBadge, Badge, DateText } from "./ui";
import { monthsText } from "@/lib/finance/dates";
import { payslipDetailsBadge } from "./payslip-details";

type Detail = Awaited<ReturnType<typeof getApplicationDetail>>;

/** Shared staff-side context for HR and approver reviews: applicant record, obligations, guarantor capacity. */
export async function loadReviewContext(db: Executor, d: Detail) {
  const obligations = await getObligations(db, d.app.applicantId, d.app.id);
  const loans = await db.select().from(loanAccounts).where(and(eq(loanAccounts.borrowerId, d.app.applicantId), inArray(loanAccounts.status, ["pending_disbursement", "active", "overdue", "defaulted"])));
  const guarantors = [];
  for (const g of d.guarantors.filter((x) => ["accepted", "pending", "clarification_requested"].includes(x.g.status))) {
    const rec = await getStaffRecord(db, g.g.guarantorId);
    const exp = await guarantorExposure(db, g.g.guarantorId);
    guarantors.push({ ...g, rec, exp });
  }
  return { obligations, loans, guarantors };
}

type Ctx = Awaited<ReturnType<typeof loadReviewContext>>;
type Profile = Detail["applicant"]["profile"];

/** Name, employee code and pay grade as on the payslip, with whether Human Resources has confirmed them. */
function payslipItems(p: Profile, fallbackName: string): [string, React.ReactNode][] {
  return [
    ["Name on payslip", p?.payslipName ?? fallbackName],
    ["Employee code", p?.staffNumber ?? <span key="c" className="text-danger">Not entered</span>],
    ["Pay grade", p?.payGrade ?? <span key="g" className="text-danger">Not entered</span>],
  ];
}

/**
 * Each person in one place: the applicant's card, then a card for each guarantor, each with their payslip
 * details, employment record and what matters for the decision, so nothing about one person is split up.
 */
export function ApplicantRecord({ d, ctx, assessments, showPay = true }: { d: Detail; ctx: Ctx; assessments?: { applicationGuarantorId: string; outcome: string; existingExposure: string }[]; showPay?: boolean }) {
  const p = d.applicant.profile;
  const snap = d.app.salarySnapshot as SalarySnapshot;
  const pp = d.policy.params;
  const others = d.guarantors.filter((g) => !ctx.guarantors.some((x) => x.g.id === g.g.id));
  return (
    <>
      <Card title={<span>Applicant: {d.applicant.user.displayName}</span>}
        actions={showPay ? <span className="flex flex-wrap items-center gap-2">{payslipDetailsBadge(p)}<Link href={`/hr/staff/${d.app.applicantId}`} className="link text-sm">Full staff record</Link></span> : undefined}>
        {showPay && <>
        <h3 className="mb-2 text-sm font-semibold text-navy">As on the payslip</h3>
        <KeyValues columns={3} items={[
          ...payslipItems(p, d.applicant.user.displayName),
          ["Basic at submission", <Money key="b" value={snap.monthlyBasic} />], ["Net pay at submission", <Money key="n" value={snap.monthlyNet} />],
          ["Basic on HR record", <Money key="r" value={p?.monthlyBasic} />],
        ]} />
        </>}
        <h3 className={showPay ? "mb-2 mt-5 border-t border-line pt-4 text-sm font-semibold text-navy" : "mb-2 text-sm font-semibold text-navy"}>Employment</h3>
        <KeyValues columns={3} items={[
          ["Employment status", p?.employmentStatus ? <StatusBadge key="s" status={p.employmentStatus === "confirmed" ? "confirmed" : "pending"} /> : <Badge tone="warning">Not recorded</Badge>],
          ["Employment date", <DateText key="e" value={p?.employmentDate} />], ["Service", `${monthsText(d.applicant.serviceMonths)} (policy minimum ${pp.minServiceMonths})`],
          ["School", d.applicant.school?.name], ["Department", d.applicant.department?.name], ["Designation", p?.designation],
          ["Email", d.applicant.user.email], ["Directory job title", p?.entraJobTitle], ["Directory department", p?.entraDepartment],
        ]} />
      </Card>

      {showPay && (
      <Card title="Existing loans and obligations" bodyClassName={ctx.loans.length ? "p-5 pb-0" : undefined}>
        <KeyValues columns={3} items={[["Active loans", ctx.obligations.liveLoanCount], ["Monthly deductions", <Money key="m" value={ctx.obligations.monthlyDeductions} />], ["Outstanding", <Money key="o" value={ctx.obligations.outstanding} />]]} />
        {ctx.loans.length > 0 && (
          <Table caption="Active loans" className="mt-4">
            <thead><tr><Th>Account</Th><Th right>Instalment</Th><Th right>Outstanding</Th><Th>Status</Th></tr></thead>
            <tbody>{ctx.loans.map((l) => <tr key={l.id}><Td>{l.accountNumber}</Td><Td right><Money value={l.monthlyInstalment} /></Td><Td right><Money value={dec(l.principalOutstanding).plus(l.interestOutstanding).toFixed(2)} /></Td><Td><StatusBadge status={l.status} /></Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
      )}

      {ctx.guarantors.map((g) => {
        const gp = g.rec.profile;
        const a = assessments?.find((x) => x.applicationGuarantorId === g.g.id);
        const notConfirmed = pp.guarantorMustBeConfirmed && gp?.employmentStatus && gp.employmentStatus !== "confirmed";
        return (
          <Card key={g.g.id} title={<span>Guarantor: {g.user.displayName}</span>}
            actions={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={g.g.status} />{showPay && payslipDetailsBadge(gp)}</span>}
            description={g.g.responseComment ? `"${g.g.responseComment}"` : undefined}>
            {showPay && <>
            <h3 className="mb-2 text-sm font-semibold text-navy">As on the payslip</h3>
            <KeyValues columns={3} items={payslipItems(gp, g.user.displayName)} />
            </>}
            <h3 className={showPay ? "mb-2 mt-5 border-t border-line pt-4 text-sm font-semibold text-navy" : "mb-2 text-sm font-semibold text-navy"}>Employment and guarantee</h3>
            <KeyValues columns={3} items={[
              ["Employment status", gp?.employmentStatus ? <span key="s">{gp.employmentStatus.replace("_", " ")}{notConfirmed && <> <Badge tone="danger">Not confirmed</Badge></>}</span> : <Badge tone="warning">Not recorded</Badge>],
              ["Service", `${monthsText(g.rec.serviceMonths)} (minimum ${pp.guarantorMinServiceMonths})`], ["Email", g.user.email],
              ["Amount guaranteed", <Money key="a" value={g.g.guaranteedAmount} />], ["Active guarantees", `${g.exp.liveCount} (maximum ${pp.maxGuaranteesPerGuarantor})`], ["Total exposure", <Money key="t" value={g.exp.total} />],
              ["Responded", g.g.respondedAt ? <DateText key="r" value={g.g.respondedAt} withTime /> : "Not yet"],
              ...(assessments ? [["Human Resources assessment", a ? <StatusBadge key="h" status={a.outcome} /> : <span key="h" className="text-muted">Not assessed</span>] as [string, React.ReactNode]] : []),
            ]} />
          </Card>
        );
      })}

      {others.length > 0 && (
        <Card title="Other guarantors asked">
          <ul className="space-y-1 text-sm">
            {others.map((g) => <li key={g.g.id}>{g.user.displayName}: <StatusBadge status={g.g.status} />{g.g.responseComment && <span className="text-muted"> "{g.g.responseComment}"</span>}</li>)}
          </ul>
        </Card>
      )}
    </>
  );
}
