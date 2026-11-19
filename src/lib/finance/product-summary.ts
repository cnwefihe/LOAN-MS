/**
 * The words staff read about a product, written from its current terms. Whenever an administrator changes
 * a term (service, tenor, interest, guarantors, who may apply), the description and the terms change with it.
 */
import type { PolicyParameters } from "./policy";
import { serviceLength } from "./dates";

const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

/** "Confirmed members of staff", or "Confirmed, probation and contract members of staff". */
export function staffLabel(statuses: readonly string[]) {
  const names = statuses.map((s) => s.replace("_", " "));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `${list[0].toUpperCase()}${list.slice(1)} members of staff`;
}

/** "Confirmed members of staff with at least 2 years' service, subject to verification by Human Resources." */
export function whoMayApply(x: PolicyParameters) {
  const service = x.minServiceMonths > 0 ? ` with at least ${serviceLength(x.minServiceMonths)}' service` : "";
  return `${staffLabel(x.eligibleEmploymentStatuses)}${service}, subject to verification by Human Resources.`;
}

/** One or two sentences summing up the product, from its terms. */
export function productSummary(x: PolicyParameters) {
  const who = staffLabel(x.eligibleEmploymentStatuses).replace(/^./, (c) => c.toLowerCase());
  const service = x.minServiceMonths > 0 ? ` with at least ${serviceLength(x.minServiceMonths)}' service` : "";
  if (x.productType === "advance") {
    return `An interest-free advance on your salary, leave allowance or 13th month, recovered in one deduction from that payment. For ${who}${service}.`;
  }
  const tenor = x.minTenorMonths === x.maxTenorMonths ? months(x.maxTenorMonths) : `up to ${months(x.maxTenorMonths)}`;
  const interest = x.interestMethod === "interest_free" ? "interest-free" : `at ${x.annualInterestRate}% a year`;
  const guarantors = x.requiredGuarantors === 0 ? "No guarantors needed." : `${x.requiredGuarantors === 2 ? "Two guarantors" : "One guarantor"} needed.`;
  return `A loan ${interest}, repaid by monthly salary deduction over ${tenor}. For ${who}${service}. ${guarantors}`;
}
