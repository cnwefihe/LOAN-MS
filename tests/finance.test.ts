import { describe, it, expect } from "vitest";
import { quoteLoan, buildSchedule, assessEligibility, maxPrincipalForInstalment, allocatePayments, salaryFigures } from "@/lib/finance/calculator";
import { dec, sum, m, parseMoneyInput } from "@/lib/finance/money";
import { addMonths, monthsBetween, firstDueDate, daysBetween } from "@/lib/finance/dates";
import { policyParametersSchema, type PolicyParameters } from "@/lib/finance/policy";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";

const policy: PolicyParameters = { ...DEFAULT_POLICY, interestMethod: "flat", annualInterestRate: 10 };

describe("money", () => {
  it("parses user input safely", () => {
    expect(parseMoneyInput("₦1,250,000.5")).toBe("1250000.50");
    expect(() => parseMoneyInput("12.345")).toThrow();
    expect(() => parseMoneyInput("-5")).toThrow();
  });
  it("avoids float drift", () => {
    expect(m(sum(["0.10", "0.20"]))).toBe("0.30");
  });
});

describe("dates", () => {
  it("clamps month ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3, 25)).toBe("2027-02-25");
  });
  it("counts service months", () => {
    expect(monthsBetween("2024-03-15", "2026-03-14")).toBe(23);
    expect(monthsBetween("2024-03-15", "2026-03-15")).toBe(24);
  });
  it("computes first due date with grace", () => {
    expect(firstDueDate("2026-10-31", 25, 0)).toBe("2026-11-25");
    expect(firstDueDate("2026-10-31", 25, 1)).toBe("2026-12-25");
    expect(daysBetween("2026-11-25", "2026-12-25")).toBe(30);
  });
});

describe("schedule generation", () => {
  it("interest-free: equal principal, last absorbs residue", () => {
    const s = buildSchedule("1000000", 3, "interest_free", 0);
    expect(s.map((l) => l.totalDue)).toEqual(["333333.33", "333333.33", "333333.34"]);
    expect(m(sum(s.map((l) => l.totalDue)))).toBe("1000000.00");
    expect(s[2].closingBalance).toBe("0.00");
  });

  it("flat rate: interest on original principal for full term", () => {
    const q = quoteLoan("1200000", 12, "flat", 10);
    expect(q.totalInterest).toBe("120000.00");
    expect(q.totalRepayable).toBe("1320000.00");
    expect(q.monthlyInstalment).toBe("110000.00");
    expect(q.schedule.every((l) => l.interestDue === "10000.00")).toBe(true);
  });

  it("reducing balance: standard annuity and exact amortisation", () => {
    const q = quoteLoan("1000000", 12, "reducing_balance", 12);
    // PMT(1%, 12, 1,000,000) = 88,848.79
    expect(q.monthlyInstalment).toBe("88848.79");
    expect(q.schedule[0].interestDue).toBe("10000.00");
    expect(q.schedule.at(-1)!.closingBalance).toBe("0.00");
    expect(m(sum(q.schedule.map((l) => l.principalDue)))).toBe("1000000.00");
    expect(dec(q.totalInterest).toNumber()).toBeCloseTo(66185.46, 1);
  });

  it("assigns due dates from the first due date", () => {
    const s = buildSchedule("300000", 3, "interest_free", 0, "2026-11-25");
    expect(s.map((l) => l.dueDate)).toEqual(["2026-11-25", "2026-12-25", "2027-01-25"]);
  });

  it("charges interest only: an interest-free loan repays exactly the principal", () => {
    const q = quoteLoan("1000000", 10, "interest_free", 0);
    expect(q.totalInterest).toBe("0.00");
    expect(q.totalRepayable).toBe("1000000.00");
  });
});

describe("affordability", () => {
  it("inverts each pricing method", () => {
    for (const method of ["interest_free", "flat", "reducing_balance"] as const) {
      const rate = method === "interest_free" ? 0 : 12;
      const p = maxPrincipalForInstalment("50000", 12, method, rate);
      const q = quoteLoan(p, 12, method, rate);
      expect(dec(q.monthlyInstalment).lessThanOrEqualTo("50000.01")).toBe(true);
      const q2 = quoteLoan(p.plus(100), 12, method, rate);
      expect(dec(q2.monthlyInstalment).greaterThan("50000")).toBe(true);
    }
  });
});

describe("eligibility", () => {
  const base = {
    policy,
    salary: { basic: "300000", gross: "450000", net: "380000" },
    serviceMonths: 36,
    employmentStatus: "confirmed",
    existingMonthlyDeductions: "0",
    activeLoanCount: 0,
  };

  it("computes salary figures", () => {
    expect(salaryFigures(base.salary, 12).annualGross).toBe("5400000.00");
  });

  it("has no product cap: the most someone can borrow is what their pay can repay", () => {
    const r = assessEligibility({ ...base, requestedAmount: "1000000", tenorMonths: 12 });
    expect(r.eligible).toBe(true);
    expect(r.maxEligibleAmount).toBe(r.maxByAffordability);
    expect(r.quote?.principal).toBe("1000000.00");
    const rich = assessEligibility({ ...base, salary: { basic: "20000000", gross: "20000000", net: "15000000" }, tenorMonths: 12 });
    expect(dec(rich.maxEligibleAmount).greaterThan(50_000_000)).toBe(true);
  });

  it("follows HR's confirmation: not confirmed is ineligible, not yet recorded is left to HR", () => {
    for (const status of ["probation", "contract", "suspended"]) {
      const r = assessEligibility({ ...base, employmentStatus: status, requestedAmount: "100000", tenorMonths: 12 });
      expect(r.eligible, status).toBe(false);
      expect(r.reasons.join(" ")).toMatch(/does not show you as confirmed/);
    }
    expect(assessEligibility({ ...base, employmentStatus: "confirmed", requestedAmount: "100000", tenorMonths: 12 }).eligible).toBe(true);
    expect(assessEligibility({ ...base, employmentStatus: null, requestedAmount: "100000", tenorMonths: 12 }).eligible).toBe(true);
    expect(DEFAULT_POLICY.eligibleEmploymentStatuses).toEqual(["confirmed"]);
    expect(DEFAULT_POLICY.guarantorMustBeConfirmed).toBe(true);
  });

  it("rejects insufficient service and excess requests", () => {
    const r = assessEligibility({ ...base, serviceMonths: 2, employmentStatus: "probation", requestedAmount: "99000000", tenorMonths: 12 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/minimum of .* of service/);
    expect(r.reasons.join(" ")).toMatch(/more than the most you can borrow/);
    expect(r.requestedWithinEligible).toBe(false);
  });

  it("counts existing deductions against capacity", () => {
    const free = assessEligibility({ ...base, tenorMonths: 12 });
    const loaded = assessEligibility({ ...base, existingMonthlyDeductions: "100000", tenorMonths: 12 });
    expect(dec(loaded.availableMonthlyCapacity).lessThan(free.availableMonthlyCapacity)).toBe(true);
  });
});

describe("payment allocation", () => {
  it("allocates interest first, in sequence, and reports overpayment", () => {
    const inst = [
      { id: "a", sequence: 1, dueDate: "2026-11-25", principalDue: "100.00", interestDue: "10.00" },
      { id: "b", sequence: 2, dueDate: "2026-12-25", principalDue: "100.00", interestDue: "10.00" },
    ];
    const r = allocatePayments(inst, ["50.00", "100.00"]);
    expect(r.allocations[0]).toMatchObject({ interestPaid: "10.00", principalPaid: "100.00" });
    expect(r.allocations[1]).toMatchObject({ interestPaid: "10.00", principalPaid: "30.00" });
    expect(r.unallocated).toBe("0.00");
    expect(allocatePayments(inst, ["250"]).unallocated).toBe("30.00");
  });
});

describe("repayment frequency", () => {
  it("quarterly: instalments every 3 months, flat interest still on the full tenor", () => {
    const q = quoteLoan("1200000", 12, "flat", 10, "2026-11-25", 3);
    expect(q.instalmentCount).toBe(4);
    expect(q.schedule.map((l) => l.dueDate)).toEqual(["2026-11-25", "2027-02-25", "2027-05-25", "2027-08-25"]);
    expect(q.totalInterest).toBe("120000.00");
    expect(q.monthlyInstalment).toBe("330000.00");
  });

  it("reducing balance uses the per-period rate and amortises exactly", () => {
    const q = quoteLoan("1000000", 12, "reducing_balance", 12, null, 2);
    expect(q.instalmentCount).toBe(6);
    expect(q.schedule[0].interestDue).toBe("20000.00"); // 2% per two-month period
    expect(q.schedule.at(-1)!.closingBalance).toBe("0.00");
  });

  it("rejects a tenor that is not a whole number of periods", () => {
    expect(() => buildSchedule("100000", 10, "interest_free", 0, null, 3)).toThrow(/multiple of 3 months/);
    const r = assessEligibility({
      policy: { ...policy, repaymentFrequency: "quarterly", minTenorMonths: 3, maxTenorMonths: 24 }, salary: { basic: "300000", gross: "450000", net: "380000" },
      serviceMonths: 36, employmentStatus: "confirmed", existingMonthlyDeductions: "0", activeLoanCount: 0, requestedAmount: "300000", tenorMonths: 10,
    });
    expect(r.reasons.join(" ")).toMatch(/multiple of 3 months/);
  });

  it("affordability scales monthly capacity to the instalment period", () => {
    for (const period of [1, 2, 3]) {
      const p = maxPrincipalForInstalment(String(50000 * period), 12 / period, "reducing_balance", 12, period);
      const q = quoteLoan(p, 12, "reducing_balance", 12, null, period);
      expect(dec(q.monthlyInstalment).lessThanOrEqualTo(50000 * period + 0.01)).toBe(true);
    }
  });

  it("adds an estimated completion date when an assessment date is given", () => {
    const r = assessEligibility({
      policy: { ...policy, repaymentFrequency: "quarterly", minTenorMonths: 3, maxTenorMonths: 24, repaymentDayOfMonth: 25, gracePeriodMonths: 0 }, salary: { basic: "300000", gross: "450000", net: "380000" },
      serviceMonths: 36, employmentStatus: "confirmed", existingMonthlyDeductions: "0", activeLoanCount: 0, requestedAmount: "300000", tenorMonths: 12, asOf: "2026-10-31",
    });
    expect(r.quote?.estimatedCompletionDate).toBe("2027-08-25");
  });
});

describe("stored policies", () => {
  it("older stored policies still parse: missing new fields default, retired approval routing is dropped", () => {
    const { repaymentFrequency: _r, ...legacy } = DEFAULT_POLICY;
    const parsed = policyParametersSchema.parse({ ...legacy, approvalLevels: 2, approvalThresholds: [{ minAmount: "2000000", levels: 2 }] });
    expect(parsed.repaymentFrequency).toBe("monthly");
    expect(parsed).not.toHaveProperty("approvalThresholds");
  });

  it("starts from the University's terms: 10% a year, up to 12 months, 24 months' service", () => {
    expect(DEFAULT_POLICY).toMatchObject({ annualInterestRate: 10, maxTenorMonths: 12, minServiceMonths: 24, minTakeHomePercent: 40 });
  });
});

describe("policy schema", () => {
  it("accepts the default policy and rejects inconsistent ones", () => {
    expect(policyParametersSchema.safeParse(DEFAULT_POLICY).success).toBe(true);
    expect(policyParametersSchema.safeParse({ ...DEFAULT_POLICY, interestMethod: "interest_free", annualInterestRate: 5 }).success).toBe(false);
  });
});
