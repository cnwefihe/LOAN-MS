/**
 * Loan calculation engine: pure functions, no I/O. Used server-side for eligibility checks,
 * quotes, approvals, schedules and restructuring. All arithmetic uses decimal.js.
 *
 * Rounding convention: each scheduled amount is rounded half-up to kobo; the final instalment
 * absorbs rounding residue so that schedule totals equal principal + interest exactly.
 */
import { D, type Dec, type MoneyInput, ZERO, dec, round2, floor2, m, minDec, sum, formatNaira } from "./money";
import { addMonths, firstDueDate, serviceLength } from "./dates";
import type { PolicyParameters } from "./policy";
import { monthsText } from "@/lib/finance/dates";

export type InterestMethod = PolicyParameters["interestMethod"];

export interface MonthlySalary {
  basic: MoneyInput;
  gross: MoneyInput;
  net: MoneyInput;
}

export interface SalaryFigures {
  monthlyBasic: string; annualBasic: string;
  monthlyGross: string; annualGross: string;
  monthlyNet: string; annualNet: string;
}

export function salaryFigures(s: MonthlySalary, annualMonths = 12): SalaryFigures {
  const k = new D(annualMonths);
  return {
    monthlyBasic: m(s.basic), annualBasic: m(dec(s.basic).times(k)),
    monthlyGross: m(s.gross), annualGross: m(dec(s.gross).times(k)),
    monthlyNet: m(s.net), annualNet: m(dec(s.net).times(k)),
  };
}

function monthlyOf(s: MonthlySalary, basis: PolicyParameters["deductionBasis"]): Dec {
  return dec(basis === "basic" ? s.basic : basis === "gross" ? s.gross : s.net);
}

/* ───────────────────────────── Pricing ───────────────────────────── */

export interface ScheduleLine {
  sequence: number;
  dueDate: string | null;
  openingBalance: string;
  principalDue: string;
  interestDue: string;
  totalDue: string;
  closingBalance: string;
}

export interface Quote {
  principal: string;
  tenorMonths: number;
  interestMethod: InterestMethod;
  annualInterestRate: string;
  totalInterest: string;
  totalRepayable: string;
  monthlyInstalment: string;
  periodMonths: number;
  instalmentCount: number;
  /** Indicative only (set when no real dates are known): final due date if disbursed today. */
  estimatedCompletionDate?: string;
  /** Indicative only: first due date if disbursed today. */
  estimatedFirstDueDate?: string;
  schedule: ScheduleLine[];
}

/** Level instalment for a reducing-balance (annuity) loan, before rounding. */
function annuityPayment(principal: Dec, monthlyRate: Dec, n: number): Dec {
  if (monthlyRate.isZero()) return principal.div(n);
  const factor = monthlyRate.plus(1).pow(-n);
  return principal.times(monthlyRate).div(new D(1).minus(factor));
}

export function buildSchedule(
  principalIn: MoneyInput,
  tenorMonths: number,
  method: InterestMethod,
  annualRatePct: MoneyInput,
  firstDueDate: string | null = null,
  periodMonths = 1,
): ScheduleLine[] {
  if (!Number.isInteger(tenorMonths) || tenorMonths < 1) throw new Error("Tenor must be a positive whole number of months");
  if (![1, 2, 3].includes(periodMonths)) throw new Error("Repayment frequency must be every 1, 2 or 3 months");
  if (tenorMonths % periodMonths !== 0) throw new Error(`Tenor must be a multiple of ${monthsText(periodMonths)} (the repayment frequency)`);
  const principal = round2(principalIn);
  if (principal.lessThanOrEqualTo(0)) throw new Error("Principal must be positive");
  const rate = dec(annualRatePct);
  // n instalments, one every periodMonths; tenor (and flat interest) stay expressed in months.
  const n = tenorMonths / periodMonths;
  const lines: ScheduleLine[] = [];
  const due = (i: number) => (firstDueDate ? addMonths(firstDueDate, i * periodMonths) : null);

  const repayBase = principal;

  if (method === "reducing_balance" && rate.greaterThan(0)) {
    const i = rate.div(1200).times(periodMonths);
    const payment = round2(annuityPayment(repayBase, i, n));
    let balance = repayBase;
    // Every instalment is the same payment (Excel's =PMT), so the total repayable is exactly payment × n.
    // The last one clears the balance; its interest takes up the kobo left over from rounding.
    for (let k = 0; k < n; k++) {
      const last = k === n - 1;
      const principalPart = last ? balance : minDec(payment.minus(round2(balance.times(i))), balance);
      const interest = last ? D.max(0, payment.minus(balance)) : round2(balance.times(i));
      const closing = balance.minus(principalPart);
      lines.push({
        sequence: k + 1, dueDate: due(k), openingBalance: m(balance), principalDue: m(principalPart),
        interestDue: m(interest), totalDue: m(principalPart.plus(interest)), closingBalance: m(closing),
      });
      balance = closing;
    }
    return lines;
  }

  // Flat-rate and interest-free: interest is computed on the original principal for the full term.
  const totalInterest = method === "flat" ? round2(principal.times(rate).div(100).times(tenorMonths).div(12)) : ZERO;
  const principalEach = round2(repayBase.div(n));
  const interestEach = round2(totalInterest.div(n));
  let balance = repayBase;
  let interestLeft = totalInterest;
  for (let k = 0; k < n; k++) {
    const last = k === n - 1;
    const p = last ? balance : minDec(principalEach, balance);
    const it = last ? interestLeft : minDec(interestEach, interestLeft);
    const closing = balance.minus(p);
    lines.push({
      sequence: k + 1, dueDate: due(k), openingBalance: m(balance), principalDue: m(p),
      interestDue: m(it), totalDue: m(p.plus(it)), closingBalance: m(closing),
    });
    balance = closing;
    interestLeft = interestLeft.minus(it);
  }
  return lines;
}

export function quoteLoan(
  principalIn: MoneyInput,
  tenorMonths: number,
  method: InterestMethod,
  annualRatePct: MoneyInput,
  firstDueDate: string | null = null,
  periodMonths = 1,
): Quote {
  const principal = round2(principalIn);
  const schedule = buildSchedule(principal, tenorMonths, method, annualRatePct, firstDueDate, periodMonths);
  const totalInterest = sum(schedule.map((l) => l.interestDue));
  const totalRepayable = sum(schedule.map((l) => l.totalDue));
  return {
    principal: m(principal),
    tenorMonths,
    interestMethod: method,
    annualInterestRate: dec(annualRatePct).toFixed(4),
    totalInterest: m(totalInterest),
    totalRepayable: m(totalRepayable),
    // The level (first) instalment is the contractual per-period figure ("monthlyInstalment" for the
    // default monthly frequency); the last may differ by rounding.
    monthlyInstalment: schedule[0].totalDue,
    periodMonths,
    instalmentCount: schedule.length,
    schedule,
  };
}

/**
 * After a part prepayment: the new principal balance repaid over the months left. Interest is recalculated
 * on the new balance (flat: balance × rate × months ÷ 12), so interest on the amount repaid early is no longer
 * charged and the instalments shrink. When `keepInterest` is given (the policy gives no rebate), that interest
 * is kept and spread over the same months instead.
 */
export function rescheduleRemaining(
  balance: MoneyInput, months: number, method: InterestMethod, annualRatePct: MoneyInput,
  firstDueDate: string, periodMonths = 1, keepInterest?: MoneyInput,
): ScheduleLine[] {
  if (keepInterest === undefined) return buildSchedule(balance, months, method, annualRatePct, firstDueDate, periodMonths);
  const lines = buildSchedule(balance, months, "interest_free", 0, firstDueDate, periodMonths);
  const total = round2(keepInterest);
  const each = round2(total.div(lines.length));
  let left = total;
  return lines.map((l, k) => {
    const it = k === lines.length - 1 ? left : minDec(each, left);
    left = left.minus(it);
    return { ...l, interestDue: m(it), totalDue: m(dec(l.principalDue).plus(it)) };
  });
}

/** Largest principal whose instalment (per repayment period) does not exceed `cap`, over n instalments. */
export function maxPrincipalForInstalment(cap: MoneyInput, n: number, method: InterestMethod, annualRatePct: MoneyInput, periodMonths = 1): Dec {
  const c = dec(cap);
  if (c.lessThanOrEqualTo(0)) return ZERO;
  const r = dec(annualRatePct);
  let max: Dec;
  if (method === "interest_free" || r.isZero()) max = floor2(c.times(n));
  else if (method === "flat") max = floor2(c.times(n).div(new D(1).plus(r.div(100).times(n * periodMonths).div(12))));
  // Reducing balance: Excel's =PV(rate/12, n, -payment), rounded to the kobo as Excel shows it.
  else { const i = r.div(1200).times(periodMonths); max = round2(c.times(new D(1).minus(i.plus(1).pow(-n))).div(i)); }
  return D.max(0, max);
}

export const PERIOD_MONTHS = { monthly: 1, bi_monthly: 2, quarterly: 3 } as const;
export const FREQUENCY_LABEL = { monthly: "Monthly", bi_monthly: "Every two months", quarterly: "Quarterly" } as const;

/** Instalment label for UI: "monthly", "two-monthly", "quarterly". */
export function instalmentLabel(periodMonths: number | null | undefined): string {
  return periodMonths === 3 ? "Quarterly instalment" : periodMonths === 2 ? "Two-monthly instalment" : "Monthly instalment";
}

/* ───────────────────────────── Eligibility ───────────────────────────── */

export interface EligibilityInput {
  policy: PolicyParameters;
  salary: MonthlySalary;
  serviceMonths: number;
  employmentStatus: string | null;
  /** Sum of monthly instalments on the applicant's existing active loans. */
  existingMonthlyDeductions: MoneyInput;
  activeLoanCount: number;
  requestedAmount?: MoneyInput;
  tenorMonths?: number;
  /** Assessment date; when given, the quote includes an estimated completion date. */
  asOf?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  warnings: string[];
  salary: SalaryFigures;
  maxByAffordability: string;
  maxEligibleAmount: string;
  affordabilityRule: PolicyParameters["affordabilityRule"];
  /** Take-home rule: the minimum net pay that must remain after all loan deductions. */
  takeHomeFloor: string;
  /** Net pay left after current commitments and, when an amount is given, this loan's instalment. */
  takeHomeAfter: string;
  /** takeHomeAfter as a percentage of gross pay (the form's "net pay ≥ 40% of gross" test). */
  takeHomePercentAfter: string;
  /** Monthly pay the deduction limit is measured against (the policy's deduction basis). */
  deductionBaseMonthly: string;
  monthlyDeductionCap: string;
  /** The same limit over a year (12 monthly deductions). */
  annualDeductionCap: string;
  existingMonthlyDeductions: string;
  availableMonthlyCapacity: string;
  requestedAmount: string | null;
  requestedWithinEligible: boolean | null;
  shortfall: string | null;
  tenorMonths: number;
  /** Shortest valid duration whose instalment fits the available deduction capacity, for the requested amount. */
  suggestedTenorMonths: number | null;
  /** True when the duration was chosen automatically (no duration given, an amount was). */
  tenorAutomatic: boolean;
  /** Monthly equivalent of the instalment for the requested amount. */
  instalmentMonthly: string | null;
  /** Instalment as a percentage of deduction-basis pay, and total deductions including it. */
  instalmentPercentOfPay: string | null;
  currentDeductionPercent: string;
  totalDeductionPercentAfter: string | null;
  capacityLeftAfter: string | null;
  quote: Quote | null;
}

/** Valid durations for a policy: whole numbers of repayment periods within the product's range. */
export function validTenors(p: PolicyParameters): number[] {
  const period = PERIOD_MONTHS[p.repaymentFrequency];
  const out: number[] = [];
  for (let t = Math.ceil(p.minTenorMonths / period) * period; t <= p.maxTenorMonths; t += period) out.push(t);
  return out;
}

/** Rounding allowance: a repayment rounded to the kobo, as Excel rounds =PMT, may be up to a kobo over the exact limit. */
const KOBO = new D("0.01");

const pct = (part: Dec, whole: Dec) => (whole.greaterThan(0) ? part.div(whole).times(100).toFixed(1) : "0.0");

export function assessEligibility(input: EligibilityInput): EligibilityResult {
  const p = input.policy;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const period = PERIOD_MONTHS[p.repaymentFrequency];

  const salary = salaryFigures(input.salary);

  const gross = dec(input.salary.gross);
  const net = dec(input.salary.net);
  const takeHome = p.affordabilityRule === "take_home_floor";
  // Take-home rule: what is left after loan deductions must stay at or above the floor (% of gross),
  // so the most that can be deducted is net pay less the floor. Otherwise a share of the basis pay.
  const deductionBase = takeHome ? net : monthlyOf(input.salary, p.deductionBasis);
  const takeHomeFloor = floor2(gross.times(p.minTakeHomePercent).div(100));
  const cap = takeHome ? D.max(0, floor2(net.minus(takeHomeFloor))) : floor2(deductionBase.times(p.maxDeductionPercent).div(100));
  const existing = dec(input.existingMonthlyDeductions);
  const capacity = cap.minus(existing);
  // Deduction capacity is monthly; an instalment covering `period` months may use `period` months of capacity.
  const capacityPerInstalment = capacity.times(period);

  // Shortest duration whose instalment fits the capacity, for the amount asked for.
  const hasRequest = input.requestedAmount !== undefined && input.requestedAmount !== "" && dec(input.requestedAmount).greaterThan(0);
  let suggested: number | null = null;
  if (hasRequest && capacity.greaterThan(0)) {
    for (const t of validTenors(p)) {
      const q = quoteLoan(input.requestedAmount!, t, p.interestMethod, p.annualInterestRate, null, period);
      if (dec(q.monthlyInstalment).lessThanOrEqualTo(capacityPerInstalment.plus(KOBO))) { suggested = t; break; }
    }
  }
  // Without a chosen duration: the shortest affordable one for a request, otherwise the longest allowed.
  const longest = p.maxTenorMonths - (p.maxTenorMonths % period);
  const tenorAutomatic = input.tenorMonths === undefined && hasRequest;
  const tenor = input.tenorMonths ?? (hasRequest ? suggested ?? longest : longest);
  const tenorValid = Number.isInteger(tenor) && tenor >= period && tenor % period === 0;
  const instalments = tenorValid ? tenor / period : 1;
  // The most that can be borrowed is what the deduction limit can repay over the duration; there is no product cap.
  const maxByAfford = maxPrincipalForInstalment(capacityPerInstalment, instalments, p.interestMethod, p.annualInterestRate, period);
  const maxEligible = D.max(0, maxByAfford);

  if (gross.lessThanOrEqualTo(0) || net.lessThanOrEqualTo(0)) reasons.push("Salary information is missing.");
  if (input.serviceMonths < p.minServiceMonths)
    reasons.push(`A minimum of ${serviceLength(p.minServiceMonths)} of service is required; you have ${serviceLength(input.serviceMonths)}.`);
  if (input.employmentStatus && !(p.eligibleEmploymentStatuses as string[]).includes(input.employmentStatus))
    reasons.push(input.employmentStatus === "confirmed"
      ? "This loan is not available to confirmed members of staff."
      : "Staff loans are for confirmed members of staff, and the Human Resources record does not show you as confirmed yet. If this is out of date, please contact Human Resources.");
  if (input.activeLoanCount >= p.maxActiveLoans)
    reasons.push(`You already hold ${input.activeLoanCount} active loan(s); the limit is ${p.maxActiveLoans}.`);
  if (capacity.lessThanOrEqualTo(0)) reasons.push(takeHome
    ? `Your net pay would fall below ${p.minTakeHomePercent}% of your gross pay, so there is no room for a loan repayment.`
    : "Existing loan deductions already reach the maximum monthly deduction limit.");
  if (tenor < p.minTenorMonths || tenor > p.maxTenorMonths)
    reasons.push(`The tenor must be between ${p.minTenorMonths} and ${monthsText(p.maxTenorMonths)}.`);
  if (!tenorValid) reasons.push(`The tenor must be a multiple of ${monthsText(period)} for ${FREQUENCY_LABEL[p.repaymentFrequency].toLowerCase()} repayment.`);

  let requestedWithin: boolean | null = null;
  let shortfall: string | null = null;
  let quote: Quote | null = null;
  let requested: Dec | null = null;
  if (input.requestedAmount !== undefined && input.requestedAmount !== "") {
    requested = round2(input.requestedAmount);
    requestedWithin = requested.lessThanOrEqualTo(maxEligible);
    if (requested.greaterThan(maxEligible)) {
      shortfall = m(requested.minus(maxEligible));
      reasons.push(`The amount you asked for is ${formatNaira(shortfall)} more than the most you can borrow (${formatNaira(maxEligible)}).`);
    }
    if (requested.greaterThan(0) && tenorValid) {
      quote = quoteLoan(requested, tenor, p.interestMethod, p.annualInterestRate, null, period);
      if (input.asOf) {
        const first = firstDueDate(input.asOf, p.repaymentDayOfMonth, p.gracePeriodMonths);
        quote.estimatedFirstDueDate = first;
        quote.estimatedCompletionDate = addMonths(first, (quote.instalmentCount - 1) * period);
      }
      if (dec(quote.monthlyInstalment).greaterThan(capacityPerInstalment.plus(KOBO)) && capacity.greaterThan(0))
        warnings.push(suggested
          ? `The instalment is more than you can have deducted each month at ${monthsText(tenor)}. Choose ${monthsText(suggested)} or longer.`
          : "The instalment is more than you can have deducted each month, even over the longest tenor. Reduce the amount.");
    }
  }

  const instalmentMonthly = quote ? dec(quote.monthlyInstalment).div(period) : null;
  const takeHomeAfter = net.minus(existing).minus(instalmentMonthly ?? 0);
  return {
    affordabilityRule: p.affordabilityRule,
    takeHomeFloor: m(takeHomeFloor),
    takeHomeAfter: m(takeHomeAfter),
    takeHomePercentAfter: pct(takeHomeAfter, gross),
    eligible: reasons.length === 0,
    reasons,
    warnings,
    salary,
    maxByAffordability: m(maxByAfford),
    maxEligibleAmount: m(maxEligible),
    deductionBaseMonthly: m(deductionBase),
    monthlyDeductionCap: m(cap),
    annualDeductionCap: m(cap.times(12)),
    existingMonthlyDeductions: m(existing),
    availableMonthlyCapacity: m(D.max(0, capacity)),
    requestedAmount: requested ? m(requested) : null,
    requestedWithinEligible: requestedWithin,
    shortfall,
    tenorMonths: tenor,
    suggestedTenorMonths: suggested,
    tenorAutomatic,
    instalmentMonthly: instalmentMonthly ? m(instalmentMonthly) : null,
    instalmentPercentOfPay: instalmentMonthly ? pct(instalmentMonthly, deductionBase) : null,
    currentDeductionPercent: pct(existing, deductionBase),
    totalDeductionPercentAfter: instalmentMonthly ? pct(existing.plus(instalmentMonthly), deductionBase) : null,
    capacityLeftAfter: instalmentMonthly ? m(capacity.minus(instalmentMonthly)) : null,
    quote,
  };
}

/* ───────────────────────────── Servicing ───────────────────────────── */

export interface InstalmentState {
  id: string;
  sequence: number;
  dueDate: string;
  principalDue: string;
  interestDue: string;
}

export interface Allocation {
  instalmentId: string;
  principalPaid: string;
  interestPaid: string;
}

/**
 * Allocate a stream of confirmed payments across instalments in due-date order,
 * interest before principal within each instalment. Returns per-instalment paid amounts
 * plus any unallocated overpayment.
 */
export function allocatePayments(instalments: InstalmentState[], payments: MoneyInput[]): { allocations: Allocation[]; unallocated: string } {
  const ordered = [...instalments].sort((a, b) => a.sequence - b.sequence);
  const paid = ordered.map((i) => ({ id: i.id, pDue: dec(i.principalDue), iDue: dec(i.interestDue), p: ZERO, it: ZERO }));
  let pool = sum(payments);
  for (const row of paid) {
    if (pool.lessThanOrEqualTo(0)) break;
    const iPay = minDec(pool, row.iDue.minus(row.it));
    row.it = row.it.plus(iPay);
    pool = pool.minus(iPay);
    const pPay = minDec(pool, row.pDue.minus(row.p));
    row.p = row.p.plus(pPay);
    pool = pool.minus(pPay);
  }
  return {
    allocations: paid.map((r) => ({ instalmentId: r.id, principalPaid: m(r.p), interestPaid: m(r.it) })),
    unallocated: m(pool),
  };
}

/** Split a single payment into interest and principal portions against outstanding instalments. */
export function splitPayment(instalments: (InstalmentState & { principalPaid: string; interestPaid: string })[], amount: MoneyInput): { interest: string; principal: string; excess: string } {
  let pool = dec(amount);
  let interest = ZERO;
  let principal = ZERO;
  for (const i of [...instalments].sort((a, b) => a.sequence - b.sequence)) {
    if (pool.lessThanOrEqualTo(0)) break;
    const iPay = minDec(pool, D.max(0, dec(i.interestDue).minus(i.interestPaid)));
    interest = interest.plus(iPay);
    pool = pool.minus(iPay);
    const pPay = minDec(pool, D.max(0, dec(i.principalDue).minus(i.principalPaid)));
    principal = principal.plus(pPay);
    pool = pool.minus(pPay);
  }
  return { interest: m(interest), principal: m(principal), excess: m(pool) };
}
