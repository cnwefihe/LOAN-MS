import { addMonths } from "@/lib/finance/dates";

/** Narrows the deduction schedule and reconciliation to one person, school or department. */
export interface DeductionFilter { borrowerId?: string; schoolId?: string; departmentId?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function deductionFilter(input: { staff?: string | null; school?: string | null; department?: string | null }): DeductionFilter {
  const ok = (v?: string | null) => (v && UUID.test(v) ? v : undefined);
  return { borrowerId: ok(input.staff), schoolId: ok(input.school), departmentId: ok(input.department) };
}

export function matchesFilter(r: { borrowerId: string; schoolId: string | null; departmentId: string | null }, f: DeductionFilter = {}) {
  return (!f.borrowerId || r.borrowerId === f.borrowerId) && (!f.schoolId || r.schoolId === f.schoolId) && (!f.departmentId || r.departmentId === f.departmentId);
}

/** A deduction period is a month ("2026-05") or a whole year ("2026"): its first day and the day after it ends. */
export function periodRange(period: string): { start: string; end: string } {
  if (/^\d{4}$/.test(period)) return { start: `${period}-01-01`, end: `${Number(period) + 1}-01-01` };
  const start = `${period}-01`;
  return { start, end: addMonths(start, 1) };
}
