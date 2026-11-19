import { sql } from "drizzle-orm";
import type { Executor } from "@/db";

/*
 * Every reference in the system has one format: LMS-YYMMDD-NNN (date in West Africa Time and a running
 * number shared by all record types, so no two records ever share a number). The number never starts
 * again: it runs on from day to day, 001 to 999 and then 1000 and beyond. A loan request keeps its
 * reference for life: the application and the loan account it becomes carry the same number.
 * Payments, receipts and documents get their own reference and always show the loan's reference
 * alongside it.
 */

/** The one running counter. Before it existed there was a counter per day ("LMS-YYMMDD"). */
const COUNTER = "LMS";

/** YYMMDD in West Africa Time. */
function lagosDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "2-digit", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");
}

/** Next reference, e.g. LMS-261101-001. Concurrency-safe: the counter row is locked for the caller's transaction. */
export async function nextReference(db: Executor, at = new Date()): Promise<string> {
  // The first time, the running number carries on above every number the daily counters gave out,
  // so a new reference can never repeat an old one.
  const res = await db.execute<{ value: number }>(sql`
    insert into reference_counters (prefix, value)
    select ${COUNTER}, coalesce(max(value), 0) + 1 from reference_counters where prefix like 'LMS-%'
    on conflict (prefix) do update set value = reference_counters.value + 1
    returning value`);
  const value = Number((res as unknown as { rows: { value: number }[] }).rows[0].value);
  return `LMS-${lagosDate(at)}-${String(value).padStart(3, "0")}`;
}

/**
 * The reference for a new application: a reference freed by removing a test application, oldest first,
 * otherwise the next number. Concurrency-safe: two applications can never take the same freed reference.
 */
export async function applicationReference(db: Executor, at = new Date()): Promise<string> {
  const res = await db.execute<{ reference: string }>(sql`
    delete from freed_references where reference = (
      select f.reference from freed_references f
      where not exists (select 1 from loan_applications a where a.reference = f.reference)
      order by f.reference limit 1 for update skip locked)
    returning reference`);
  const freed = (res as unknown as { rows: { reference: string }[] }).rows[0]?.reference;
  return freed ?? nextReference(db, at);
}

export const REFERENCE_PATTERN = /^LMS-\d{6}-\d{3,}$/;
