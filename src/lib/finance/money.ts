/**
 * Decimal-safe money helpers. All monetary values cross boundaries as strings ("12345.67")
 * and are computed with decimal.js, never JavaScript floating point.
 */
import Decimal from "decimal.js";

export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;
export type MoneyInput = string | number | Dec;

export const ZERO = new D(0);

export function dec(v: MoneyInput | null | undefined): Dec {
  if (v === null || v === undefined || v === "") return ZERO;
  return new D(v);
}

/** Round to kobo (2 dp), half-up. */
export function round2(v: MoneyInput): Dec {
  return dec(v).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** Round down to kobo; used for eligibility ceilings so we never exceed a limit. */
export function floor2(v: MoneyInput): Dec {
  return dec(v).toDecimalPlaces(2, D.ROUND_DOWN);
}

/** Canonical DB/string form with exactly 2 decimals. */
export function m(v: MoneyInput | null | undefined): string {
  return round2(dec(v)).toFixed(2);
}

export function sum(values: MoneyInput[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(dec(v)), ZERO);
}

export function minDec(...values: Dec[]): Dec {
  return values.reduce((a, b) => (a.lessThan(b) ? a : b));
}

export function maxDec(...values: Dec[]): Dec {
  return values.reduce((a, b) => (a.greaterThan(b) ? a : b));
}

const ngn = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });

/** Display only. Accepts the canonical string; formatting a float here is acceptable because it is never fed back into arithmetic. */
export function formatNaira(v: MoneyInput | null | undefined): string {
  if (v === null || v === undefined || v === "") return "N/A";
  return ngn.format(Number(round2(dec(v)).toFixed(2)));
}

/** Parse user-entered money ("1,250,000.50", "₦ 50000") to canonical string; throws on invalid. */
export function parseMoneyInput(raw: string): string {
  const cleaned = raw.replace(/[₦,\s]/g, "").replace(/^NGN/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error(`Invalid amount: ${raw}`);
  return m(cleaned);
}
