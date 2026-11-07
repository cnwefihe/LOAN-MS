import type { PolicyParameters } from "./policy";
import { DEFAULT_POLICY } from "./defaults";

/**
 * Suggested starting catalogue, seeded as DRAFT products so administrators can review, change,
 * submit and approve them before anything is offered to staff. The values are
 * illustrative of common Nigerian university staff loan schemes, not approved institutional policy.
 */
export interface SuggestedProduct {
  code: string;
  name: string;
  description: string;
  documents: { code: string; label: string; appliesTo: "applicant" | "guarantor"; isRequired: boolean }[];
  policy: PolicyParameters;
}

const base: PolicyParameters = {
  ...DEFAULT_POLICY,
  eligibleEmploymentStatuses: ["confirmed"],
  maxActiveLoans: 1,
  deductionBasis: "net",
  maxDeductionPercent: 33.3,
  affordabilityRule: "deduction_cap",
  minTakeHomePercent: 40,
  guarantorMinServiceMonths: 24,
  guarantorMustBeConfirmed: true,
  maxGuaranteesPerGuarantor: 1,
  repaymentFrequency: "monthly",
  repaymentDayOfMonth: 25,
  gracePeriodMonths: 0,
  overdueAfterDays: 5,
  defaultAfterDays: 90,
  reminderDaysBeforeDue: 5,
  earlySettlementRebate: "unearned_interest",
};

export const SUGGESTED_PRODUCTS: SuggestedProduct[] = [
  {
    code: "PERSONAL",
    name: "Personal Loan",
    description: "A general-purpose loan for confirmed staff.",
    documents: [],
    policy: {
      ...base,
      minServiceMonths: 24,
      interestMethod: "reducing_balance",
      annualInterestRate: 10,
      minTenorMonths: 1,
      maxTenorMonths: 12,
      requiredGuarantors: 2,
      maxGuarantorExposure: "5000000.00",
      allowRestructuring: false,
      maxRestructuredTenorMonths: 12,
      requiredDocumentCodes: ["PAYSLIP"],
    },
  },
  {
    code: "BEREAVEMENT",
    name: "Bereavement Loan",
    description: "An interest-free loan following the loss of a close relative.",
    documents: [{ code: "BEREAVEMENT_EVIDENCE", label: "Evidence of the bereavement (for example a burial programme or death notice)", appliesTo: "applicant", isRequired: false }],
    policy: {
      ...base,
      minServiceMonths: 24,
      interestMethod: "interest_free",
      annualInterestRate: 0,
      minTenorMonths: 1,
      maxTenorMonths: 12,
      requiredGuarantors: 2,
      maxGuarantorExposure: "5000000.00",
      allowRestructuring: false,
      maxRestructuredTenorMonths: 12,
      requiredDocumentCodes: ["PAYSLIP"],
    },
  },
  {
    code: "ASSET",
    name: "Asset Loan",
    description: "A loan for a vehicle, rent or other property.",
    documents: [{ code: "PROFORMA_INVOICE", label: "Asset document (invoice, quotation or tenancy agreement)", appliesTo: "applicant", isRequired: true }],
    policy: {
      ...base,
      minServiceMonths: 24,
      interestMethod: "reducing_balance",
      annualInterestRate: 10,
      minTenorMonths: 1,
      maxTenorMonths: 12,
      requiredGuarantors: 2,
      maxGuarantorExposure: "10000000.00",
      allowRestructuring: false,
      maxRestructuredTenorMonths: 12,
      requiredDocumentCodes: ["PAYSLIP", "PROFORMA_INVOICE"],
    },
  },
  {
    code: "ADVANCE",
    name: "Salary, Leave Allowance and 13th Month Advance",
    description: "A part payment of your salary, leave allowance or 13th month pay, made early.",
    documents: [],
    policy: {
      ...base,
      productType: "advance",
      // Confirmed staff only; an advance is against the person's own pay, so no guarantors.
      eligibleEmploymentStatuses: ["confirmed"],
      minServiceMonths: 0,
      interestMethod: "interest_free",
      annualInterestRate: 0,
      // Recovered in one deduction from the payment it is made against.
      minTenorMonths: 1,
      maxTenorMonths: 1,
      requiredGuarantors: 0,
      maxGuarantorExposure: "5000000.00",
      allowRestructuring: false,
      maxRestructuredTenorMonths: 1,
      requiredDocumentCodes: ["PAYSLIP"],
    },
  },
];
