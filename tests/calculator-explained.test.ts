/** Calculator figures checked against hand-worked numbers. */
import { describe, it, expect } from "vitest";
import { assessEligibility, validTenors } from "@/lib/finance/calculator";
import { assessForStaff, NO_PAYSLIP_REASON, ONE_LOAN_REASON, type StaffContext } from "@/lib/finance/staff-eligibility";
import { samplePayslip } from "@/lib/finance/payslip-pdf";
import type { PolicyParameters } from "@/lib/finance/policy";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { dec } from "@/lib/finance/money";

// Flat 10% a year, 3 to 12 months; after deductions, net pay must stay at least 40% of gross.
const policy: PolicyParameters = { ...DEFAULT_POLICY, interestMethod: "flat", annualInterestRate: 10, affordabilityRule: "take_home_floor", minTakeHomePercent: 40 };
const salary = { basic: "150000", gross: "300000", net: "200000" };
const base = { policy, salary, serviceMonths: 36, employmentStatus: "confirmed", existingMonthlyDeductions: "20000", activeLoanCount: 0, asOf: "2026-11-01" };

describe("calculator explained", () => {
  it("works out the annual and monthly limits", () => {
    const r = assessEligibility(base);
    expect(r.salary.annualGross).toBe("3600000.00"); // 300,000 × 12
    expect(r.takeHomeFloor).toBe("120000.00"); // 40% of 300,000 gross
    expect(r.deductionBaseMonthly).toBe("200000.00");
    expect(r.monthlyDeductionCap).toBe("80000.00"); // 200,000 net less the 120,000 floor
    expect(r.annualDeductionCap).toBe("960000.00");
    expect(r.availableMonthlyCapacity).toBe("60000.00"); // less 20,000 existing
    expect(r.currentDeductionPercent).toBe("10.0");
    expect(r.tenorMonths).toBe(12); // no amount: longest duration
  });

  it("chooses the shortest duration the borrower can afford", () => {
    // Instalment = (600,000 + 5,000 × months) ÷ months; it fits 60,000 from 11 months.
    const r = assessEligibility({ ...base, requestedAmount: "600000" });
    expect(r.suggestedTenorMonths).toBe(11);
    expect(r.tenorMonths).toBe(11);
    expect(r.tenorAutomatic).toBe(true);
    expect(r.quote!.totalInterest).toBe("55000.00");
    expect(r.quote!.totalRepayable).toBe("655000.00");
    expect(r.quote!.monthlyInstalment).toBe("59545.45");
    expect(r.instalmentPercentOfPay).toBe("29.8");
    expect(r.totalDeductionPercentAfter).toBe("39.8");
    expect(r.capacityLeftAfter).toBe("454.55");
    expect(r.quote!.estimatedFirstDueDate).toBe("2026-12-25");
    expect(r.quote!.estimatedCompletionDate).toBe("2027-10-25");
    expect(r.eligible).toBe(true);
  });

  it("warns and points to a longer duration when the chosen one is too short", () => {
    const r = assessEligibility({ ...base, requestedAmount: "600000", tenorMonths: 6 });
    expect(r.tenorAutomatic).toBe(false);
    expect(r.warnings[0]).toMatch(/Choose 11 months or longer/);
    expect(r.eligible).toBe(false);
  });

  it("lists only valid durations", () => {
    expect(validTenors(policy)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1)); // one to twelve months
    expect(validTenors({ ...policy, repaymentFrequency: "quarterly", minTenorMonths: 3, maxTenorMonths: 12 })).toEqual([3, 6, 9, 12]);
  });

  it("counts what a guarantor could be asked to repay, and the one-loan rule", () => {
    // Net pay 300,000 (basic 280,000 + medical 20,000, tax and pension 0 for round figures); 33.3% = 99,900.
    const payslip = samplePayslip({ name: "Test", code: "T1", grade: "G", period: "2026-10", basic: "280000", medical: "20000", tax: "0", pension: "0" });
    const ctx: StaffContext = { payslip, serviceMonths: 36, employmentStatus: "confirmed", guaranteeCommitment: "10000.00", openCount: 0, oneLoanAtATime: true };
    const r = assessForStaff(policy, ctx, {});
    expect(r.monthlyDeductionCap).toBe("99900.00");
    expect(r.availableMonthlyCapacity).toBe("64900.00"); // less 25,000 cafeteria (always counted) and 10,000 set aside for the loan guaranteed
    const busy = assessForStaff(policy, { ...ctx, openCount: 1 }, {});
    expect(busy.eligible).toBe(false);
    expect(busy.reasons[0]).toBe(ONE_LOAN_REASON);
  });

  it("takes cooperative and cafeteria deductions on the payslip off what can be borrowed", () => {
    const slip = (deductions: { label: string; amount: string }[]) => samplePayslip({ name: "Test", code: "T1", grade: "G", period: "2026-10", basic: "280000", medical: "20000", tax: "0", pension: "0", deductions });
    const ctx: StaffContext = { payslip: slip([]), serviceMonths: 36, employmentStatus: "confirmed", guaranteeCommitment: "0.00", openCount: 0, oneLoanAtATime: true };
    const free = assessForStaff(policy, ctx, {});
    const owing = assessForStaff(policy, { ...ctx, payslip: slip([{ label: "Cooperative Loan", amount: "30000" }, { label: "Cafeteria", amount: "1200" }]) }, {});
    expect(free.availableMonthlyCapacity).toBe("74900.00"); // cafeteria is counted every month, even when not on the payslip
    expect(owing.availableMonthlyCapacity).toBe("44900.00"); // 99,900 less 30,000 cooperative and 25,000 cafeteria
    expect(dec(owing.maxEligibleAmount).lessThan(free.maxEligibleAmount)).toBe(true);
    // Deductions above the limit leave nothing to borrow, and say why.
    const full = assessForStaff(policy, { ...ctx, payslip: slip([{ label: "Cooperative Loan", amount: "100000" }]) }, { requestedAmount: "100000" });
    expect(full.eligible).toBe(false);
    expect(full.reasons.join(" ")).toMatch(/already use the 33.3% of your net pay/);
  });

  it("cannot be worked out without a payslip", () => {
    const r = assessForStaff(policy, { payslip: null, serviceMonths: 36, employmentStatus: "confirmed", guaranteeCommitment: "0.00", openCount: 0, oneLoanAtATime: true }, {});
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toBe(NO_PAYSLIP_REASON);
  });
});
