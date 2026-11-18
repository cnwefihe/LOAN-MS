import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { departments, loanAccounts, schools, staffProfiles, users } from "@/db/schema";
import { requireActor } from "@/lib/auth/session";
import { reconciliation } from "@/server/services/loans";
import { periodName } from "@/server/services/reports";
import { deductionFilter } from "@/server/services/deduction-filter";
import { can } from "@/server/actor";
import { sum } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { ActionForm } from "@/components/action-form";
import { Card, EmptyState, PageHeader, Money, StatusBadge, Table, Th, Td, Stat, StatGrid } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { ReportDownloads } from "@/components/report-downloads";
import { importPayrollAction, syncPayrollAction } from "@/app/actions/accounts";
import { payrollProvider } from "@/server/integrations/payroll";

export const metadata = { title: "Reconciliation" };

const MONTHS = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, "0"), label: new Date(Date.UTC(2000, i, 15)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }) }));

type Search = { month?: string; year?: string; mon?: string; staff?: string; school?: string; department?: string; page?: string; size?: string };

/** The month ("2026-05") or whole year ("2026") chosen. With nothing chosen, the current month. */
function chosenPeriod(sp: Search, today: string) {
  if (/^\d{4}-\d{2}$/.test(sp.month ?? "")) return sp.month!;
  if (/^\d{4}$/.test(sp.year ?? "")) return /^(0[1-9]|1[0-2])$/.test(sp.mon ?? "") ? `${sp.year}-${sp.mon}` : sp.year!;
  return today.slice(0, 7);
}

export default async function Reconciliation({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireActor("accounts.view");
  const sp = await searchParams;
  const today = todayLagos();
  const period = chosenPeriod(sp, today);
  const [year, mon = ""] = period.split("-");
  const filter = deductionFilter(sp);
  const db = await getDb();
  const [rows, staff, schoolList, deptList] = await Promise.all([
    reconciliation(db, actor, period, filter),
    db.selectDistinct({ id: users.id, name: users.displayName, staffNumber: staffProfiles.staffNumber }).from(loanAccounts)
      .innerJoin(users, eq(users.id, loanAccounts.borrowerId)).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id)).orderBy(asc(users.displayName)),
    db.select({ id: schools.id, name: schools.name }).from(schools).orderBy(schools.name),
    db.select({ id: departments.id, name: departments.name, schoolId: departments.schoolId }).from(departments).orderBy(departments.name),
  ]);
  // Kept on every link: pages and downloads.
  const params = { year, mon, staff: filter.borrowerId, school: filter.schoolId, department: filter.departmentId };
  const exportQuery = new URLSearchParams(Object.entries({ ...(mon ? { month: period } : { year }), staff: filter.borrowerId, school: filter.schoolId, department: filter.departmentId })
    .filter(([, v]) => v) as [string, string][]).toString();
  // Payroll sync works a month at a time: the month chosen, or this month when a whole year is shown.
  const syncMonth = mon ? period : today.slice(0, 7);
  const narrowed = !!(filter.borrowerId || filter.schoolId || filter.departmentId);
  const expected = sum(rows.map((r) => r.expected));
  const received = sum(rows.map((r) => r.received));
  const exceptions = rows.filter((r) => r.state !== "matched");
  const payroll = payrollProvider();
  // Loans that need attention come first.
  const ordered = [...exceptions, ...rows.filter((r) => r.state === "matched")];
  const pg = paginate(ordered, sp.page, sp.size);
  const variance = received.minus(expected);
  const named = periodName(period);
  const hasData = rows.length > 0;
  const varianceHint = !hasData ? "Nothing due" : variance.isZero() ? "All received" : variance.isNegative() ? "Less than due" : "More than due";

  return (
    <>
      <PageHeader title="Monthly reconciliation" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Reconciliation" }]}
        description="Compare what was due each month with what was received." />
      <Card className="mb-6" bodyClassName="p-4">
        <form method="get" aria-label="Filter" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
          <div><label htmlFor="year" className="label">Year</label>
            <select id="year" name="year" defaultValue={year} className="input h-9">
              {Array.from({ length: 7 }, (_, i) => String(Number(today.slice(0, 4)) + 1 - i)).map((y) => <option key={y} value={y}>{y}</option>)}
            </select></div>
          <div><label htmlFor="mon" className="label">Month</label>
            <select id="mon" name="mon" defaultValue={mon} className="input h-9">
              <option value="">Whole year</option>
              {MONTHS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select></div>
          <div><label htmlFor="staff" className="label">Staff</label>
            <select id="staff" name="staff" defaultValue={filter.borrowerId ?? ""} className="input h-9">
              <option value="">All staff</option>
              {staff.map((x) => <option key={x.id} value={x.id}>{x.name}{x.staffNumber ? ` (${x.staffNumber})` : ""}</option>)}
            </select></div>
          <div><label htmlFor="school" className="label">School</label>
            <select id="school" name="school" defaultValue={filter.schoolId ?? ""} className="input h-9">
              <option value="">All schools</option>
              {schoolList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select></div>
          <div><label htmlFor="department" className="label">Department</label>
            <select id="department" name="department" defaultValue={filter.departmentId ?? ""} className="input h-9">
              <option value="">All departments</option>
              {deptList.filter((x) => !filter.schoolId || x.schoolId === filter.schoolId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select></div>
          <div className="flex gap-2">
            <button className="btn-primary h-9">Apply</button>
            {(narrowed || period !== today.slice(0, 7)) && <Link href="/accounts/reconciliation" className="btn-secondary h-9">Clear</Link>}
          </div>
        </form>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-3">
          <ReportDownloads label title="Deduction schedule" href={(f) => `/api/reports/export?report=payroll_deductions&format=${f}&${exportQuery}`} />
          <span className="text-xs text-muted">For {named}{narrowed ? ", as filtered" : ", all staff"}.</span>
        </div>
      </Card>
      <StatGrid>
        <Stat label="Amount due" value={<Money value={expected.toFixed(2)} />} hint={named} />
        <Stat label="Amount received" value={<Money value={received.toFixed(2)} />} hint="Confirmed repayments" tone={hasData ? "success" : "default"} />
        <Stat label="Variance" value={<Money value={variance.toFixed(2)} />} hint={varianceHint} tone={!hasData ? "default" : variance.isZero() ? "success" : "warning"} />
        <Stat label="Loans to check" value={exceptions.length} hint={hasData ? `Of ${rows.length} ${rows.length === 1 ? "loan" : "loans"}` : "None in this period"} tone={exceptions.length ? "warning" : "default"} />
      </StatGrid>
      <Card title={`Loans, ${named}`} className="mb-6" bodyClassName={hasData ? "p-5 pt-0" : undefined}>
        {hasData ? (
          <>
            <Table caption="Reconciliation">
              <thead><tr><Th>Loan</Th><Th>Borrower</Th><Th>Department</Th><Th right>Amount due</Th><Th right>Amount received</Th><Th right>Awaiting confirmation</Th><Th right>Variance</Th><Th>Result</Th></tr></thead>
              <tbody>
                {pg.items.map((r) => (
                  <tr key={r.loanId}>
                    <Td><Link className="link" href={`/accounts/loans/${r.loanId}`}>{r.accountNumber}</Link></Td>
                    <Td>{r.borrower}<p className="text-xs text-muted">{r.staffNumber}</p></Td>
                    <Td>{r.department ?? <span className="text-muted">Not set</span>}{r.school && <p className="text-xs text-muted">{r.school}</p>}</Td>
                    <Td right><Money value={r.expected} /></Td><Td right><Money value={r.received} /></Td>
                    <Td right>{r.pendingClaimCount ? <><Money value={r.pendingClaims} /> ({r.pendingClaimCount})</> : "None"}</Td>
                    <Td right><Money value={r.variance} /></Td><Td><StatusBadge status={r.state} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination data={pg} base="/accounts/reconciliation" params={params} label="loans" />
          </>
        ) : <EmptyState title={`Nothing to reconcile for ${named}`} description={narrowed ? "Nothing was due or received for the staff, school or department chosen. Change the filter above." : "No repayments were due or received in this period. Choose another month or year above."} />}
      </Card>
      {can(actor, "repayment.confirm") && (
        <Card title="Import payroll deductions" description="CSV columns: staff_number, amount, reference, value_date (optional).">
          <ActionForm action={importPayrollAction} submitLabel="Import" encType="multipart/form-data" confirm="Post all rows in this file as repayments?">
            <div className="grid gap-4 md:grid-cols-2">
              <div><label htmlFor="csv" className="label">CSV file</label><input id="csv" name="csv" type="file" accept=".csv,text/csv" required className="input py-1.5" /></div>
              <div><label htmlFor="valueDate" className="label">Default value date</label><input id="valueDate" name="valueDate" type="date" max={todayLagos()} defaultValue={todayLagos()} className="input" /></div>
            </div>
          </ActionForm>
          {payroll ? (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Sync from payroll system</h3>
              <ActionForm action={syncPayrollAction} submitLabel="Fetch and post deductions" variant="secondary" confirm={`Fetch ${periodName(syncMonth)} loan deductions from payroll and post them?`}>
                <input type="hidden" name="month" value={syncMonth} />
                <p className="text-xs text-muted">Pulls {periodName(syncMonth)} deductions from payroll. References already posted are skipped.</p>
              </ActionForm>
            </div>
          ) : <p className="mt-3 text-xs text-muted">Payroll connection not set up. Use the CSV import.</p>}
        </Card>
      )}
    </>
  );
}
