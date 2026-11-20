/**
 * Eligibility for a particular staff member: the pure calculation plus the institution's lending
 * rules, worked out from their latest payslip. Runs on the server (authoritative, on save and submit)
 * and in the browser (live calculator) from the same inputs, so the two always agree.
 *
 * Loans:    the monthly instalment (principal plus interest) must fit within what is left of 33.3% of
 *           net pay once the deductions already on the payslip are counted (see payslip.ts).
 * Advances: part of a payment already due, recovered in one deduction from that payment.
 */
import { assessEligibility, type EligibilityResult } from "./calculator";
import { dec, formatNaira, m } from "./money";
import { assessPayslip, payslipMonthProblem, type Payslip, type PayslipAssessment, type PayslipRules } from "./payslip";
import type { AdvanceType, PolicyParameters } from "./policy";

export interface StaffContext {
  /** The staff member's latest payslip, as read (null when none has been uploaded). */
  payslip: Payslip | null;
  serviceMonths: number;
  employmentStatus: string | null;
  /** What they could be asked to repay each month on loans they guarantee (0 when not counted). */
  guaranteeCommitment: string;
  /** Live loans plus applications in progress. */
  openCount: number;
  oneLoanAtATime: boolean;
  /**
   * Whether to apply the checks on the Human Resources record (length of service, employment status).
   * Off for the staff member applying, except where their record is known (see `recordKnown`); Human
   * Resources checks the rest when verifying.
   */
  checkRecord?: boolean;
  /**
   * Whether the employment date and status are on record (from the Register or Human Resources). A staff
   * member who has not served long enough, or whose status does not qualify, is refused at once; one with
   * no record yet is asked to have Human Resources update it. Neither reaches guarantors.
   */
  recordKnown?: boolean;
}

/** For an advance: the payment it is taken against, and what is left of it once the advance is deducted. */
export interface AdvanceFigures {
  type: AdvanceType;
  /** What that payment comes to before the advance. */
  payment: string;
  /** Still paid to the staff member with that payment after the advance is recovered. */
  remaining: string | null;
}

export type StaffEligibility = EligibilityResult & {
  payslip: PayslipAssessment | null;
  guaranteeCommitment: string;
  advance?: AdvanceFigures;
};

export const ONE_LOAN_REASON = "You already have a loan or an application in progress. Staff may hold one loan at a time; you may apply again once it has been repaid in full.";
export const NO_PAYSLIP_REASON = "Upload your latest payslip to see what you can borrow.";
export const NO_RECORD_REASON = "Your employment date and confirmation are not on record yet. Please ask Human Resources to update your record before applying.";

export interface AssessOptions {
  requestedAmount?: string;
  tenorMonths?: number;
  asOf?: string;
  /** Advances only: the payment it is against. */
  advanceType?: AdvanceType | null;
}

/** The Human Resources record as the checks should see it: left out when `checkRecord` is off. */
const record = (policy: PolicyParameters, ctx: StaffContext) => ctx.checkRecord === false && !ctx.recordKnown
  ? { policy: { ...policy, minServiceMonths: 0 }, serviceMonths: ctx.serviceMonths, employmentStatus: null }
  : { policy, serviceMonths: ctx.serviceMonths, employmentStatus: ctx.employmentStatus };

export const payslipRules = (p: PolicyParameters): PayslipRules => ({ capPercent: p.maxDeductionPercent, cafeteriaAmount: p.cafeteriaAmount });

/** An assessment with nothing to go on, so the screens can still show why. */
function blocked(policy: PolicyParameters, ctx: StaffContext, reasons: string[], payslip: PayslipAssessment | null): StaffEligibility {
  const r = assessEligibility({
    ...record(policy, ctx), salary: { basic: 0, gross: 0, net: 0 },
    existingMonthlyDeductions: 0, activeLoanCount: 0,
  });
  return { ...r, eligible: false, reasons: [...reasons, ...r.reasons.filter((x) => x !== "Salary information is missing." && !x.startsWith("Existing"))], payslip, guaranteeCommitment: ctx.guaranteeCommitment };
}

export function assessForStaff(policy: PolicyParameters, ctx: StaffContext, opts: AssessOptions): StaffEligibility {
  // Staff applying need their employment date and status on record: without them length of service cannot be checked.
  if (ctx.checkRecord === false && ctx.recordKnown === false) return blocked(policy, ctx, [NO_RECORD_REASON], null);
  if (!ctx.payslip) return blocked(policy, ctx, [NO_PAYSLIP_REASON], null);
  // The staff member applying must use their latest payslip (last month's or this month's). Reviewers later
  // assess on the payslip the application was submitted with, whatever the month they review it.
  const stale = ctx.checkRecord === false && opts.asOf ? payslipMonthProblem(ctx.payslip.period, opts.asOf) : null;
  if (stale) return blocked(policy, ctx, [stale], null);
  const slip = assessPayslip(ctx.payslip, payslipRules(policy));
  if (slip.problems.length) return blocked(policy, ctx, slip.problems, slip);
  if (policy.productType === "advance") return assessAdvance(policy, ctx, slip, opts);

  const result = assessEligibility({
    ...record(policy, ctx),
    policy: { ...record(policy, ctx).policy, affordabilityRule: "deduction_cap", deductionBasis: "net", ...(ctx.oneLoanAtATime ? { maxActiveLoans: 1 } : {}) },
    salary: { basic: slip.basic, gross: slip.payForLending, net: slip.netPay },
    existingMonthlyDeductions: m(dec(slip.committed).plus(ctx.guaranteeCommitment)),
    activeLoanCount: ctx.openCount,
    requestedAmount: opts.requestedAmount, tenorMonths: opts.tenorMonths, asOf: opts.asOf,
  });
  if (ctx.oneLoanAtATime && ctx.openCount > 0) {
    // Plain explanation in place of the generic limit message.
    result.reasons = [ONE_LOAN_REASON, ...result.reasons.filter((x) => !x.startsWith("You already hold"))];
  }
  result.reasons = result.reasons.map((x) => {
    if (!x.startsWith("Existing loan deductions")) return x;
    // Say what uses up the limit: the payslip's deductions, or the loans they guarantee.
    if (dec(slip.room).greaterThan(0) && dec(ctx.guaranteeCommitment).greaterThan(0))
      return `The share of the loans you guarantee (${formatNaira(ctx.guaranteeCommitment)} a month) leaves no room for a further repayment. This reduces as the borrower repays and ends when their loan is closed.`;
    return `Your deductions of ${formatNaira(slip.committed)} a month already use the ${slip.capPercent}% of your net pay (${formatNaira(slip.limit)}) available for repayments.`;
  });
  return { ...result, payslip: slip, guaranteeCommitment: ctx.guaranteeCommitment };
}

/**
 * An advance is part of a payment the staff member is already due, paid early and recovered in one
 * deduction from that payment. It carries no interest and no guarantors.
 *   Salary:                     up to the net pay on the payslip (what is actually paid, after every deduction).
 *   Leave allowance, 13th month: up to one month's basic salary, paid in full with no deductions.
 */
function assessAdvance(policy: PolicyParameters, ctx: StaffContext, slip: PayslipAssessment, opts: AssessOptions): StaffEligibility {
  const type = opts.advanceType ?? "salary";
  const p = ctx.payslip!;
  const printedNet = p.totals.net ?? m(dec(p.earnings.reduce((s, l) => s.plus(l.amount), dec(0))).minus(p.deductions.reduce((s, l) => s.plus(l.amount), dec(0))));
  const payment = type === "salary" ? m(printedNet) : slip.basic;
  const result = assessEligibility({
    ...record(policy, ctx),
    policy: { ...record(policy, ctx).policy, affordabilityRule: "take_home_floor", minTakeHomePercent: 0, minTenorMonths: 1, maxTenorMonths: 1, interestMethod: "interest_free", annualInterestRate: 0 },
    salary: { basic: slip.basic, gross: payment, net: payment },
    existingMonthlyDeductions: 0, activeLoanCount: 0,
    requestedAmount: opts.requestedAmount, tenorMonths: 1, asOf: opts.asOf,
  });
  result.reasons = result.reasons.map((x) => x
    .replace(/^The amount you asked for is (.*) more than the most you can borrow \((.*)\)\.$/, "The amount requested is $1 more than the most that can be advanced ($2).")
    .replace(/^Your net pay would fall below 0% of your gross pay, so there is no room for a loan repayment\.$/, "Nothing is left of this payment to advance."));
  const remaining = result.quote ? m(dec(payment).minus(result.quote.principal)) : null;
  return { ...result, payslip: slip, guaranteeCommitment: "0.00", advance: { type, payment, remaining } };
}

/**
 * Whether a guarantor could take over their share of the repayments if the borrower stopped paying,
 * read the same way as a borrower's payslip: their share a month must fit within what is left of the
 * guarantor deduction limit (30% of net pay unless the product says otherwise), after the deductions on
 * their own payslip and the other loans they guarantee.
 */
export function guarantorCover(policy: PolicyParameters, input: { payslip: Payslip; otherGuarantees: string; monthlyShare: string; asOf?: string }) {
  const read = assessPayslip(input.payslip, { ...payslipRules(policy), capPercent: policy.guarantorMaxDeductionPercent });
  // A guarantor, too, must use their latest payslip (last month's or this month's) on the day they accept.
  const stale = input.asOf ? payslipMonthProblem(input.payslip.period, input.asOf) : null;
  const slip = stale ? { ...read, problems: [stale, ...read.problems] } : read;
  const available = dec(slip.room).minus(input.otherGuarantees);
  return {
    payslip: slip, otherGuarantees: m(input.otherGuarantees),
    available: m(available.greaterThan(0) ? available : 0), monthlyShare: m(input.monthlyShare),
    ok: !slip.problems.length && available.greaterThanOrEqualTo(input.monthlyShare),
  };
}
