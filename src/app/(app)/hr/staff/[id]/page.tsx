import Link from "next/link";
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
import { Card, KeyValues, Money, PageHeader, StatusBadge, Table, Th, Td, DateText, Badge } from "@/components/ui";
import { staffRecordAction, salaryFromPayrollAction, staffConfirmationAction } from "@/app/actions/staff-ops";
import { payrollProvider } from "@/server/integrations/payroll";
import { PayslipDetails, payslipDetailsBadge } from "@/components/payslip-details";
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
  const [sch, dep, cat] = editable ? await Promise.all([db.select().from(schools), db.select().from(departments), db.select().from(staffCategories)]) : [[], [], []];

  return (
    <>
      <PageHeader title={rec.user.displayName} crumbs={[{ label: "Human Resources", href: "/hr" }, { label: "Staff", href: "/hr/staff" }, { label: rec.user.displayName }]} description={rec.user.email}
        actions={rec.salaryVerified ? <Badge tone="success">Salary verified <DateText value={p?.salaryVerifiedAt} /></Badge> : <Badge tone="warning">Salary unverified</Badge>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Confirmation" description="Only confirmed staff can apply for a loan or act as a guarantor."
            actions={p?.employmentStatus === "confirmed" ? <Badge tone="success">Confirmed</Badge> : p?.employmentStatus ? <Badge tone="danger">Not confirmed</Badge> : <Badge tone="warning">Not recorded</Badge>}>
            {editable ? (
              <div role="group" aria-label="Confirmation status" className="flex flex-wrap items-start gap-2">
                {([[true, "Confirmed", `Mark ${rec.user.displayName} as confirmed staff?`],
                  [false, "Not confirmed", `Mark ${rec.user.displayName} as not confirmed? They cannot borrow or guarantee until confirmed.`]] as const).map(([value, label, question]) => {
                  const active = value ? p?.employmentStatus === "confirmed" : !!p?.employmentStatus && p.employmentStatus !== "confirmed";
                  return active
                    ? <span key={label} aria-current="true" className="btn border border-brand bg-brand-50 font-semibold text-brand">{label}</span>
                    : <ActionForm key={label} inline action={staffConfirmationAction.bind(null, id, value)} submitLabel={label} variant="secondary" confirm={question} />;
                })}
              </div>
            ) : <p className="text-sm text-muted">{id === actor.userId ? "Another HR Administrator must update your own record." : "Only an HR Administrator can change this."}</p>}
          </Card>
          <Card title="Payslip details" description="Entered by the staff member from their payslip. Check them against the personnel record." actions={payslipDetailsBadge(p)}>
            <PayslipDetails userId={id} displayName={rec.user.displayName} profile={p} canConfirm={editable} back={`/hr/staff/${id}`} />
          </Card>
          <Card title="Employment and salary">
            <KeyValues columns={3} items={[
              ["Staff number", p?.staffNumber], ["School", rec.school?.name], ["Department", rec.department?.name], ["Designation", p?.designation], ["Pay grade", p?.payGrade], ["Category", rec.category?.name],
              ["Status", p?.employmentStatus?.replace("_", " ")], ["Employment date", <DateText key="e" value={p?.employmentDate} />], ["Confirmation date", <DateText key="c" value={p?.confirmationDate} />], ["Service", `${monthsText(rec.serviceMonths)}`],
              ["Monthly basic", <Money key="b" value={p?.monthlyBasic} />], ["Monthly gross", <Money key="g" value={p?.monthlyGross} />], ["Monthly net", <Money key="n" value={p?.monthlyNet} />],
              ["Bank", p?.bankName ? `${p.bankName} ••••${p.bankAccountLast4 ?? ""}` : "N/A"], ["Directory job title", p?.entraJobTitle], ["Last sign-in", <DateText key="l" value={rec.user.lastLoginAt} withTime />],
            ]} />
          </Card>
          {editable && (
            <Card title="Update Human Resources record" description="Saving salary figures marks them as verified by Human Resources."
              actions={payrollProvider() && p?.staffNumber ? <ActionForm inline action={salaryFromPayrollAction.bind(null, id)} submitLabel="Fetch salary from payroll" submitClassName="btn-secondary h-8 text-xs" /> : undefined}>
              <ActionForm action={staffRecordAction.bind(null, id)} submitLabel="Save record">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><label htmlFor="staffNumber" className="label">Staff number</label><input id="staffNumber" name="staffNumber" defaultValue={p?.staffNumber ?? ""} className="input" /></div>
                  <div><label htmlFor="schoolId" className="label">School</label><select id="schoolId" name="schoolId" defaultValue={p?.schoolId ?? ""} className="input"><option value="">Not set</option>{sch.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div><label htmlFor="departmentId" className="label">Department</label><select id="departmentId" name="departmentId" defaultValue={p?.departmentId ?? ""} className="input"><option value="">Not set</option>{dep.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div><label htmlFor="categoryId" className="label">Staff category</label><select id="categoryId" name="categoryId" defaultValue={p?.categoryId ?? ""} className="input"><option value="">Not set</option>{cat.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
                  <div><label htmlFor="designation" className="label">Designation</label><input id="designation" name="designation" defaultValue={p?.designation ?? ""} className="input" /></div>
                  <div><label htmlFor="employmentStatus" className="label">Employment status</label><select id="employmentStatus" name="employmentStatus" defaultValue={p?.employmentStatus ?? ""} className="input"><option value="">Not set</option>{EMPLOYMENT_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></div>
                  <div><label htmlFor="employmentDate" className="label">Employment date</label><input id="employmentDate" name="employmentDate" type="date" defaultValue={p?.employmentDate ?? ""} className="input" /></div>
                  <div><label htmlFor="confirmationDate" className="label">Confirmation date</label><input id="confirmationDate" name="confirmationDate" type="date" defaultValue={p?.confirmationDate ?? ""} className="input" /></div>
                  <div><label htmlFor="payslipName" className="label">Name on payslip</label><input id="payslipName" name="payslipName" defaultValue={p?.payslipName ?? ""} placeholder={rec.user.displayName} className="input" /></div>
                  <div><label htmlFor="payGrade" className="label">Pay grade</label><input id="payGrade" name="payGrade" defaultValue={p?.payGrade ?? ""} className="input" /><p className="hint">Exactly as on the payslip.</p></div>
                  <div><label htmlFor="monthlyBasic" className="label">Monthly basic salary (₦)</label><input id="monthlyBasic" name="monthlyBasic" inputMode="decimal" defaultValue={p?.monthlyBasic ?? ""} className="input" /></div>
                  <p className="hint sm:col-span-2 sm:self-end">For the record. Loan eligibility is worked out from the staff member&apos;s payslip.</p>
                  <div className="sm:col-span-3"><label htmlFor="note" className="label">Reason for change</label><input id="note" name="note" required className="input" /></div>
                </div>
              </ActionForm>
            </Card>
          )}
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
        <div className="space-y-6">
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
