/** Reading the payslip layout, using a made-up payslip laid out like the University's. */
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parsePayslipText, readPayslipPdf, PayslipReadError, type TextItem } from "@/lib/finance/payslip-reader";

/** [x, y, text] as positioned on the page. */
const LAYOUT: [number, number, string][] = [
  [69, 808, "Pan-Atlantic University"], [465, 810, "Payslip for October 2026"],
  [26, 734, "E M P L O Y E E I N F O R M A T I O N"],
  [25, 709, "N A M E"], [207, 709, "E M P L O Y E E C O D E"], [389, 709, "P A Y G R A D E"],
  [25, 693, "Tolu Grace Adebayo"], [207, 693, "PAU/2020/101"], [389, 693, "Senior Officer II"], [389, 680, "Step 3"],
  [26, 652, "E A R N I N G S I N F O R M A T I O N"],
  [25, 623, "EARNINGS"], [480, 623, "AMOUNT (NGN)"],
  [25, 602, "Basic"], [480, 602, "300,000.00"],
  [25, 581, "Medical"], [480, 581, "50,000.00"],
  [25, 560, "Leave Allowance"], [480, 560, "25,000.00"],
  [29, 516, "Gross"], [480, 516, "375,000.00"],
  [26, 473, "E M P L O Y E E D E D U C T I O N S"],
  [25, 444, "EMPLOYEE DEDUCTIONS"], [480, 444, "AMOUNT (NGN)"],
  [25, 423, "Tax"], [480, 423, "30,000.00"],
  [25, 402, "Pension"], [480, 402, "24,000.00"],
  [25, 381, "NHF"], [480, 381, "7,500.00"],
  [25, 360, "Cooperative Loan Repayment"], [480, 360, "10,000.00"],
  [25, 339, "Cafeteria Meal Deduction."], [480, 339, "3,200.00"],
  [29, 316, "Total Deductions"], [480, 316, "74,700.00"],
  [32, 274, "NET PAY"], [481, 274, "300,300.00"],
  [26, 238, "E M P L O Y E R C O N T R I B U T I O N S"],
  [25, 174, "Pension"], [480, 174, "30,000.00"],
  [29, 150, "Total Contributions"], [480, 150, "30,000.00"],
];
const items: TextItem[] = LAYOUT.map(([x, y, str]) => ({ x, y, str }));

describe("payslip reader", () => {
  it("reads the employee details, earnings, deductions and totals", () => {
    const p = parsePayslipText(items);
    expect(p.employee).toEqual({ name: "Tolu Grace Adebayo", code: "PAU/2020/101", grade: "Senior Officer II Step 3" });
    expect(p.period).toBe("2026-10");
    expect(p.earnings).toEqual([{ label: "Basic", amount: "300000.00" }, { label: "Medical", amount: "50000.00" }, { label: "Leave Allowance", amount: "25000.00" }]);
    expect(p.deductions.map((d) => d.label)).toEqual(["Tax", "Pension", "NHF", "Cooperative Loan Repayment", "Cafeteria Meal Deduction"]);
    expect(p.totals).toEqual({ gross: "375000.00", deductions: "74700.00", net: "300300.00" });
  });

  it("reads a real PDF and refuses anything that is not a payslip PDF", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const [x, y, s] of LAYOUT) page.drawText(s, { x, y, size: 9, font });
    const p = await readPayslipPdf(await doc.save());
    expect(p.employee.code).toBe("PAU/2020/101");
    expect(p.totals.net).toBe("300300.00");

    await expect(readPayslipPdf(new TextEncoder().encode("not a pdf"))).rejects.toThrow("Please upload your payslip as a PDF.");
    const blank = await PDFDocument.create(); blank.addPage();
    await expect(readPayslipPdf(await blank.save())).rejects.toBeInstanceOf(PayslipReadError);
  });
});

describe("payslip reader, labels that wrap onto two lines", () => {
  const base = LAYOUT.filter(([, y]) => y !== 339 && y !== 316);
  const total = (n: string): [number, number, string][] => [[29, 316, "Total Deductions"], [480, 316, n]];

  it("reads an amount printed between the two lines of its label", () => {
    const layout: [number, number, string][] = [...base, [25, 344, "November 2026 Cafeteria"], [480, 339, "11,030.00"], [25, 334, "Meal Deduction"], ...total("82,530.00")];
    const p = parsePayslipText(layout.map(([x, y, str]) => ({ x, y, str })));
    expect(p.deductions.at(-1)).toEqual({ label: "November 2026 Cafeteria Meal Deduction", amount: "11030.00" });
    expect(p.totals.deductions).toBe("82530.00");
  });

  it("reads an amount printed beside the second line of its label", () => {
    const layout: [number, number, string][] = [...base, [25, 349, "November 2026 Cafeteria Meal"], [25, 339, "Deduction"], [480, 339, "11,030.00"], ...total("82,530.00")];
    const p = parsePayslipText(layout.map(([x, y, str]) => ({ x, y, str })));
    expect(p.deductions.at(-1)).toEqual({ label: "November 2026 Cafeteria Meal Deduction", amount: "11030.00" });
  });
});

describe("payslip reader, headings split into words", () => {
  it("still finds the employee code and pay grade", () => {
    const split = items.flatMap((i) => i.str === "E M P L O Y E E C O D E" ? [{ ...i, str: "E M P L O Y E E" }, { ...i, x: i.x + 75, str: "C O D E" }]
      : i.str === "P A Y G R A D E" ? [{ ...i, str: "P A Y" }, { ...i, x: i.x + 31, str: "G R A D E" }] : [i]);
    expect(parsePayslipText(split).employee).toEqual({ name: "Tolu Grace Adebayo", code: "PAU/2020/101", grade: "Senior Officer II Step 3" });
  });
});
