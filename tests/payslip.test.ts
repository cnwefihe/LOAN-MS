/** Loan affordability from a payslip, checked against hand-worked figures. All figures are made up. */
import { describe, it, expect } from "vitest";
import { assessPayslip, classifyDeduction, namesMatch, payslipMismatches, type Payslip } from "@/lib/finance/payslip";
import { maxPrincipalForInstalment, quoteLoan } from "@/lib/finance/calculator";
import { samplePayslip } from "@/lib/finance/payslip-pdf";
import { assessForStaff, guarantorCover, type StaffContext } from "@/lib/finance/staff-eligibility";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";

const slip = (over: Partial<Payslip> = {}): Payslip => ({
  employee: { name: "ADEBAYO, Tolu Grace", code: "PAU-0123", grade: "GL 08" },
  period: "2026-10",
  earnings: [
    { label: "Basic Salary", amount: "300000.00" },
    { label: "Medical Allowance", amount: "50000.00" },
    { label: "Leave Allowance", amount: "25000.00" },
    { label: "13th Month Pay", amount: "25000.00" },
  ],
  deductions: [
    { label: "PAYE Tax", amount: "30000.00" },
    { label: "Pension (Employee)", amount: "24000.00" },
    { label: "NHF", amount: "7500.00" },
    { label: "Cooperative Contribution", amount: "10000.00" },
    { label: "Co-operative Loan Repayment", amount: "10000.00" },
    { label: "Cafeteria", amount: "3200.00" },
    { label: "Leave Allowance", amount: "25000.00" },
    { label: "13th Month Pay", amount: "25000.00" },
  ],
  totals: { gross: "400000.00", deductions: "134700.00", net: "265300.00" },
  ...over,
});

describe("payslip affordability", () => {
  it("works out net pay, the 33.3% limit and the room for a loan", () => {
    const a = assessPayslip(slip());
    // 300,000 + 50,000 − 30,000 − 24,000 − 7,500 = 288,500
    expect(a).toMatchObject({ payForLending: "350000.00", netPay: "288500.00", limit: "96070.50" });
    // Cooperative 10,000 + 10,000, cafeteria counted at 25,000 though 3,200 was used.
    expect(a.commitments.map((c) => [c.kind, c.counted])).toEqual([["cooperative", "10000.00"], ["cooperative", "10000.00"], ["cafeteria", "25000.00"]]);
    expect(a).toMatchObject({ committed: "45000.00", room: "51070.50" });
    expect(a.ignored.map((l) => l.label)).toEqual(["Leave Allowance", "13th Month Pay", "Leave Allowance", "13th Month Pay"]);
    expect(a.problems).toEqual([]);
    expect(a.warnings).toEqual([]);
  });

  it("the largest loan over 12 months at 10% flat keeps the instalment within the room", () => {
    const max = maxPrincipalForInstalment("51070.50", 12, "flat", 10);
    expect(max.toFixed(2)).toBe("557132.72"); // 51,070.50 × 12 ÷ 1.1
    const q = quoteLoan(max, 12, "flat", 10);
    expect(q.totalInterest).toBe("55713.27");
    expect(q.monthlyInstalment).toBe("51070.50");
  });

  it("without NHF, cooperative or cafeteria the whole 33.3% is available", () => {
    const a = assessPayslip(slip({ deductions: [{ label: "PAYE", amount: "30000.00" }, { label: "Pension", amount: "24000.00" }], totals: { gross: null, deductions: null, net: null } }));
    expect(a).toMatchObject({ netPay: "296000.00", limit: "98568.00", committed: "0.00", room: "98568.00" });
  });

  it("other deductions count; leave allowance and 13th month do not", () => {
    expect(classifyDeduction("Staff Loan Repayment")).toBe("other");
    expect(classifyDeduction("COOP. SAVINGS")).toBe("cooperative");
    expect(classifyDeduction("Coop Savings")).toBe("cooperative");
    expect(classifyDeduction("National Housing Fund")).toBe("nhf");
  });

  it("no room when commitments reach the limit", () => {
    const a = assessPayslip(slip({ deductions: [...slip().deductions, { label: "Cooperative Loan", amount: "60000.00" }] }));
    expect(a.room).toBe("0.00");
  });

  it("flags lines that do not add up to the printed totals", () => {
    const a = assessPayslip(slip({ totals: { gross: "400000.00", deductions: "130000.00", net: "270000.00" } }));
    expect(a.warnings).toEqual(["Total deductions on the payslip is 130000.00, but the lines add up to 134700.00."]);
  });
});

describe("payslip belongs to the applicant", () => {
  it("matches names in any order, with or without a middle name", () => {
    expect(namesMatch("ADEBAYO, Tolu Grace", "Tolu Adebayo")).toBe(true);
    expect(namesMatch("Tolu Adebayo", "Tolu Okafor")).toBe(false);
  });

  it("lists each detail that does not match", () => {
    const staff = { name: "Tolu Adebayo", staffNumber: "PAU0123", payGrade: "GL08" };
    expect(payslipMismatches(slip().employee, staff)).toEqual([]);
    expect(payslipMismatches({ ...slip().employee, grade: "GL 09" }, staff)).toEqual(["The pay grade on the payslip (GL 09) does not match your profile (GL08)."]);
  });
});

describe("advances and guarantors from the payslip", () => {
  const policy = { ...DEFAULT_POLICY, productType: "advance" as const, requiredGuarantors: 0, minServiceMonths: 0, interestMethod: "interest_free" as const, annualInterestRate: 0, minTenorMonths: 1, maxTenorMonths: 1, maxRestructuredTenorMonths: 1 };
  // Basic 300,000, medical 50,000, leave and 13th month accrued at 25,000 each (paid and held back);
  // tax 30,000, pension 24,000. Printed net pay: 400,000 − 104,000 = 296,000.
  const payslip = samplePayslip({ name: "Test", code: "T1", grade: "G", period: "2026-10", basic: "300000", medical: "50000", tax: "30000", pension: "24000" });
  const ctx: StaffContext = { payslip, serviceMonths: 12, employmentStatus: "confirmed", guaranteeCommitment: "0.00", openCount: 0, oneLoanAtATime: true };

  it("a salary advance is up to the net pay printed on the payslip, interest-free", () => {
    expect(payslip.totals.net).toBe("296000.00");
    const r = assessForStaff(policy, ctx, { requestedAmount: "100000", advanceType: "salary" });
    expect(r.eligible).toBe(true);
    expect(r.maxEligibleAmount).toBe("296000.00");
    expect(r.quote?.totalInterest).toBe("0.00");
    expect(r.advance?.remaining).toBe("196000.00");
    expect(assessForStaff(policy, ctx, { requestedAmount: "300000", advanceType: "salary" }).reasons.join(" ")).toMatch(/more than the most that can be advanced/);
  });

  it("a leave allowance or 13th month advance is up to one month's basic salary", () => {
    expect(assessForStaff(policy, ctx, { requestedAmount: "100000", advanceType: "leave_allowance" }).maxEligibleAmount).toBe("300000.00");
    expect(assessForStaff(policy, ctx, { requestedAmount: "100000", advanceType: "thirteenth_month" }).advance?.remaining).toBe("200000.00");
  });

  it("a guarantor may accept only if their share fits within what is left of their own 33.3%", () => {
    const slip = samplePayslip({ name: "G", code: "G1", grade: "G", period: "2026-10", basic: "300000", medical: "50000", tax: "30000", pension: "24000", deductions: [{ label: "Cafeteria", amount: "900" }] });
    // Net 296,000; 33.3% = 98,568; less cafeteria 25,000 = 73,568 available.
    const ok = guarantorCover(DEFAULT_POLICY, { payslip: slip, otherGuarantees: "0.00", monthlyShare: "50000" });
    expect(ok).toMatchObject({ available: "73568.00", ok: true });
    expect(guarantorCover(DEFAULT_POLICY, { payslip: slip, otherGuarantees: "0.00", monthlyShare: "80000" }).ok).toBe(false);
    // Other loans they guarantee count first.
    expect(guarantorCover(DEFAULT_POLICY, { payslip: slip, otherGuarantees: "30000.00", monthlyShare: "50000" }).ok).toBe(false);
  });
});
