import type { PolicyParameters } from "./policy";

/**
 * Starting template for a new policy version in the admin console and for the development seed.
 * These are placeholder values, NOT approved PAU policy. The Super Administrator must review and
 * approve real values before go-live.
 */
export const DEFAULT_POLICY: PolicyParameters = {
  productType: "loan",
  minServiceMonths: 24,
  eligibleEmploymentStatuses: ["confirmed"],
  maxActiveLoans: 1,
  interestMethod: "reducing_balance",
  annualInterestRate: 10,
  minTenorMonths: 1,
  maxTenorMonths: 12,
  deductionBasis: "net",
  // All further deductions together may take at most 33.3% of net pay (basic + medical − tax − pension − NHF).
  maxDeductionPercent: 33.3,
  affordabilityRule: "deduction_cap",
  minTakeHomePercent: 40,
  cafeteriaAmount: "25000.00",
  requiredGuarantors: 2,
  guarantorMinServiceMonths: 24,
  guarantorMustBeConfirmed: true,
  maxGuarantorExposure: "5000000.00",
  maxGuaranteesPerGuarantor: 1,
  repaymentFrequency: "monthly",
  repaymentDayOfMonth: 25,
  gracePeriodMonths: 0,
  overdueAfterDays: 5,
  defaultAfterDays: 90,
  reminderDaysBeforeDue: 5,
  earlySettlementRebate: "unearned_interest",
  // The tenor chosen is the tenor repaid; an administrator may allow restructuring for a product.
  allowRestructuring: false,
  maxRestructuredTenorMonths: 12,
  requiredDocumentCodes: ["PAYSLIP"],
};
