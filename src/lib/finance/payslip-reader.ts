/**
 * Reads the University's payslip (the PDF issued through SeamlessHR) into a Payslip. Works from the
 * PDF's text with its positions, so figures are read exactly as printed; nothing is estimated. A
 * scanned or photographed payslip has no text and is refused.
 *
 * Layout read:
 *   EMPLOYEE INFORMATION   NAME | EMPLOYEE CODE | PAY GRADE headings, each value beneath its heading
 *   EARNINGS INFORMATION   label … amount rows, ending with "Gross"
 *   EMPLOYEE DEDUCTIONS    label … amount rows, ending with "Total Deductions"
 *   NET PAY                amount
 */
import { getDocumentProxy } from "unpdf";
import { m } from "./money";
import type { Payslip, PayslipLine } from "./payslip";

export interface TextItem { str: string; x: number; y: number }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const AMOUNT = /^-?[\d,]+\.\d{2}$/;
/** Headings are letter-spaced ("E A R N I N G S"); compare without spaces. */
const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export class PayslipReadError extends Error {}

/** Group text into rows (same baseline, within a couple of points), top of the page first. */
function rows(items: TextItem[]) {
  const out: TextItem[][] = [];
  for (const it of [...items].filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = out.find((r) => Math.abs(r[0].y - it.y) <= 3);
    if (row) row.push(it); else out.push([it]);
  }
  return out.map((r) => r.sort((a, b) => a.x - b.x));
}

export function parsePayslipText(items: TextItem[]): Payslip {
  const all = rows(items);
  const text = (r: TextItem[]) => r.map((i) => i.str.trim()).join(" ");
  const find = (heading: string) => all.findIndex((r) => squash(text(r)) === heading);

  // Pay month: "Payslip for March 2026".
  let period: string | null = null;
  for (const r of all) {
    const mt = /payslip for\s+([a-z]+)\s+(\d{4})/i.exec(text(r));
    if (mt && MONTHS.includes(mt[1].toLowerCase())) { period = `${mt[2]}-${String(MONTHS.indexOf(mt[1].toLowerCase()) + 1).padStart(2, "0")}`; break; }
  }

  // Employee details: each value sits beneath its heading, in the same column.
  const info = find("EMPLOYEEINFORMATION");
  const earningsAt = find("EARNINGSINFORMATION");
  const deductionsAt = find("EMPLOYEEDEDUCTIONS");
  if (info < 0 || earningsAt < 0 || deductionsAt < 0) throw new PayslipReadError("This does not look like a University payslip. Please upload the payslip PDF from SeamlessHR.");
  const headRow = all.slice(info + 1, earningsAt).find((r) => r.some((i) => squash(i.str) === "NAME"));
  // A heading may come as one piece or split into words ("E M P L O Y E E" + "C O D E"): join pieces until they spell one.
  const HEADINGS = ["NAME", "EMPLOYEECODE", "PAYGRADE"];
  const columns: { key: string; x: number }[] = [];
  let piece: { text: string; x: number } | null = null;
  for (const i of headRow ?? []) {
    piece = piece ? { text: piece.text + squash(i.str), x: piece.x } : { text: squash(i.str), x: i.x };
    if (HEADINGS.includes(piece.text)) { columns.push({ key: piece.text, x: piece.x }); piece = null; }
    else if (!HEADINGS.some((h) => h.startsWith(piece!.text))) piece = null;
  }
  const valueOf = (key: string) => {
    const col = columns.find((c) => c.key === key);
    if (!col || !headRow) return "";
    const next = columns.filter((c) => c.x > col.x).map((c) => c.x).sort((a, b) => a - b)[0] ?? Infinity;
    return all.slice(all.indexOf(headRow) + 1, earningsAt)
      .flatMap((r) => r.filter((i) => i.x >= col.x - 10 && i.x < next - 10))
      .map((i) => i.str.trim()).join(" ").replace(/\s+/g, " ").trim();
  };

  // Label … amount rows in a section, up to the row whose label is `end`.
  const section = (from: number, end: string) => {
    const lines: PayslipLine[] = [];
    let totalLine: string | null = null;
    for (const r of all.slice(from + 1)) {
      const amount = r.at(-1)!;
      if (r.length < 2 || !AMOUNT.test(amount.str.trim())) continue; // column headings
      const label = r.slice(0, -1).map((i) => i.str.trim()).join(" ").replace(/\s+/g, " ").trim();
      const value = m(amount.str.trim().replace(/,/g, ""));
      if (squash(label) === squash(end)) { totalLine = value; break; }
      lines.push({ label: label.replace(/[.:]+$/, ""), amount: value });
    }
    return { lines, total: totalLine };
  };
  const earnings = section(earningsAt, "Gross");
  const deductions = section(deductionsAt, "Total Deductions");
  const netRow = all.find((r) => squash(text(r.slice(0, -1))) === "NETPAY" && AMOUNT.test(r.at(-1)!.str.trim()));

  if (!earnings.lines.length) throw new PayslipReadError("The earnings on the payslip could not be read.");
  return {
    employee: { name: valueOf("NAME"), code: valueOf("EMPLOYEECODE"), grade: valueOf("PAYGRADE") },
    period,
    earnings: earnings.lines,
    deductions: deductions.lines,
    totals: { gross: earnings.total, deductions: deductions.total, net: netRow ? m(netRow.at(-1)!.str.trim().replace(/,/g, "")) : null },
  };
}

/** Read a payslip PDF. Throws PayslipReadError with a plain explanation when it cannot be read. */
export async function readPayslipPdf(data: Uint8Array): Promise<Payslip> {
  if (!(data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)) throw new PayslipReadError("Please upload your payslip as a PDF.");
  let items: TextItem[] = [];
  try {
    const pdf = await getDocumentProxy(data, { verbosity: 0 });
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    items = content.items.flatMap((i) => ("str" in i ? [{ str: i.str, x: i.transform[4], y: i.transform[5] }] : []));
  } catch {
    throw new PayslipReadError("The PDF could not be opened. Please download your payslip again and upload it.");
  }
  if (!items.some((i) => i.str.trim())) throw new PayslipReadError("This PDF has no readable text (it may be a scan or photo). Please upload the payslip PDF from SeamlessHR.");
  return parsePayslipText(items);
}
