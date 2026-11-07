/**
 * Draws a sample payslip PDF in the same layout as the University's, for the development seed and tests.
 * Figures are whatever is passed in; nothing here comes from a real payslip.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Payslip } from "./payslip";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmt = (v: string) => Number(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const spaced = (s: string) => s.split("").join(" ");

export async function renderPayslipPdf(slip: Payslip): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (s: string, x: number, y: number, b = false) => page.drawText(s, { x, y, size: 9, font: b ? bold : font, color: rgb(0.15, 0.2, 0.3) });
  const [year, month] = (slip.period ?? "2026-01").split("-").map(Number);

  text("Sample payslip (development data)", 25, 808, true);
  text(`Payslip for ${MONTHS[month - 1]} ${year}`, 440, 810, true);
  text(spaced("EMPLOYEE INFORMATION"), 26, 734, true);
  text(spaced("NAME"), 25, 709); text(spaced("EMPLOYEE CODE"), 207, 709); text(spaced("PAY GRADE"), 389, 709);
  text(slip.employee.name, 25, 693, true); text(slip.employee.code, 207, 693, true); text(slip.employee.grade, 389, 693, true);

  let y = 652;
  const section = (heading: string, column: string, lines: { label: string; amount: string }[], totalLabel: string, total: string | null) => {
    text(spaced(heading), 26, y, true); y -= 29;
    text(column, 25, y, true); text("AMOUNT (NGN)", 480, y, true); y -= 21;
    for (const l of lines) { text(l.label, 25, y); text(fmt(l.amount), 480, y); y -= 21; }
    if (total !== null) { y -= 2; text(totalLabel, 29, y, true); text(fmt(total), 480, y, true); }
    y -= 43;
  };
  section("EARNINGS INFORMATION", "EARNINGS", slip.earnings, "Gross", slip.totals.gross);
  section("EMPLOYEE DEDUCTIONS", "EMPLOYEE DEDUCTIONS", slip.deductions, "Total Deductions", slip.totals.deductions);
  if (slip.totals.net !== null) { text("NET PAY", 32, y, true); text(fmt(slip.totals.net), 481, y, true); }
  return doc.save();
}

/** A sample payslip from a few figures: basic and medical; tax, pension and any other deductions. */
export function samplePayslip(input: {
  name: string; code: string; grade: string; period: string;
  basic: string; medical: string; tax: string; pension: string; deductions?: { label: string; amount: string }[];
}): Payslip {
  const leave = (Number(input.basic) / 12).toFixed(2);
  const earnings = [
    { label: "Basic", amount: Number(input.basic).toFixed(2) }, { label: "Medical", amount: Number(input.medical).toFixed(2) },
    { label: "Leave Allowance", amount: leave }, { label: "13th Month Pay", amount: leave },
  ];
  const deductions = [
    { label: "Tax", amount: Number(input.tax).toFixed(2) }, { label: "Pension", amount: Number(input.pension).toFixed(2) },
    { label: "Leave Allowance", amount: leave }, { label: "13th Month Pay", amount: leave },
    ...(input.deductions ?? []).map((d) => ({ label: d.label, amount: Number(d.amount).toFixed(2) })),
  ];
  const sum = (l: { amount: string }[]) => l.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0);
  const gross = sum(earnings), ded = sum(deductions);
  return {
    employee: { name: input.name, code: input.code, grade: input.grade }, period: input.period, earnings, deductions,
    totals: { gross: (gross / 100).toFixed(2), deductions: (ded / 100).toFixed(2), net: ((gross - ded) / 100).toFixed(2) },
  };
}
