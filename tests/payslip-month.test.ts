/**
 * Only the latest payslip counts: last month's, or this month's once salary is paid. An older one could
 * leave out deductions that started since and overstate what someone can borrow or guarantee.
 */
import { describe, expect, it } from "vitest";
import { payslipMonthProblem, previousMonth } from "@/lib/finance/payslip";
import { assessForStaff, guarantorCover, type StaffContext } from "@/lib/finance/staff-eligibility";
import { samplePayslip } from "@/lib/finance/payslip-pdf";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";

const slip = (period: string | null) => samplePayslip({ name: "Test Person", code: "T1", grade: "G", period: period as string, basic: "300000", medical: "20000", tax: "30000", pension: "24000" });
const ctx = (period: string | null, checkRecord: boolean): StaffContext => ({ payslip: slip(period), serviceMonths: 24, employmentStatus: "confirmed", guaranteeCommitment: "0.00", openCount: 0, oneLoanAtATime: true, checkRecord });

describe("which month's payslip is accepted", () => {
  it("accepts last month's and this month's; refuses older, later and unreadable months", () => {
    expect(payslipMonthProblem("2026-10", "2026-11-15")).toBeNull(); // applying in November: October
    expect(payslipMonthProblem("2026-11", "2026-11-28")).toBeNull(); // November's, once paid
    expect(payslipMonthProblem("2026-04", "2026-11-15")).toMatch(/This is your April 2026 payslip\. Please upload your latest payslip \(October 2026 or November 2026\)/);
    expect(payslipMonthProblem("2026-09", "2026-11-01")).not.toBeNull();
    expect(payslipMonthProblem("2026-12", "2026-11-15")).toMatch(/has not yet come/);
    expect(payslipMonthProblem(null, "2026-11-15")).toMatch(/could not be read/);
    // Across the new year.
    expect(payslipMonthProblem("2026-12", "2027-01-10")).toBeNull();
    expect(payslipMonthProblem("2026-11", "2027-01-10")).not.toBeNull();
    expect(previousMonth("2027-01")).toBe("2026-12");
  });

  it("stops the person applying with an old payslip, but not reviewers assessing a submitted application later", () => {
    const applying = assessForStaff(DEFAULT_POLICY, ctx("2026-04", false), { asOf: "2026-11-15", tenorMonths: 12 });
    expect(applying.eligible).toBe(false);
    expect(applying.reasons[0]).toMatch(/April 2026 payslip/);
    expect(assessForStaff(DEFAULT_POLICY, ctx("2026-10", false), { asOf: "2026-11-15", tenorMonths: 12 }).reasons.join(" ")).not.toMatch(/payslip \(/);
    // HR or the Bursary in December, on the October payslip the application was submitted with.
    expect(assessForStaff(DEFAULT_POLICY, ctx("2026-10", true), { asOf: "2026-12-05", tenorMonths: 12 }).reasons.join(" ")).not.toMatch(/latest payslip/);
  });

  it("stops a guarantor accepting on an old payslip", () => {
    const old = guarantorCover(DEFAULT_POLICY, { payslip: slip("2026-04"), otherGuarantees: "0", monthlyShare: "1000", asOf: "2026-11-15" });
    expect(old.ok).toBe(false);
    expect(old.payslip.problems[0]).toMatch(/April 2026 payslip/);
    expect(guarantorCover(DEFAULT_POLICY, { payslip: slip("2026-10"), otherGuarantees: "0", monthlyShare: "1000", asOf: "2026-11-15" }).ok).toBe(true);
  });
});
