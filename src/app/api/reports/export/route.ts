import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { getActor } from "@/lib/auth/session";
import { can } from "@/server/actor";
import { audit } from "@/server/audit";
import { buildDataset, executiveSummary, isReportKey, reportParams, REPORTS, basisText } from "@/server/services/reports";
import { getBranding } from "@/server/branding";
import { datasetCsv, datasetPdf, managementPdf, workbook } from "@/server/report-render";
import { formatDate, todayLagos } from "@/lib/finance/dates";

const FORMATS = { csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf" } as const;

export async function GET(req: NextRequest) {
  const actor = await getActor();
  if (!actor) return new NextResponse("Unauthorised", { status: 401 });
  const q = req.nextUrl.searchParams;
  // "executive" and "management" are earlier names for the portfolio report, kept so old links still work.
  const asked = q.get("report") ?? "";
  const key = asked === "executive" || asked === "management" ? "portfolio" : asked;
  const format = q.get("format") ?? "csv";
  if (!(format in FORMATS)) return new NextResponse("Unknown format", { status: 400 });
  const special = key === "portfolio";
  if (!special && !isReportKey(key)) return new NextResponse("Unknown report", { status: 400 });
  if (special && format === "csv") return new NextResponse("This report is not available in that format", { status: 400 });
  const permission = special ? "reports.export" : REPORTS[key as keyof typeof REPORTS].permission;
  if (!can(actor, permission)) return new NextResponse("You are not permitted to export this report.", { status: 403 });

  const db = await getDb();
  const brand = await getBranding(db);
  const params = reportParams({ from: q.get("from"), to: q.get("to"), month: q.get("month"), year: q.get("year"), staff: q.get("staff"), school: q.get("school"), department: q.get("department") });
  const suffix = (key === "portfolio" || (isReportKey(key) && REPORTS[key].basis === "period")) ? `${params.from}-to-${params.to}` : isReportKey(key) && REPORTS[key].basis === "month" ? (key === "payroll_deductions" && params.year ? params.year : params.month) : todayLagos();
  const base = `${brand.shortName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-loans-${key.replace(/_/g, "-")}-${suffix}`;
  const headers = (ext: keyof typeof FORMATS) => ({ "Cache-Control": "private, no-store", "Content-Type": FORMATS[ext], "Content-Disposition": `attachment; filename="${base}.${ext}"` });
  const f = format as keyof typeof FORMATS;

  let body: Buffer | string;
  let summaryText: string;
  if (key === "portfolio") {
    // PDF: the summary and every section; XLSX: the summary and the full loan book.
    body = f === "pdf" ? await managementPdf(db, actor, params) : await workbook(db, actor, await executiveSummary(db, actor), await buildDataset(db, actor, "loan_book", params), "Portfolio report", `As at ${formatDate(todayLagos())}`);
    summaryText = `Portfolio report (${f})`;
  } else {
    const k = key as keyof typeof REPORTS;
    const ds = await buildDataset(db, actor, k, params);
    body = f === "csv" ? "﻿" + datasetCsv(ds) : f === "xlsx" ? await workbook(db, actor, await executiveSummary(db, actor), ds, ds.title, basisText(k, params)) : await datasetPdf(db, actor, k, ds);
    summaryText = `${ds.title}, ${ds.basis} (${f}, ${ds.rows.length} rows)`;
  }
  await audit(db, actor, { action: "report.exported", entityType: "report", entityId: key, summary: summaryText });
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), { headers: headers(f) });
}
