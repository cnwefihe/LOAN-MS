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

export function ApplicantRecord({ d, ctx }: { d: Detail; ctx: Awaited<ReturnType<typeof loadReviewContext>> }) {
  const p = d.applicant.profile;
  const snap = d.app.salarySnapshot as SalarySnapshot;
  const differs = (a?: string | null, b?: string | null) => a && b && !dec(a).equals(b);
  return (
    <>
      <Card title="Applicant employment record" actions={<Link href={`/hr/staff/${d.app.applicantId}`} className="link text-sm">Full staff record</Link>}>
        <KeyValues columns={3} items={[
          ["Name", d.applicant.user.displayName], ["Email", d.applicant.user.email], ["Staff number", p?.staffNumber],
          ["School", d.applicant.school?.name], ["Department", d.applicant.department?.name], ["Designation", p?.designation],
          ["Employment status", p?.employmentStatus ? <StatusBadge key="s" status={p.employmentStatus === "confirmed" ? "confirmed" : "pending"} /> : <Badge tone="warning">Not recorded</Badge>],
          ["Employment date", <DateText key="e" value={p?.employmentDate} />], ["Service", `${monthsText(d.applicant.serviceMonths)} (policy minimum ${d.policy.params.minServiceMonths})`],
          ["Directory job title", p?.entraJobTitle], ["Directory department", p?.entraDepartment], ["Payslip figures", d.applicant.salaryVerified ? <Badge key="v" tone="success">Confirmed by Human Resources</Badge> : <Badge key="v" tone="warning">Not yet confirmed by Human Resources</Badge>],
        ]} />
      </Card>
      <Card title="Salary: declared vs record">
        <Table caption="Salary comparison">
          <thead><tr><Th>Monthly</Th><Th right>Declared at submission ({snap.source?.replace("_", " ")})</Th><Th right>On Human Resources record</Th></tr></thead>
          <tbody>
            {(["Basic", "Gross", "Net"] as const).map((k) => {
              const declared = snap[`monthly${k}`];
              const record = p?.[`monthly${k}` as "monthlyBasic"];
              return <tr key={k}><Td>{k}</Td><Td right><Money value={declared} /></Td><Td right className={differs(declared, record) ? "font-semibold text-warning-ink" : undefined}><Money value={record} />{differs(declared, record) && <span className="sr-only"> (differs)</span>}</Td></tr>;
            })}
          </tbody>
        </Table>
      </Card>
      <Card title="Existing loans and obligations">
        <KeyValues columns={3} items={[["Active loans", ctx.obligations.liveLoanCount], ["Monthly deductions", <Money key="m" value={ctx.obligations.monthlyDeductions} />], ["Outstanding", <Money key="o" value={ctx.obligations.outstanding} />]]} />
        {ctx.loans.length > 0 && (
          <Table caption="Active loans" className="mt-4">
            <thead><tr><Th>Account</Th><Th right>Instalment</Th><Th right>Outstanding</Th><Th>Status</Th></tr></thead>
            <tbody>{ctx.loans.map((l) => <tr key={l.id}><Td>{l.accountNumber}</Td><Td right><Money value={l.monthlyInstalment} /></Td><Td right><Money value={dec(l.principalOutstanding).plus(l.interestOutstanding).toFixed(2)} /></Td><Td><StatusBadge status={l.status} /></Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
      <Card title="Guarantor capacity" description={`Policy: ${d.policy.params.guarantorMustBeConfirmed ? "confirmed staff; " : ""}min. ${d.policy.params.guarantorMinServiceMonths} months' service; max exposure ₦${Number(d.policy.params.maxGuarantorExposure).toLocaleString()}; max ${d.policy.params.maxGuaranteesPerGuarantor} active guarantees.`}>
        <Table caption="Guarantor capacity">
          <thead><tr><Th>Guarantor</Th><Th>Status</Th><Th>Employment</Th><Th right>Monthly net</Th><Th right>Active guarantees</Th><Th right>Total exposure</Th></tr></thead>
          <tbody>
            {ctx.guarantors.map((g) => (
              <tr key={g.g.id}>
                <Td>{g.user.displayName}<p className="text-xs text-muted">{g.user.email}</p></Td>
                <Td><StatusBadge status={g.g.status} /></Td>
                <Td>{g.rec.profile?.employmentStatus?.replace("_", " ") ?? <Badge tone="warning">Not recorded</Badge>}{d.policy.params.guarantorMustBeConfirmed && g.rec.profile?.employmentStatus && g.rec.profile.employmentStatus !== "confirmed" && <> <Badge tone="danger">Not confirmed</Badge></>}<p className="text-xs text-muted">{monthsText(g.rec.serviceMonths)}</p></Td>
                <Td right><Money value={g.rec.profile?.monthlyNet} /></Td>
                <Td right>{g.exp.liveCount}</Td>
                <Td right><Money value={g.exp.total} /></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
