import Link from "next/link";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { reconciliation } from "@/server/services/loans";
import { monthName } from "@/server/services/reports";
import { can } from "@/server/actor";
import { sum } from "@/lib/finance/money";
import { todayLagos } from "@/lib/finance/dates";
import { ActionForm } from "@/components/action-form";
import { Card, EmptyState, PageHeader, Money, StatusBadge, Table, Th, Td, Stat, StatGrid } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { MonthToolbar, ReportDownloads } from "@/components/report-downloads";
import { importPayrollAction, syncPayrollAction } from "@/app/actions/accounts";
import { payrollProvider } from "@/server/integrations/payroll";

export const metadata = { title: "Reconciliation" };

export default async function Reconciliation({ searchParams }: { searchParams: Promise<{ month?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("accounts.view");
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : todayLagos().slice(0, 7);
  const rows = await reconciliation(await getDb(), actor, month);
  const expected = sum(rows.map((r) => r.expected));
  const received = sum(rows.map((r) => r.received));
  const exceptions = rows.filter((r) => r.state !== "matched");
  const payroll = payrollProvider();
  // Loans that need attention come first.
  const ordered = [...exceptions, ...rows.filter((r) => r.state === "matched")];
  const pg = paginate(ordered, sp.page, sp.size);
  const variance = received.minus(expected);
  const named = monthName(month);
  const hasData = rows.length > 0;
  const varianceHint = !hasData ? "Nothing due" : variance.isZero() ? "All received" : variance.isNegative() ? "Less than due" : "More than due";

  return (
    <>
      <PageHeader title="Monthly reconciliation" crumbs={[{ label: "Bursary", href: "/accounts" }, { label: "Reconciliation" }]}
        description="Compare what was due each month with what was received." />
      <MonthToolbar month={month}>
        <ReportDownloads label title="Deduction schedule" href={(f) => `/api/reports/export?report=payroll_deductions&format=${f}&month=${month}`} />
      </MonthToolbar>
      <StatGrid>
        <Stat label="Amount due" value={<Money value={expected.toFixed(2)} />} hint={named} />
        <Stat label="Amount received" value={<Money value={received.toFixed(2)} />} hint="Confirmed repayments" tone={hasData ? "success" : "default"} />
        <Stat label="Variance" value={<Money value={variance.toFixed(2)} />} hint={varianceHint} tone={!hasData ? "default" : variance.isZero() ? "success" : "warning"} />
        <Stat label="Loans to check" value={exceptions.length} hint={hasData ? `Of ${rows.length} ${rows.length === 1 ? "loan" : "loans"}` : "None this month"} tone={exceptions.length ? "warning" : "default"} />
      </StatGrid>
      <Card title={`Loans, ${named}`} className="mb-6" bodyClassName={hasData ? "p-5 pt-0" : undefined}>
        {hasData ? (
          <>
            <Table caption="Reconciliation">
              <thead><tr><Th>Loan</Th><Th>Borrower</Th><Th right>Amount due</Th><Th right>Amount received</Th><Th right>Awaiting confirmation</Th><Th right>Variance</Th><Th>Result</Th></tr></thead>
              <tbody>
                {pg.items.map((r) => (
                  <tr key={r.loanId}>
                    <Td><Link className="link" href={`/accounts/loans/${r.loanId}`}>{r.accountNumber}</Link></Td>
                    <Td>{r.borrower}<p className="text-xs text-muted">{r.staffNumber}</p></Td>
                    <Td right><Money value={r.expected} /></Td><Td right><Money value={r.received} /></Td>
                    <Td right>{r.pendingClaimCount ? <><Money value={r.pendingClaims} /> ({r.pendingClaimCount})</> : "None"}</Td>
                    <Td right><Money value={r.variance} /></Td><Td><StatusBadge status={r.state} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination data={pg} base="/accounts/reconciliation" params={sp} label="loans" />
          </>
        ) : <EmptyState title={`Nothing to reconcile for ${named}`} description="No repayments were due or received this month. Choose another month above." />}
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
              <ActionForm action={syncPayrollAction} submitLabel="Fetch and post deductions" variant="secondary" confirm={`Fetch ${named} loan deductions from payroll and post them?`}>
                <input type="hidden" name="month" value={month} />
                <p className="text-xs text-muted">Pulls {named} deductions from payroll. References already posted are skipped.</p>
              </ActionForm>
            </div>
          ) : <p className="mt-3 text-xs text-muted">Payroll connection not set up. Use the CSV import.</p>}
        </Card>
      )}
    </>
  );
}
