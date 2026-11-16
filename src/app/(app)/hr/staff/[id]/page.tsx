import Link from "next/link";
import { designationOf } from "@/lib/designation";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, loanAccounts, schools, departments, staffCategories } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { getStaffRecord, getObligations } from "@/server/services/staff";
import { guarantorExposure } from "@/server/services/guarantors";
import { can } from "@/server/actor";
import { EMPLOYMENT_STATUSES } from "@/lib/finance/policy";
import { dec } from "@/lib/finance/money";
import { ActionForm } from "@/components/action-form";
import { Card, KeyValues, Money, PageHeader, StatusBadge, Table, Th, Td, DateText, Badge, SIDE_COLUMN } from "@/components/ui";
import { staffRecordAction, salaryFromPayrollAction } from "@/app/actions/staff-ops";
import { payrollProvider } from "@/server/integrations/payroll";
import { payslipDetailsBadge } from "@/components/payslip-details";
import { latestPayslip } from "@/server/services/payslips";
import { payslipMonth } from "@/components/payslip-breakdown";
import { assessPayslip, DEFAULT_PAYSLIP_RULES } from "@/lib/finance/payslip";
import { monthsText } from "@/lib/finance/dates";

export const metadata = { title: "Staff record" };

export default async function StaffRecord({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor("hr.staff.view");
  const { id } = await params;
  const db = await getDb();
  const rec = await getStaffRecord(db, id).catch(() => null);
  if (!rec) notFound();
  const p = rec.profile;
  const ob = await getObligations(db, id);
  const exp = await guarantorExposure(db, id);
  const apps = await db.select().from(loanApplications).where(eq(loanApplications.applicantId, id)).orderBy(desc(loanApplications.createdAt));
  const loans = await db.select().from(loanAccounts).where(eq(loanAccounts.borrowerId, id)).orderBy(desc(loanAccounts.createdAt));
  const editable = can(actor, "hr.staff.edit") && id !== actor.userId;
  // Pre-filled where the record is empty, from what is already known, so Human Resources only corrects what is wrong.
  const slip = await latestPayslip(db, id);
  const slipFigures = slip ? assessPayslip(slip.data, DEFAULT_PAYSLIP_RULES) : null;
  const slipBasic = slipFigures?.basic ?? null;
  const neverSaved = !p?.employmentVerifiedAt;
  const basicPrefill = p?.monthlyBasic ?? (neverSaved ? slipBasic : null) ?? "";
  const statusBadge = p?.employmentStatus === "confirmed" ? <Badge tone="success">Confirmed</Badge> : p?.employmentStatus ? <Badge tone="danger">Not confirmed</Badge> : <Badge tone="warning">Status not recorded</Badge>;
  const [sch, dep, cat] = editable ? await Promise.all([db.select().from(schools), db.select().from(departments), db.select().from(staffCategories)]) : [[], [], []];

  return (
    <>
      <PageHeader title={rec.user.displayName} crumbs={[{ label: "Human Resources", href: "/hr" }, { label: "Staff", href: "/hr/staff" }, { label: rec.user.displayName }]} description={rec.user.email}
        actions={rec.salaryVerified ? <Badge tone="success">Salary verified{" "}<DateText value={p?.salaryVerifiedAt} /></Badge> : <Badge tone="warning">Salary unverified</Badge>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Staff record" actions={<span className="flex flex-wrap gap-1.5">{statusBadge}{payslipDetailsBadge(p)}</span>}
            description={editable ? "Check against the personnel record; saving confirms the payslip details." : "Kept by Human Resources."}>
            {editable ? (
              <ActionForm key={String(p?.updatedAt ?? "new")} action={staffRecordAction.bind(null, id)} submitLabel="Save and confirm" confirm={`Save ${rec.user.displayName}'s record and confirm their payslip details?`}>
                <h3 className="mb-3 text-sm font-semibold text-navy">As on the payslip</h3>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><label htmlFor="payslipName" className="label">Name on payslip</label><input id="payslipName" name="payslipName" defaultValue={p?.payslipName ?? rec.user.displayName} className="input" /></div>
                  <div><label htmlFor="staffNumber" className="label">Employee code</label><input id="staffNumber" name="staffNumber" defaultValue={p?.staffNumber ?? ""} className="input" /></div>
                  <div><label htmlFor="payGrade" className="label">Pay grade</label><input id="payGrade" name="payGrade" defaultValue={p?.payGrade ?? ""} className="input" /></div>
                  <div><label htmlFor="monthlyBasic" className="label">Monthly basic salary (₦)</label><input id="monthlyBasic" name="monthlyBasic" inputMode="decimal" defaultValue={basicPrefill} className="input" />{!p?.monthlyBasic && neverSaved && slipBasic && <p className="hint">From the {slip?.period ? `${payslipMonth(slip.period)} ` : "latest "}payslip.</p>}</div>
                  {slipFigures && <div><p className="label">Medical allowance</p><p className="py-2 text-sm"><Money value={slipFigures.medical} /></p></div>}
                  {slipFigures && <div><p className="label">Net pay</p><p className="py-2 text-sm"><Money value={slipFigures.netPay} /></p></div>}
                </div>
                {p?.payslipDetailsUpdatedAt && <p className="hint mt-2">Last changed by the staff member <DateText value={p.payslipDetailsUpdatedAt} />.</p>}
                <h3 className="mb-3 mt-6 text-sm font-semibold text-navy">Employment</h3>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><label htmlFor="employmentStatus" className="label">Employment status</label><select id="employmentStatus" name="employmentStatus" defaultValue={p?.employmentStatus ?? ""} className="input"><option value="">Not set</option>{EMPLOYMENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select><p className="hint">Confirmed staff only may borrow.</p></div>
                  <div><label htmlFor="employmentDate" className="label">Employment date</label><input id="employmentDate" name="employmentDate" type="date" defaultValue={p?.employmentDate ?? ""} className="input" /><p className="hint">Service: {monthsText(rec.serviceMonths)}.</p></div>
                  <div><label htmlFor="designation" className="label">Designation</label><input id="designation" name="designation" defaultValue={designationOf(p) ?? ""} className="input" /></div>
                  <div><label htmlFor="schoolId" className="label">School</label><select id="schoolId" name="schoolId" defaultValue={p?.schoolId ?? ""} className="input"><option value="">Not set</option>{sch.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div><label htmlFor="departmentId" className="label">Department</label><select id="departmentId" name="departmentId" defaultValue={p?.departmentId ?? ""} className="input"><option value="">Not set</option>{dep.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div><label htmlFor="categoryId" className="label">Staff category</label><select id="categoryId" name="categoryId" defaultValue={p?.categoryId ?? ""} className="input"><option value="">Not set</option>{cat.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                </div>
                <div className="mt-6"><label htmlFor="note" className="label">Reason for change</label><input id="note" name="note" required defaultValue="Checked against the personnel record" className="input" /></div>
              </ActionForm>
            ) : (
              <KeyValues columns={3} items={[
                ["Name on payslip", p?.payslipName ?? rec.user.displayName], ["Employee code", p?.staffNumber], ["Pay grade", p?.payGrade],
                ["Monthly basic", <Money key="b" value={p?.monthlyBasic ?? slipFigures?.basic} />],
                ...(slipFigures ? [["Medical allowance", <Money key="m" value={slipFigures.medical} />], ["Net pay", <Money key="n" value={slipFigures.netPay} />]] as [string, React.ReactNode][] : []),
                ["Employment status", p?.employmentStatus?.replace("_", " ")], ["Employment date", <DateText key="e" value={p?.employmentDate} />], ["Service", monthsText(rec.serviceMonths)],
                ["Designation", designationOf(p)], ["School", rec.school?.name], ["Department", rec.department?.name], ["Category", rec.category?.name],
              ]} />
            )}
            <div className="mt-6 border-t border-line pt-4">
              <KeyValues columns={3} items={[
                ["Paid into", p?.bankName ? `${p.bankName} ••••${p.bankAccountLast4 ?? ""}` : "Salary account"], ["Last sign-in", <DateText key="l" value={rec.user.lastLoginAt} withTime />],
              ]} />
            </div>
            {editable && payrollProvider() && p?.staffNumber && <div className="mt-4"><ActionForm inline action={salaryFromPayrollAction.bind(null, id)} submitLabel="Fetch salary from payroll" submitClassName="btn-secondary h-8 text-xs" /></div>}
            {!editable && id === actor.userId && <p className="mt-4 text-sm text-muted">Another HR Administrator must update your own record.</p>}
          </Card>
          <Card title="Loan history">
            <Table caption="Applications">
              <thead><tr><Th>Application</Th><Th right>Requested</Th><Th>Status</Th><Th>Loan</Th><Th right>Outstanding</Th></tr></thead>
              <tbody>
                {apps.map((a) => {
                  const l = loans.find((x) => x.applicationId === a.id);
                  return <tr key={a.id}><Td><Link className="link" href={`/hr/applications/${a.id}`}>{a.reference}</Link></Td><Td right><Money value={a.requestedAmount} /></Td><Td><StatusBadge status={a.status} /></Td><Td>{l ? <>{l.accountNumber} <StatusBadge status={l.status} /></> : "N/A"}</Td><Td right>{l ? <Money value={dec(l.principalOutstanding).plus(l.interestOutstanding).toFixed(2)} /> : "N/A"}</Td></tr>;
                })}
                {!apps.length && <tr><Td colSpan={5} className="text-muted">No applications.</Td></tr>}
              </tbody>
            </Table>
          </Card>
        </div>
        <div className={SIDE_COLUMN}>
          <Card title="Obligations"><KeyValues columns={1} items={[["Active loans", ob.liveLoanCount], ["Monthly deductions", <Money key="m" value={ob.monthlyDeductions} />], ["Outstanding", <Money key="o" value={ob.outstanding} />]]} /></Card>
          <Card title="As guarantor">
            <KeyValues columns={1} items={[["Active guarantees", exp.liveCount], ["Total exposure", <Money key="t" value={exp.total} />]]} />
            <ul className="mt-3 space-y-1 text-sm">{exp.items.map((i) => <li key={i.guaranteeId}>{i.reference}: {i.applicantName}: <Money value={i.currentExposure} /></li>)}</ul>
          </Card>
        </div>
      </div>
    </>
  );
}
