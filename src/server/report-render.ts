/**
 * Renders report datasets as structured PDF, Excel and CSV documents.
 *
 * PDF reports follow one standard layout: document control panel, then numbered sections for the
 * executive summary, the detail (with totals), notes and definitions, and review and sign-off.
 */
import ExcelJS from "exceljs";
import type { Executor } from "@/db";
import type { Actor } from "./actor";
import { getBranding, type Branding } from "./branding";
import { PdfBuilder, type SummaryItem } from "./pdf";
import {
  REPORTS, STANDARD_NOTES, humanise, monthName, portfolioSummary, repaymentPerformance, arrearsAgeing, departmentDistribution,
  guarantorExposureReport, loanBook, executiveSummary, buildDataset, reportParams, type Column, type Dataset, type ReportKey, type ExecutiveSummary, type ReportParams,
} from "./services/reports";
import { formatNaira, sum, m, dec } from "@/lib/finance/money";
import { formatDate, formatDateTime, todayLagos } from "@/lib/finance/dates";

const amount = (v: unknown) => formatNaira(String(v ?? 0)).replace("₦", "");

/** Display text for one cell, by column type. */
export function displayCell(c: Column, v: unknown): string {
  if (v === null || v === undefined || v === "") return c.type === "money" ? "0.00" : "";
  switch (c.type) {
    case "money": return amount(v);
    case "date": return formatDate(v as string | Date);
    case "datetime": return formatDateTime(v as string | Date);
    case "status": return humanise(v);
    case "percent": return `${v}%`;
    default: return v instanceof Date ? formatDate(v) : String(v);
  }
}

function totalsRow(ds: Dataset): string[] | undefined {
  if (!ds.columns.some((c) => c.total)) return undefined;
  return ds.columns.map((c, i) => {
    if (i === 0) return `Total (${ds.rows.length})`;
    if (!c.total) return "";
    const t = m(sum(ds.rows.map((r) => String(r[c.key] ?? 0))));
    return c.type === "money" ? amount(t) : String(Number(t));
  });
}

const tileValue = (t: ExecutiveSummary["tiles"][number]) => (t.money ? formatNaira(t.value) : t.value);

function controlItems(brand: Branding, pdf: PdfBuilder, actor: Actor, basis: string, extra: [string, string][] = []): [string, string][] {
  return [
    ["Reporting basis", basis],
    ["Classification", `${brand.confidentialMarking}`],
    ["Prepared for", actor.displayName],
    ["Prepared on", pdf.issuedAt],
    ["Data source", `${brand.systemName} confirmed ledger`],
    ["Distribution", "Authorised users only"],
    ...extra,
  ];
}

function closing(pdf: PdfBuilder, actor: Actor, notes: string[]) {
  pdf.heading("Notes and definitions");
  pdf.numberedList([...notes, ...STANDARD_NOTES]);
  pdf.heading("Review and sign-off");
  pdf.signOff([
    { role: "Prepared by", name: actor.displayName, date: formatDate(todayLagos()) },
    { role: "Reviewed by" },
    { role: "Approved by" },
  ]);
}

/** One dataset as a formal report. */
export async function datasetPdf(db: Executor, actor: Actor, key: ReportKey, ds: Dataset): Promise<Buffer> {
  const brand = await getBranding(db);
  const meta = REPORTS[key];
  const pdf = await PdfBuilder.create(db, { kind: "report", title: ds.title, subtitle: meta.description, landscape: "landscape" in meta && meta.landscape, numbered: true });
  pdf.controlPanel(controlItems(brand, pdf, actor, ds.basis, [["Records", String(ds.rows.length)], ["Report code", key.toUpperCase()]]));
  const tiles: SummaryItem[] = [{ label: "Records", value: String(ds.rows.length) }];
  for (const c of ds.columns.filter((x) => x.total)) {
    const t = m(sum(ds.rows.map((r) => String(r[c.key] ?? 0))));
    tiles.push({ label: c.label, value: c.type === "money" ? formatNaira(t) : String(Number(t)) });
  }
  pdf.summary(tiles.slice(0, 5), ds.points);
  pdf.heading(key === "payroll_deductions" ? "Deduction schedule" : "Detail");
  if (ds.columns.some((c) => c.type === "money")) pdf.note("Amounts in NGN.");
  pdf.table(ds.columns.map((c) => c.label), ds.rows.map((r) => ds.columns.map((c) => displayCell(c, r[c.key]))), {
    align: ds.columns.map((c) => (c.type === "money" || c.type === "number" || c.type === "percent" ? "right" : "left")),
    totals: totalsRow(ds),
  });
  closing(pdf, actor, ds.notes);
  return pdf.finish(db, actor, { entityType: "report", entityId: key });
}

/** The monthly portfolio report: the summary, then every key view of the portfolio, in one document. */
export async function managementPdf(db: Executor, actor: Actor, period: ReportParams = reportParams({})): Promise<Buffer> {
  const brand = await getBranding(db);
  const [summary, s, perf, ageing, depts, guarantors, book, apps, paid, received] = await Promise.all([
    executiveSummary(db, actor), portfolioSummary(db, actor), repaymentPerformance(db, actor), arrearsAgeing(db, actor),
    departmentDistribution(db, actor), guarantorExposureReport(db, actor), loanBook(db, actor),
    buildDataset(db, actor, "applications", period), buildDataset(db, actor, "disbursements", period), buildDataset(db, actor, "collections", period),
  ]);
  const pdf = await PdfBuilder.create(db, { kind: "report", title: "Portfolio Report", subtitle: `Staff loan portfolio position as at ${formatDate(summary.asOf)}`, numbered: true });
  pdf.controlPanel(controlItems(brand, pdf, actor, `Balances as at ${formatDate(summary.asOf)}; activity from ${formatDate(period.from)} to ${formatDate(period.to)}`, [["Report code", "PORTFOLIO"], ["Frequency", "Monthly"]]));
  pdf.summary(summary.tiles.map((t) => ({ label: t.label, value: tileValue(t), tone: t.tone })), summary.points);

  pdf.heading(`Activity from ${formatDate(period.from)} to ${formatDate(period.to)}`);
  pdf.note("Amounts in NGN. Change the period in the report library before downloading.");
  const total = (rows: Record<string, unknown>[], key: string) => amount(rows.reduce((t, r) => t + Number(r[key] ?? 0), 0).toFixed(2));
  pdf.table(["Measure", "Number", "Amount"], [
    ["Applications submitted", String(apps.rows.length), total(apps.rows, "requested")],
    ["Loans disbursed", String(paid.rows.length), total(paid.rows, "disbursed")],
    ["Repayments received", String(received.rows.length), total(received.rows, "amount")],
  ], { align: ["left", "right", "right"] });

  pdf.heading("Portfolio position");
  pdf.note("Amounts in NGN.");
  const row = (label: string, count: number | string, value?: string): string[] => [label, String(count), value === undefined ? "" : amount(value)];
  pdf.table(["Measure", "Number", "Amount"], [
    row("Applications submitted", s.applications.total, s.applications.requested),
    row("Applications approved", s.applications.approved),
    row("Applications declined", s.applications.declined),
    row("Applications in progress", s.applications.inProgress),
    row("Loans approved", "", s.loans.approvedAmount),
    row("Awaiting disbursement", s.loans.awaitingDisbursement),
    row("Disbursed to date", "", s.loans.disbursed),
    row("Recovered to date", "", s.loans.recovered),
    row("Active loans", s.loans.activeCount),
    row("Overdue loans", s.loans.overdueCount, s.loans.overdueAmount),
    row("Defaulted loans", s.loans.defaultedCount, s.loans.defaultedAmount),
    row("Closed (fully repaid)", s.loans.closedCount),
    row("Total outstanding", s.loans.activeCount + s.loans.overdueCount + s.loans.defaultedCount, s.loans.outstanding),
  ], { align: ["left", "right", "right"] });

  pdf.heading("Repayment performance");
  pdf.barChart(perf.map((p) => monthName(p.month).replace(/(\w{3})\w* (\d{2})(\d{2})/, "$1 $3")), [
    { name: "Expected", values: perf.map((p) => Number(p.expected)) },
    { name: "Collected", values: perf.map((p) => Number(p.collected)) },
  ], { axisLabel: "NGN" });
  const exp = sum(perf.map((p) => p.expected));
  const col = sum(perf.map((p) => p.collected));
  pdf.table(["Month", "Expected", "Collected", "Collection rate"], perf.map((p) => [monthName(p.month), amount(p.expected), amount(p.collected), p.rate === null ? "N/A" : `${p.rate}%`]), {
    align: ["left", "right", "right", "right"],
    totals: ["Total (12 months)", amount(m(exp)), amount(m(col)), exp.isZero() ? "N/A" : `${col.div(exp).times(100).toFixed(1)}%`],
  });

  pdf.heading("Arrears ageing");
  pdf.table(["Days past due", "Loans", "Outstanding", "Share of portfolio"], ageing.map((a) => [a.bucket, String(a.loans), amount(a.outstanding), `${a.share}%`]), {
    align: ["left", "right", "right", "right"],
    totals: ["Total live portfolio", String(ageing.reduce((n, a) => n + a.loans, 0)), amount(m(sum(ageing.map((a) => a.outstanding)))), ageing.some((a) => a.loans) ? "100%" : "0%"],
  });

  const attention = book.filter((r) => r.status === "overdue" || r.status === "defaulted").sort((a, b) => b.daysPastDue - a.daysPastDue);
  pdf.heading("Loans requiring attention");
  if (attention.length > 25) pdf.note(`The 25 loans with the oldest arrears are shown, out of ${attention.length}. The full list is in the Overdue and defaulted loans report.`);
  pdf.table(["Account", "Borrower", "Department", "Status", "Outstanding", "Days past due"], attention.slice(0, 25).map((r) => [
    r.accountNumber, r.borrower, r.department ?? "", humanise(r.status), amount(m(dec(r.principalOutstanding).plus(r.interestOutstanding))), String(r.daysPastDue),
  ]), { align: ["left", "left", "left", "left", "right", "right"] });

  pdf.heading("Departmental distribution");
  pdf.table(["Department", "Applications", "Active loans", "Approved principal", "Outstanding"], depts.map((d) => [d.department, String(d.applications), String(d.liveLoans), amount(d.approvedPrincipal), amount(d.outstanding)]), {
    align: ["left", "right", "right", "right", "right"],
    totals: ["Total", String(depts.reduce((n, d) => n + d.applications, 0)), String(depts.reduce((n, d) => n + d.liveLoans, 0)), amount(m(sum(depts.map((d) => d.approvedPrincipal)))), amount(m(sum(depts.map((d) => d.outstanding))))],
  });

  pdf.heading("Guarantor exposure");
  if (guarantors.length > 10) pdf.note(`The 10 largest exposures are shown, out of ${guarantors.length}.`);
  pdf.table(["Guarantor", "Active guarantees", "Potential", "Actual", "Total exposure"], guarantors.slice(0, 10).map((g) => [g.name, String(g.liveGuarantees), amount(g.potential), amount(g.actual), amount(g.total)]), { align: ["left", "right", "right", "right", "right"] });

  closing(pdf, actor, [
    "Collection rate is confirmed collections divided by instalments scheduled for the same months.",
    "Days past due counts from the oldest unpaid instalment. Arrears ageing covers active loans only.",
  ]);
  return pdf.finish(db, actor, { entityType: "report", entityId: "management" });
}

/* ───────────────────────── Spreadsheet and CSV ───────────────────────── */

export function datasetCsv(ds: Dataset): string {
  // Neutralise spreadsheet formula injection (CSV injection) in exported text.
  const esc = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const raw = (c: Column, v: unknown) => {
    if (v === null || v === undefined) return "";
    if (c.type === "money" || c.type === "number" || c.type === "percent") return String(v);
    if (v instanceof Date) return c.type === "datetime" ? v.toISOString() : v.toISOString().slice(0, 10);
    return c.type === "status" ? humanise(v) : String(v);
  };
  return [ds.columns.map((c) => esc(c.label)).join(","), ...ds.rows.map((r) => ds.columns.map((c) => esc(raw(c, r[c.key]))).join(","))].join("\r\n");
}

export async function workbook(db: Executor, actor: Actor, summary: ExecutiveSummary, ds: Dataset | null, title: string, basis: string): Promise<Buffer> {
  const brand = await getBranding(db);
  const argb = `FF${brand.primaryColour.slice(1)}`;
  const wb = new ExcelJS.Workbook();
  wb.creator = `${brand.systemName}, ${brand.institutionName}`;
  wb.title = title;
  wb.subject = `${brand.confidentialMarking}. ${brand.footerNotice}`;
  wb.keywords = brand.confidentialMarking;
  const furnish = (ws: ExcelJS.Worksheet) => {
    ws.headerFooter.oddFooter = `&L&B${brand.footerNotice.replace(/&/g, "&&")}&RPage &P of &N`;
    ws.pageSetup = { ...ws.pageSetup, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  };
  const headRow = (r: ExcelJS.Row) => {
    r.font = { bold: true, color: { argb: "FFFFFFFF" } };
    r.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb } }; });
  };

  const info = wb.addWorksheet("Report information");
  furnish(info);
  info.columns = [{ width: 34 }, { width: 60 }];
  info.addRow([brand.institutionName]).font = { bold: true, size: 14, color: { argb } };
  info.addRow([`${brand.systemName}: ${title}`]).font = { bold: true, size: 12 };
  info.addRow([]);
  for (const [k, v] of [["Reporting basis", basis], ["Classification", brand.confidentialMarking], ["Prepared for", actor.displayName], ["Prepared on", formatDateTime(new Date())], ["Data source", `${brand.systemName} confirmed ledger`], ["Distribution", "Authorised users only"]]) {
    const r = info.addRow([k, v]);
    r.getCell(1).font = { bold: true, color: { argb: "FF5F6F86" } };
  }
  info.addRow([]);
  headRow(info.addRow(["Executive summary", "Value"]));
  const tiles = ds
    ? [{ label: "Records", value: String(ds.rows.length), money: false }, ...ds.columns.filter((c) => c.total).map((c) => ({ label: c.label, value: m(sum(ds.rows.map((r) => String(r[c.key] ?? 0)))), money: c.type === "money" }))]
    : summary.tiles;
  for (const t of tiles) {
    const r = info.addRow([t.label, t.money ? Number(t.value) : t.value]);
    if (t.money) r.getCell(2).numFmt = "#,##0.00";
    r.getCell(2).alignment = { horizontal: "right" };
  }
  info.addRow([]);
  info.addRow(["Key findings"]).font = { bold: true };
  for (const p of ds ? ds.points : summary.points) {
    const r = info.addRow([p]);
    info.mergeCells(r.number, 1, r.number, 2);
    r.getCell(1).alignment = { wrapText: true, vertical: "top" };
    r.height = 30;
  }
  info.addRow([]);
  info.addRow(["Notes and definitions"]).font = { bold: true };
  [...(ds?.notes ?? []), ...STANDARD_NOTES].forEach((n, i) => {
    const r = info.addRow([`${i + 1}. ${n}`]);
    info.mergeCells(r.number, 1, r.number, 2);
    r.getCell(1).alignment = { wrapText: true, vertical: "top" };
    r.height = 28;
  });

  if (ds) {
    const ws = wb.addWorksheet(ds.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    furnish(ws);
    ws.columns = ds.columns.map((c) => ({
      header: c.label, key: c.key, width: Math.max(12, Math.min(48, c.label.length + 4, c.type === "text" || !c.type ? 40 : 18)),
      style: c.type === "money" ? { numFmt: "#,##0.00" } : c.type === "date" ? { numFmt: "dd mmm yyyy" } : c.type === "datetime" ? { numFmt: "dd mmm yyyy hh:mm" } : c.type === "percent" ? { numFmt: "0.0%" } : undefined,
    }));
    const value = (c: Column, v: unknown) => {
      if (v === null || v === undefined) return null;
      if (c.type === "money" || c.type === "number") return Number(v);
      if (c.type === "percent") return Number(v) / 100;
      if (c.type === "date") return v instanceof Date ? v : new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
      if (c.type === "datetime") return v instanceof Date ? v : new Date(String(v));
      if (c.type === "status") return humanise(v);
      return v as string | number;
    };
    ds.rows.forEach((r) => ws.addRow(Object.fromEntries(ds.columns.map((c) => [c.key, value(c, r[c.key])]))));
    headRow(ws.getRow(1));
    if (ds.columns.some((c) => c.total) && ds.rows.length) {
      const last = ds.rows.length + 1;
      const tr = ws.addRow(Object.fromEntries(ds.columns.map((c, i) => {
        if (i === 0) return [c.key, "Total"];
        if (!c.total) return [c.key, null];
        const letter = ws.getColumn(i + 1).letter;
        return [c.key, { formula: `SUBTOTAL(109,${letter}2:${letter}${last})` }];
      })));
      tr.font = { bold: true };
      tr.eachCell((c) => { c.border = { top: { style: "thin", color: { argb } } }; });
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ds.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
