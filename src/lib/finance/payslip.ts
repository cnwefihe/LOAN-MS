/**
 * Loan affordability from the staff member's latest payslip, under the University's lending rule.
 *
 *   Pay for lending   = Basic + Medical                       (other earnings are ignored)
 *   Net pay           = Pay for lending − Tax − Pension − NHF (NHF only where it is deducted)
 *   Deduction limit   = 33.3% of net pay
 *   Already committed = every other deduction on the payslip: cooperative loans and contributions at
 *                       the amount shown, cafeteria at a fixed ₦25,000 whatever was used, and any other
 *                       deduction (leave allowance and 13th month pay excepted, as they offset earnings)
 *   Room for a loan   = Deduction limit − Already committed
 *
 * A loan's monthly instalment (principal plus interest, divided over the months) must fit within the room.
 * Pure functions, no I/O: the same figures are worked out in the browser and on the server.
 */
import { D, dec, floor2, m, sum, type MoneyInput } from "./money";

export interface PayslipLine { label: string; amount: string }

export interface Payslip {
  /** Name, employee code and pay grade: what is printed in each heading's column, on every line beneath it. */
  employee: { name: string; code: string; grade: string };
  /** Pay month, "YYYY-MM", when it can be read. */
  period: string | null;
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  /** Totals printed on the payslip, used to check the reading. */
  totals: { gross: string | null; deductions: string | null; net: string | null };
}

export type EarningKind = "basic" | "medical" | "leave_allowance" | "thirteenth_month" | "other";
export type DeductionKind = "tax" | "pension" | "nhf" | "leave_allowance" | "thirteenth_month" | "cooperative" | "cafeteria" | "other";

const has = (label: string, re: RegExp) => re.test(label.toLowerCase());

export function classifyEarning(label: string): EarningKind {
  if (has(label, /\bbasic\b/)) return "basic";
  if (has(label, /\bmedical\b/)) return "medical";
  if (has(label, /\bleave\b/)) return "leave_allowance";
  if (has(label, /\b13th\b|thirteenth/)) return "thirteenth_month";
  return "other";
}

export function classifyDeduction(label: string): DeductionKind {
  if (has(label, /co-?operative|\bcoop\b/)) return "cooperative";
  if (has(label, /cafeteria|canteen/)) return "cafeteria";
  if (has(label, /\bnhf\b|housing fund/)) return "nhf";
  if (has(label, /pension/)) return "pension";
  if (has(label, /\bpaye\b|\btax\b/)) return "tax";
  if (has(label, /\bleave\b/)) return "leave_allowance";
  if (has(label, /\b13th\b|thirteenth/)) return "thirteenth_month";
  return "other";
}

export interface PayslipRules {
  /** Most of net pay that all further deductions together may take, as a percentage. */
  capPercent: number;
  /** Counted for cafeteria whenever it appears, whatever was used. */
  cafeteriaAmount: string;
}

export const DEFAULT_PAYSLIP_RULES: PayslipRules = { capPercent: 33.3, cafeteriaAmount: "25000.00" };

export interface Commitment { label: string; kind: "cooperative" | "cafeteria" | "other"; shown: string; counted: string }

export interface PayslipAssessment {
  basic: string;
  medical: string;
  /** Basic plus medical. */
  payForLending: string;
  tax: string;
  pension: string;
  nhf: string;
  netPay: string;
  capPercent: number;
  /** capPercent of net pay. */
  limit: string;
  commitments: Commitment[];
  committed: string;
  /** What is left within the limit for a new loan's instalment (0 when nothing is left). */
  room: string;
  /** Lines read but not used, with why. */
  ignored: { label: string; amount: string; section: "earnings" | "deductions" }[];
  /** Problems that stop the payslip being used. */
  problems: string[];
  /** Differences between the lines and the printed totals, for the Bursary to check. */
  warnings: string[];
}

const total = (lines: PayslipLine[]) => sum(lines.map((l) => l.amount));

export function assessPayslip(p: Payslip, rules: PayslipRules = DEFAULT_PAYSLIP_RULES): PayslipAssessment {
  const problems: string[] = [];
  const warnings: string[] = [];
  const ignored: PayslipAssessment["ignored"] = [];

  const earningsOf = (k: EarningKind) => p.earnings.filter((l) => classifyEarning(l.label) === k);
  const deductionsOf = (k: DeductionKind) => p.deductions.filter((l) => classifyDeduction(l.label) === k);

  const basic = total(earningsOf("basic"));
  const medical = total(earningsOf("medical"));
  for (const l of p.earnings) if (!["basic", "medical"].includes(classifyEarning(l.label))) ignored.push({ ...l, section: "earnings" });
  if (basic.lessThanOrEqualTo(0)) problems.push("Basic salary could not be found on the payslip.");

  const tax = total(deductionsOf("tax"));
  const pension = total(deductionsOf("pension"));
  const nhf = total(deductionsOf("nhf"));
  const payForLending = basic.plus(medical);
  const netPay = payForLending.minus(tax).minus(pension).minus(nhf);

  const commitments: Commitment[] = [];
  for (const l of p.deductions) {
    const kind = classifyDeduction(l.label);
    if (kind === "leave_allowance" || kind === "thirteenth_month") ignored.push({ ...l, section: "deductions" });
    else if (kind === "cooperative" || kind === "other") commitments.push({ label: l.label, kind, shown: m(l.amount), counted: m(l.amount) });
  }
  // Cafeteria is counted once at the fixed amount, however many lines or however little was used.
  const cafeteria = deductionsOf("cafeteria");
  if (cafeteria.length) commitments.push({ label: cafeteria.map((l) => l.label).join(", "), kind: "cafeteria", shown: m(total(cafeteria)), counted: m(rules.cafeteriaAmount) });

  const limit = netPay.greaterThan(0) ? floor2(netPay.times(rules.capPercent).div(100)) : dec(0);
  const committed = sum(commitments.map((c) => c.counted));
  const room = D.max(0, limit.minus(committed));

  // Check the reading against the printed totals (payroll rounds each line, so allow up to ₦1).
  const checkTotal = (name: string, read: MoneyInput, printed: string | null) => {
    if (printed !== null && dec(read).minus(printed).abs().greaterThan(1)) warnings.push(`${name} on the payslip is ${m(printed)}, but the lines add up to ${m(read)}.`);
  };
  checkTotal("Total gross", total(p.earnings), p.totals.gross);
  checkTotal("Total deductions", total(p.deductions), p.totals.deductions);
  if (p.totals.gross !== null && p.totals.deductions !== null) checkTotal("Net pay", dec(p.totals.gross).minus(p.totals.deductions), p.totals.net);

  return {
    basic: m(basic), medical: m(medical), payForLending: m(payForLending),
    tax: m(tax), pension: m(pension), nhf: m(nhf), netPay: m(netPay),
    capPercent: rules.capPercent, limit: m(limit),
    commitments, committed: m(committed), room: m(room),
    ignored, problems, warnings,
  };
}

/* ───────────────────────── Matching the payslip to the staff record ───────────────────────── */

const words = (s: string) => s.toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Names match when every name on the shorter side appears on the other, in any order (so a middle name may be missing). */
export function namesMatch(a: string, b: string): boolean {
  const [x, y] = [words(a), words(b)];
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= Math.min(2, long.length) && short.every((w) => long.includes(w));
}

/** Reasons the payslip does not belong to this staff member (empty when it does). */
export function payslipMismatches(slip: Payslip["employee"], staff: { name: string; staffNumber: string | null; payGrade: string | null }): string[] {
  const out: string[] = [];
  if (!namesMatch(slip.name, staff.name)) out.push(`The name on the payslip (${slip.name || "not found"}) does not match your profile (${staff.name}).`);
  if (!staff.staffNumber || code(slip.code) !== code(staff.staffNumber)) out.push(`The employee code on the payslip (${slip.code || "not found"}) does not match your profile (${staff.staffNumber ?? "not entered"}).`);
  if (!staff.payGrade || code(slip.grade) !== code(staff.payGrade)) out.push(`The pay grade on the payslip (${slip.grade || "not found"}) does not match your profile (${staff.payGrade ?? "not entered"}).`);
  return out;
}
