/**
 * Loan policy parameter schema. A policy version's `parameters` JSON must satisfy this schema;
 * it is validated on save in the admin console and again whenever it is loaded.
 */
import { z } from "zod";
import { monthsText } from "@/lib/finance/dates";

const moneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "Must be a non-negative amount with at most 2 decimals");
const percent = z.number().min(0).max(100);

export const SALARY_BASES = ["basic", "gross", "net"] as const;
export const AFFORDABILITY_RULES = ["take_home_floor", "deduction_cap"] as const;
export const INTEREST_METHODS = ["interest_free", "flat", "reducing_balance"] as const;
// Leave is not an employment status: confirmed staff on leave stay confirmed.
// ("on_leave" remains in the database enum for compatibility but is no longer offered.)
export const EMPLOYMENT_STATUSES = ["probation", "confirmed", "contract", "suspended", "exited"] as const;

export const REPAYMENT_FREQUENCIES = ["monthly", "bi_monthly", "quarterly"] as const;
/** A loan, or an advance against the staff member's own salary or leave allowance. */
export const PRODUCT_TYPES = ["loan", "advance"] as const;
/** What an advance is taken against. */
export const ADVANCE_TYPES = { salary: "Salary", leave_allowance: "Leave allowance", thirteenth_month: "13th month pay" } as const;
export type AdvanceType = keyof typeof ADVANCE_TYPES;

export const policyParametersSchema = z
  .object({
    productType: z.enum(PRODUCT_TYPES).default("loan"),
    // Eligibility. There is no minimum or maximum loan amount: what a person can borrow is set by
    // what they earn, through the affordability rule below.
    minServiceMonths: z.number().int().min(0).max(600),
    // Who may apply. HR checks the applicant's status against this at review.
    eligibleEmploymentStatuses: z.array(z.enum(EMPLOYMENT_STATUSES)).min(1),
    maxActiveLoans: z.number().int().min(1).max(10),
    // Pricing: interest only; the University charges no fees.
    interestMethod: z.enum(INTEREST_METHODS),
    annualInterestRate: z.number().min(0).max(100),
    // Tenor & affordability
    // Every loan is repaid within twelve months.
    minTenorMonths: z.number().int().min(1).max(12),
    maxTenorMonths: z.number().int().min(1).max(12),
    deductionBasis: z.enum(SALARY_BASES),
    maxDeductionPercent: percent,
    /**
     * How affordability is tested. "take_home_floor": after all loan deductions, net pay must stay at
     * or above minTakeHomePercent of gross (the University's form). "deduction_cap": loan deductions
     * may not exceed maxDeductionPercent of the deduction-basis pay.
     */
    affordabilityRule: z.enum(AFFORDABILITY_RULES).default("deduction_cap"),
    minTakeHomePercent: percent.default(40),
    /** Counted against the deduction limit whenever a cafeteria deduction is on the payslip, whatever was used. */
    cafeteriaAmount: moneyString.default("25000.00"),
    // Guarantors
    requiredGuarantors: z.number().int().min(0).max(2), // institutional rule: at most two guarantors per loan
    guarantorMinServiceMonths: z.number().int().min(0).max(600),
    guarantorMustBeConfirmed: z.boolean(),
    maxGuarantorExposure: moneyString,
    maxGuaranteesPerGuarantor: z.number().int().min(1).max(10),
    /** A guarantor's deductions, with their share of the loans they guarantee, may take at most this much of their net pay. */
    guarantorMaxDeductionPercent: percent.default(30),
    // Servicing
    repaymentFrequency: z.enum(REPAYMENT_FREQUENCIES).default("monthly"),
    repaymentDayOfMonth: z.number().int().min(1).max(28),
    gracePeriodMonths: z.number().int().min(0).max(12),
    overdueAfterDays: z.number().int().min(0).max(90),
    defaultAfterDays: z.number().int().min(1).max(720),
    reminderDaysBeforeDue: z.number().int().min(0).max(30),
    earlySettlementRebate: z.enum(["none", "unearned_interest"]),
    allowRestructuring: z.boolean(),
    maxRestructuredTenorMonths: z.number().int().min(1).max(12),
    // Requirements
    requiredDocumentCodes: z.array(z.string()).max(20),
  })
  .superRefine((p, ctx) => {
    if (p.minTenorMonths > p.maxTenorMonths) ctx.addIssue({ code: "custom", path: ["minTenorMonths"], message: "Minimum tenor exceeds maximum tenor" });
    if (p.interestMethod === "interest_free" && p.annualInterestRate !== 0)
      ctx.addIssue({ code: "custom", path: ["annualInterestRate"], message: "Interest-free products must have a 0% rate" });
    if (p.interestMethod !== "interest_free" && p.annualInterestRate === 0)
      ctx.addIssue({ code: "custom", path: ["interestMethod"], message: "Use the interest-free method for a 0% rate" });
    if (p.defaultAfterDays <= p.overdueAfterDays)
      ctx.addIssue({ code: "custom", path: ["defaultAfterDays"], message: "Default threshold must be after the overdue threshold" });
    const period = p.repaymentFrequency === "quarterly" ? 3 : p.repaymentFrequency === "bi_monthly" ? 2 : 1;
    if (p.minTenorMonths % period !== 0 || p.maxTenorMonths % period !== 0)
      ctx.addIssue({ code: "custom", path: ["repaymentFrequency"], message: `Minimum and maximum tenor must be multiples of ${monthsText(period)} for this repayment frequency` });
    if (p.maxRestructuredTenorMonths < p.maxTenorMonths)
      ctx.addIssue({ code: "custom", path: ["maxRestructuredTenorMonths"], message: "Restructured tenor limit cannot be below the normal maximum tenor" });
  });

export type PolicyParameters = z.output<typeof policyParametersSchema>;

export function parsePolicy(raw: unknown): PolicyParameters {
  return policyParametersSchema.parse(raw);
}

/** Human-readable labels used by the admin console and policy summaries. */
export const POLICY_FIELD_LABELS: Record<keyof PolicyParameters, string> = {
  productType: "Product type",
  minServiceMonths: "Minimum length of service (months)",
  eligibleEmploymentStatuses: "Eligible employment statuses",
  maxActiveLoans: "Maximum active loans per staff member",
  interestMethod: "Interest method",
  annualInterestRate: "Annual interest rate (%)",
  minTenorMonths: "Minimum tenor (months)",
  maxTenorMonths: "Maximum tenor (months)",
  deductionBasis: "Salary basis for deduction limit",
  maxDeductionPercent: "Deduction limit (% of net pay on the payslip)",
  affordabilityRule: "Affordability rule",
  minTakeHomePercent: "Minimum take-home pay after deductions (% of gross)",
  cafeteriaAmount: "Cafeteria amount counted (₦)",
  requiredGuarantors: "Guarantors required",
  guarantorMinServiceMonths: "Guarantor minimum service (months)",
  guarantorMustBeConfirmed: "Guarantor must be confirmed staff",
  maxGuarantorExposure: "Maximum guarantor exposure (₦)",
  maxGuaranteesPerGuarantor: "Maximum active guarantees per guarantor",
  guarantorMaxDeductionPercent: "Guarantor deduction limit (% of net pay)",
  repaymentFrequency: "Repayment frequency",
  repaymentDayOfMonth: "Repayment day of month",
  gracePeriodMonths: "Grace period (months)",
  overdueAfterDays: "Overdue after (days past due)",
  defaultAfterDays: "Default after (days past due)",
  reminderDaysBeforeDue: "Reminder lead time (days)",
  earlySettlementRebate: "Early settlement interest rebate",
  allowRestructuring: "Restructuring permitted",
  maxRestructuredTenorMonths: "Maximum restructured tenor (months)",
  requiredDocumentCodes: "Required document codes",
};
