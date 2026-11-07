/** Calendar helpers on ISO date strings (YYYY-MM-DD), timezone-independent. */

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's date in Africa/Lagos (WAT, UTC+1, no DST). */
export function todayLagos(now: Date = new Date()): string {
  return toIsoDate(new Date(now.getTime() + 60 * 60 * 1000));
}

export function parseIso(date: string): { y: number; mo: number; d: number } {
  const [y, mo, d] = date.split("-").map(Number);
  return { y, mo, d };
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function fmt(y: number, mo: number, d: number): string {
  return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/** Add months, clamping the day to the target month's length (31 Jan + 1 → 28/29 Feb). */
export function addMonths(date: string, months: number, dayOfMonth?: number): string {
  const { y, mo, d } = parseIso(date);
  const total = y * 12 + (mo - 1) + months;
  const ny = Math.floor(total / 12);
  const nmo = (total % 12) + 1;
  return fmt(ny, nmo, Math.min(dayOfMonth ?? d, daysInMonth(ny, nmo)));
}

function utc(date: string): number {
  const { y, mo, d } = parseIso(date);
  return Date.UTC(y, mo - 1, d);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const { y, mo, d } = parseIso(date);
  return toIsoDate(new Date(Date.UTC(y, mo - 1, d + days)));
}

/** Whole months of service between employment date and a reference date. */
export function monthsBetween(from: string, to: string): number {
  const a = parseIso(from);
  const b = parseIso(to);
  let months = (b.y - a.y) * 12 + (b.mo - a.mo);
  if (b.d < a.d) months -= 1;
  return Math.max(0, months);
}

/** First repayment due date: the payroll day in the month after disbursement, plus any grace months. */
export function firstDueDate(disbursementDate: string, repaymentDay: number, graceMonths: number): string {
  return addMonths(disbursementDate, 1 + graceMonths, repaymentDay);
}

export function firstOfMonth(date: string): string {
  const { y, mo } = parseIso(date);
  return fmt(y, mo, 1);
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  const d = typeof date === "string" ? new Date(date.length === 10 ? `${date}T12:00:00Z` : date) : date;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).replace("Sept", "Sep");
}

export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" }).replace("Sept", "Sep");
}

/** "1 month", "6 months". */
export function monthsText(n: number | string | null | undefined): string {
  return `${n ?? 0} ${Number(n) === 1 ? "month" : "months"}`;
}

/** A length of service in plain words: whole years as years ("2 years"), otherwise months ("18 months"). */
export function serviceLength(months: number): string {
  if (months > 0 && months % 12 === 0) return `${months / 12} ${months === 12 ? "year" : "years"}`;
  return `${months} ${months === 1 ? "month" : "months"}`;
}
