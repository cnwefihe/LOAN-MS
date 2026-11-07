import { sql } from "drizzle-orm";
import type { Executor } from "@/db";

/*
 * Every reference in the system has one format: LMS-YYMMDD-NNN (date in West Africa Time and a daily
 * sequence shared by all record types, so no two records ever share a number). A loan request keeps
 * its reference for life: the application and the loan account it becomes carry the same number.
 * Payments, receipts and documents get their own reference and always show the loan's reference
 * alongside it.
 */

/** YYMMDD in West Africa Time. */
function lagosDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "2-digit", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");
}

/** Next reference, e.g. LMS-261101-001. Concurrency-safe: the counter row is locked for the caller's transaction. */
export async function nextReference(db: Executor, at = new Date()): Promise<string> {
  const key = `LMS-${lagosDate(at)}`;
  const res = await db.execute<{ value: number }>(sql`
    insert into reference_counters (prefix, value) values (${key}, 1)
    on conflict (prefix) do update set value = reference_counters.value + 1
    returning value`);
  const value = Number((res as unknown as { rows: { value: number }[] }).rows[0].value);
  return `${key}-${String(value).padStart(3, "0")}`;
}

export const REFERENCE_PATTERN = /^LMS-\d{6}-\d{3,}$/;
