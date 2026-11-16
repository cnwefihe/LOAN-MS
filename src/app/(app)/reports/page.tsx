import { Fragment } from "react";
import { getDb } from "@/db";
import { requireActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { portfolioSummary, departmentDistribution, guarantorExposureReport, repaymentPerformance, executiveSummary, arrearsAgeing, reportParams, basisText, monthName, REPORTS, type ReportKey } from "@/server/services/reports";
import { formatDate } from "@/lib/finance/dates";
import { Card, PageHeader, Stat, StatGrid, Money, Table, Tabs, Th, Td } from "@/components/ui";
import { paginate, Pagination } from "@/components/pagination";
import { ReportDownloads } from "@/components/report-downloads";
import { RowMenu } from "@/components/row-menu";
import { CollectionChart, BarList } from "@/components/charts";
import { OverviewHeading } from "@/components/approval-overview";

export const metadata = { title: "Reports and analytics" };


const TABS = [
  { key: "summary", label: "Summary" },
  { key: "performance", label: "Performance" },
  { key: "departments", label: "Departments" },
  { key: "guarantors", label: "Guarantors" },
  { key: "library", label: "Report library" },
];

const AREAS = ["Portfolio", "Human Resources", "Bursary", "Guarantors", "Administration"] as const;
const REPORT_AREA: Record<ReportKey, (typeof AREAS)[number]> = {
  loan_book: "Portfolio", overdue: "Portfolio", ageing: "Portfolio", repayment_performance: "Portfolio", departments: "Portfolio",
  applications: "Human Resources",
  disbursements: "Bursary", collections: "Bursary", repayment_claims: "Bursary", payroll_deductions: "Bursary",
  guarantor_exposure: "Guarantors",
  audit: "Administration",
};

const GROUPS = [
  { basis: "as_at", title: "Position reports" },
  { basis: "period", title: "Registers for the selected period" },
  { basis: "month", title: "Monthly payroll" },
] as const;

export default async function Reports({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; month?: string; tab?: string; area?: string; page?: string; size?: string }> }) {
  const actor = await requireActor("reports.view");
  const db = await getDb();
  const sp = await searchParams;
  const p = reportParams(sp);
  const isAdmin = actor.roles.includes("SUPER_ADMIN");
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : TABS[0].key;
  const area = AREAS.find((a) => a === sp.area) ?? "";
  const tabBase = `/reports?from=${p.from}&to=${p.to}&month=${p.month}`;
  const [s, depts, guarantors, perf, exec, ageing] = await Promise.all([portfolioSummary(db, actor), departmentDistribution(db, actor), guarantorExposureReport(db, actor), repaymentPerformance(db, actor), executiveSummary(db, actor), arrearsAgeing(db, actor)]);
  const guarantorPage = paginate(guarantors, sp.page, sp.size);
  const exportable = can(actor, "reports.export");
  const rate = (label: string) => { const v = exec.tiles.find((x) => x.label === label)?.value; return !v || v === "Not yet" ? "N/A" : v; };
  const allowed = (k: ReportKey) => can(actor, REPORTS[k].permission);
  const query = (k: ReportKey) => REPORTS[k].basis === "period" ? `&from=${p.from}&to=${p.to}` : REPORTS[k].basis === "month" ? `&month=${p.month}` : "";
  const groupNote = { as_at: "Balances as at today.", period: `${formatDate(p.from)} to ${formatDate(p.to)}. Change the period above.`, month: `Deductions for ${monthName(p.month)}. Change the month above.` };

  return (
    <>
      <PageHeader title="Reports and analytics" description="Portfolio performance and report downloads." />
      <Tabs base={tabBase} active={tab} tabs={TABS} />
      {tab === "summary" && <>
      <p className="mb-4 text-sm text-muted">Position as at {formatDate(exec.asOf)}.</p>
      <OverviewHeading>Portfolio</OverviewHeading>
      <StatGrid>
        <Stat label="Amount disbursed" value={<Money value={s.loans.disbursed} />} hint={`${s.loans.awaitingDisbursement} awaiting payment`} />
        <Stat label="Amount recovered" value={<Money value={s.loans.recovered} />} hint="Repayments received" />
        <Stat label="Outstanding balance" value={<Money value={s.loans.outstanding} />} hint={`${s.loans.activeCount} active, ${s.loans.closedCount} closed`} tone="brand" />
        <Stat label="Collection rate" value={rate("Collection rate (12m)")} hint="Last 12 months" />
      </StatGrid>
      <OverviewHeading>Loan health</OverviewHeading>
      <StatGrid>
        <Stat label="Overdue loans" value={s.loans.overdueCount} hint={<Money value={s.loans.overdueAmount} />} tone={s.loans.overdueCount ? "warning" : "default"} />
        <Stat label="Defaulted loans" value={s.loans.defaultedCount} hint={<Money value={s.loans.defaultedAmount} />} tone={s.loans.defaultedCount ? "danger" : "default"} />
        <Stat label="Portfolio at risk" value={rate("Portfolio at risk")} hint="Share of the balance overdue or in default" />
        <Stat label="Guarantors with exposure" value={guarantors.length} hint={`${depts.filter((d) => d.liveLoans > 0).length} departments borrowing`} />
      </StatGrid>
      <OverviewHeading>Applications</OverviewHeading>
      <StatGrid>
        <Stat label="Total applications" value={s.applications.total} hint={`${s.applications.inProgress} in progress`} />
        <Stat label="Approved" value={s.applications.approved} hint={`Approval rate: ${rate("Approval rate")}`} />
        <Stat label="Declined" value={s.applications.declined} hint={`${s.applications.cancelled} cancelled`} />
        <Stat label="Amount requested" value={<Money value={s.applications.requested} />} hint="All applications" />
      </StatGrid>
      <Card title="Key points" description="Also at the front of every report in the Report library.">
        <ul className="list-disc space-y-1 pl-5 text-sm">{exec.points.map((p) => <li key={p}>{p}</li>)}</ul>
      </Card>
      </>}
      {tab === "performance" && <>
      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Card title="Repayment performance" description="Due against collected, last 12 months." className="h-full">
          <CollectionChart data={perf} title="Monthly collections (₦)" />
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-brand">Table view</summary>
            <Table caption="Repayment performance" className="mt-2">
              <thead><tr><Th>Month</Th><Th right>Expected</Th><Th right>Collected</Th><Th right>Rate</Th></tr></thead>
              <tbody>{perf.map((p) => <tr key={p.month}><Td>{p.month}</Td><Td right><Money value={p.expected} /></Td><Td right><Money value={p.collected} /></Td><Td right>{p.rate === null ? "N/A" : `${p.rate}%`}</Td></tr>)}</tbody>
            </Table>
          </details>
        </Card>
        <Card title="Arrears ageing" description="Active loans by days past due." className="h-full">
          <Table caption="Arrears ageing">
            <thead><tr><Th>Days past due</Th><Th right>Loans</Th><Th right>Outstanding</Th><Th right>Share</Th></tr></thead>
            <tbody>{ageing.map((a) => <tr key={a.bucket}><Td>{a.bucket}</Td><Td right>{a.loans}</Td><Td right><Money value={a.outstanding} /></Td><Td right>{a.share}%</Td></tr>)}</tbody>
          </Table>
        </Card>
      </div>
      </>}
      {tab === "departments" && <>
      <Card title="Borrowing by department" description="Outstanding balances, active loans and approvals for each department." className="mb-6">
        {depts.length ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <BarList title="Outstanding (₦)" data={depts.map((d) => ({ label: d.department, value: d.outstanding, note: `${d.liveLoans} active loans` }))} />
            <Table caption="Borrowing by department">
              <thead><tr><Th>Department</Th><Th right>Applications</Th><Th right>Active loans</Th><Th right>Approved</Th><Th right>Outstanding</Th></tr></thead>
              <tbody>{depts.map((d) => <tr key={d.department}><Td>{d.department}</Td><Td right>{d.applications}</Td><Td right>{d.liveLoans}</Td><Td right><Money value={d.approvedPrincipal} /></Td><Td right><Money value={d.outstanding} /></Td></tr>)}</tbody>
            </Table>
          </div>
        ) : <p className="py-6 text-center text-sm text-muted">No data yet.</p>}
      </Card>
      </>}
      {tab === "guarantors" && <>
      <Card title="Guarantor exposure" description="What each guarantor could be asked to repay if the borrowers they guarantee do not." className="mb-6">
        {guarantors.length ? (
          <Table caption="Guarantor exposure">
            <thead><tr><Th>Guarantor</Th><Th right>Active guarantees</Th><Th right>Loans not yet disbursed</Th><Th right>Disbursed loans</Th><Th right>Total</Th></tr></thead>
            <tbody>{guarantorPage.items.map((g) => <tr key={g.guarantorId}><Td>{g.name}</Td><Td right>{g.liveGuarantees}</Td><Td right><Money value={g.potential} /></Td><Td right><Money value={g.actual} /></Td><Td right><Money value={g.total} /></Td></tr>)}</tbody>
          </Table>
        ) : <p className="py-6 text-center text-sm text-muted">No active guarantees.</p>}
        <Pagination data={guarantorPage} base="/reports" params={{ tab, from: sp.from, to: sp.to, month: sp.month }} label="guarantors" />
      </Card>
      </>}
      {tab === "library" && isAdmin && <>
      <form method="get" className="mb-4 grid items-end gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
        <input type="hidden" name="tab" value="library" />
        <div><label htmlFor="area" className="label">Area</label><select id="area" name="area" defaultValue={area} className="input h-9 py-0"><option value="">All areas</option>{AREAS.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div><label htmlFor="from" className="label">Period from</label><input id="from" name="from" type="date" defaultValue={p.from} className="input h-9 py-0" /></div>
        <div><label htmlFor="to" className="label">Period to</label><input id="to" name="to" type="date" defaultValue={p.to} className="input h-9 py-0" /></div>
        <div><label htmlFor="month" className="label">Payroll month</label><input id="month" name="month" type="month" defaultValue={p.month} className="input h-9 py-0" /></div>
        <button className="btn-primary">Apply</button>
      </form>
      <Card title="Report library" description="Downloads are recorded under Activity." bodyClassName="px-5 pt-0 pb-5">
        <Table caption="All reports">
          <thead><tr><Th>Report</Th><Th>What it shows</Th><Th>Covers</Th><Th><span className="sr-only">Download</span></Th></tr></thead>
          <tbody>
            {AREAS.filter((x) => !area || x === area).map((x) => {
              const keys = (Object.keys(REPORTS) as ReportKey[]).filter((k) => allowed(k) && REPORT_AREA[k] === x);
              const portfolio = x === "Portfolio" && exportable;
              if (!keys.length && !portfolio) return null;
              const row = (title: string, about: string, covers: string, formats: [string, string][]) => (
                <tr key={title}>
                  <Td className="font-medium">{title}</Td>
                  <Td className="min-w-64 text-muted whitespace-normal!">{about}</Td>
                  <Td>{covers}</Td>
                  <Td right><RowMenu label={`${title} download`} items={formats.map(([label, href]) => ({ label: `Download ${label}`, href, download: true }))} /></Td>
                </tr>
              );
              const links = (k: string, extra: string, kinds: [string, string][]) => kinds.map(([label, f]) => [label, `/api/reports/export?report=${k}&format=${f}${extra}`] as [string, string]);
              return (
                <Fragment key={x}>
                  <tr><th colSpan={4} scope="colgroup" className="border-b border-line bg-brand-50 px-5 py-2 text-left text-xs font-semibold uppercase tracking-wide text-brand">{x}</th></tr>
                  {portfolio && row("Portfolio report", "Everything in one report: activity, position, performance, arrears, departments and guarantors.", `${formatDate(p.from)} to ${formatDate(p.to)}`, links("portfolio", `&from=${p.from}&to=${p.to}`, [["PDF", "pdf"], ["Excel", "xlsx"]]))}
                  {keys.map((k) => row(REPORTS[k].title, REPORTS[k].description, basisText(k, p), links(k, query(k), [["PDF", "pdf"], ["Excel", "xlsx"], ["CSV", "csv"]])))}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </Card>
      </>}
      {tab === "library" && !isAdmin && <>
      <Card title="Report library" description={exportable ? "Downloads are recorded in the audit log." : "Your role can view reports but not export them."}>
        <form method="get" className="mb-5 grid items-center gap-2.5 rounded-lg border border-line bg-canvas p-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <input type="hidden" name="tab" value="library" />
          <div className="flex items-center gap-2"><label htmlFor="from" className="shrink-0 text-sm font-medium text-slate-700">Period from</label><input id="from" name="from" type="date" defaultValue={p.from} className="input h-9 min-w-0 flex-1" /></div>
          <div className="flex items-center gap-2"><label htmlFor="to" className="shrink-0 text-sm font-medium text-slate-700">Period to</label><input id="to" name="to" type="date" defaultValue={p.to} className="input h-9 min-w-0 flex-1" /></div>
          <div className="flex items-center gap-2"><label htmlFor="month" className="shrink-0 text-sm font-medium text-slate-700">Payroll month</label><input id="month" name="month" type="month" defaultValue={p.month} className="input h-9 min-w-0 flex-1" /></div>
          <button className="btn-primary">Apply</button>
        </form>
        {exportable && (
          <section className="mb-6">
            <div className="rounded-md border-l-4 border-navy bg-brand-50 px-4 py-2.5">
              <h3 className="text-[0.9375rem] font-bold text-navy">Portfolio report</h3>
              <p className="text-xs text-slate-600">All staff loans in one report: balances as at today, and activity from {formatDate(p.from)} to {formatDate(p.to)}. Change the period above.</p>
            </div>
            <ul className="mt-1 divide-y divide-line px-1">
              <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="min-w-0"><span className="block text-sm font-medium">Portfolio report</span><span className="block text-xs text-muted">Summary, activity in the period, position, repayment performance, arrears, departments and guarantors. The Excel file adds the full loan book.</span></span>
                <ReportDownloads title="Portfolio report" formats={["pdf", "xlsx"]} href={(f) => `/api/reports/export?report=portfolio&format=${f}&from=${p.from}&to=${p.to}`} />
              </li>
            </ul>
          </section>
        )}
        {GROUPS.map((g) => {
          const keys = (Object.keys(REPORTS) as ReportKey[]).filter((k) => REPORTS[k].basis === g.basis && allowed(k));
          if (!keys.length) return null;
          return (
            <section key={g.basis} className="mb-6 last:mb-0">
              <div className="rounded-md border-l-4 border-navy bg-brand-50 px-4 py-2.5">
                <h3 className="text-[0.9375rem] font-bold text-navy">{g.title}</h3>
                <p className="text-xs text-slate-600">{groupNote[g.basis]}</p>
              </div>
              <ul className="mt-1 divide-y divide-line px-1">
                {keys.map((key) => (
                  <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="min-w-0"><span className="block text-sm font-medium">{REPORTS[key].title}</span><span className="block text-xs text-muted">{REPORTS[key].description}</span></span>
                    <ReportDownloads title={REPORTS[key].title} href={(f) => `/api/reports/export?report=${key}&format=${f}${query(key)}`} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </Card>
      </>}
    </>
  );
}
