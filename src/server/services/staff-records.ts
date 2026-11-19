import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { Executor } from "@/db";
import { staffProfiles, staffRecords, users } from "@/db/schema";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";
import { isInstitutionalEmail } from "./identity";

/**
 * The administrator's staff records: employee code, pay grade, employment date and whether confirmed, with
 * an optional work email. Uploaded from a spreadsheet or edited one at a time. Each staff member's profile
 * is filled from their record (matched by employee code, then by work email) when the record is saved and
 * whenever they sign in, so staff never type these details. Eligibility reads them from the profile.
 */

export interface StaffRecordInput { employeeCode: string; email?: string | null; payGrade: string; employmentDate: string; confirmed: boolean }
export interface ParsedRow extends StaffRecordInput { row: number }
export interface Skipped { row: number; reason: string }

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const NUMERIC = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
/** A two-digit year: this century unless that would be in the future. */
const fullYear = (y: string) => y.length !== 2 ? Number(y) : 2000 + Number(y) > new Date().getUTCFullYear() ? 1900 + Number(y) : 2000 + Number(y);

/**
 * "15/03/2019", "15-03-2019", "15 Mar 2019", "15-Mar-19", "2019-03-15" or a spreadsheet date, as 2019-03-15.
 * Day first, as in Nigeria, unless `order` says the file writes the month first.
 */
export function readDate(v: unknown, order: "dmy" | "mdy" = "dmy"): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = clean(v);
  if (!s) return null;
  let y: number, mo: number | null, d: number;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = NUMERIC.exec(s))) [d, mo, y] = order === "mdy" && Number(m[1]) <= 12 ? [Number(m[2]), Number(m[1]), fullYear(m[3])] : [Number(m[1]), Number(m[2]), fullYear(m[3])];
  else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]+([a-z]{3,9})\.?[\s\-/.,]+(\d{2}|\d{4})$/i.exec(s))) [d, mo, y] = [Number(m[1]), monthOf(m[2]), fullYear(m[3])];
  else if ((m = /^([a-z]{3,9})\.?[\s\-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-]+(\d{4})$/i.exec(s))) [d, mo, y] = [Number(m[2]), monthOf(m[1]), Number(m[3])];
  else if (/^\d{5}$/.test(s)) { // a spreadsheet serial number
    const t = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return t.toISOString().slice(0, 10);
  } else return null;
  if (!mo) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/**
 * How a file writes its dates. Excel on a computer set to US dates reads "02/03/2015" as 3 February and saves
 * it back month first, while "15/03/2020" (no 15th month) is left as typed. So a column holding both kinds
 * was typed day first and Excel has switched the rest: those are switched back. A column whose dates only
 * make sense month first is read month first. Otherwise dates are read day first.
 */
export function dateOrder(values: unknown[]): { order: "dmy" | "mdy"; swapDates: boolean; unsure: boolean } {
  const texts = values.map((v) => (v instanceof Date ? null : NUMERIC.exec(clean(v)))).filter((m): m is RegExpExecArray => !!m);
  const dayFirst = texts.filter((m) => Number(m[1]) > 12), monthFirst = texts.filter((m) => Number(m[2]) > 12);
  const ambiguous = texts.filter((m) => Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2]);
  const hasDates = values.some((v) => v instanceof Date);
  if (dayFirst.length && monthFirst.length) return { order: "dmy", swapDates: false, unsure: true };
  if (monthFirst.length) return { order: "mdy", swapDates: false, unsure: false };
  if (dayFirst.length && hasDates) return { order: "dmy", swapDates: true, unsure: false };
  // A CSV saved by Excel set to US dates: typed dates kept as "15/03/2020", switched ones written as "2/3/2015".
  const padded = (m: RegExpExecArray) => m[1].length === 2 && m[2].length === 2;
  if (dayFirst.length && dayFirst.every(padded) && ambiguous.length && ambiguous.every((m) => !padded(m) && m[3].length === 4)) return { order: "mdy", swapDates: false, unsure: false };
  return { order: "dmy", swapDates: false, unsure: false };
}

/** A spreadsheet date with its day and month switched back (only possible when the day is 12 or less). */
const switchBack = (d: Date) => d.getUTCDate() <= 12 ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCDate() - 1, d.getUTCMonth() + 1)) : d;

/** "Confirmed", "Yes" or "True" is confirmed; "Not confirmed", "No", "Unconfirmed", "Probation" or "False" is not. */
export function readConfirmed(v: unknown): boolean | null {
  const s = clean(v).toLowerCase();
  if (["confirmed", "yes", "y", "true", "1"].includes(s)) return true;
  if (["not confirmed", "unconfirmed", "no", "n", "false", "0", "probation", "not-confirmed"].includes(s)) return false;
  return null;
}

const HEADERS: [keyof StaffRecordInput, RegExp][] = [
  ["employeeCode", /employee\s*code|staff\s*(no|number|code)|^code$/i],
  ["payGrade", /grade/i],
  ["employmentDate", /employ\w*\s*date|date\s*(of\s*)?employ|date\s*employed|start\s*date/i],
  ["confirmed", /confirm|status/i],
  ["email", /e-?mail/i],
];

/** Rows of cells to records. The first row must name the columns; their order does not matter. */
export function readRows(cells: unknown[][]): { rows: ParsedRow[]; skipped: Skipped[]; monthFirst: boolean } {
  const headerAt = cells.findIndex((r) => r.some((c) => HEADERS[0][1].test(clean(c))));
  if (headerAt < 0) throw new DomainError("The first row must name the columns: Employee code, Pay grade, Employment date, Confirmation (and Email, optional).");
  const head = cells[headerAt].map(clean);
  const col = Object.fromEntries(HEADERS.map(([k, re]) => [k, head.findIndex((h) => re.test(h))])) as Record<keyof StaffRecordInput, number>;
  const missing = (["employeeCode", "payGrade", "employmentDate", "confirmed"] as const).filter((k) => col[k] < 0);
  if (missing.length) throw new DomainError(`Columns not found: ${missing.map((k) => ({ employeeCode: "Employee code", payGrade: "Pay grade", employmentDate: "Employment date", confirmed: "Confirmation" })[k]).join(", ")}.`);
  const rows: ParsedRow[] = [];
  const skipped: Skipped[] = [];
  const body = cells.slice(headerAt + 1);
  const dates = dateOrder(body.map((r) => r[col.employmentDate]));
  body.forEach((r, i) => {
    const row = headerAt + i + 2;
    const get = (k: keyof StaffRecordInput) => (col[k] >= 0 ? r[col[k]] : undefined);
    const employeeCode = clean(get("employeeCode"));
    if (!r.some((c) => clean(c))) return; // blank line
    const payGrade = clean(get("payGrade"));
    const rawDate = get("employmentDate");
    const numeric = rawDate instanceof Date ? null : NUMERIC.exec(clean(rawDate));
    if (dates.unsure && numeric && Number(numeric[1]) <= 12 && Number(numeric[2]) <= 12 && numeric[1] !== numeric[2]) {
      skipped.push({ row, reason: "employment date could be day or month first; write it as 02 Mar 2015" });
      return;
    }
    const employmentDate = readDate(rawDate instanceof Date && dates.swapDates ? switchBack(rawDate) : rawDate, dates.order);
    const confirmed = readConfirmed(get("confirmed"));
    const email = clean(get("email")).toLowerCase() || null;
    const reason = !employeeCode ? "no employee code" : employeeCode.length > 40 ? "employee code too long"
      : !payGrade ? "no pay grade" : payGrade.length > 120 ? "pay grade too long"
      : !employmentDate ? "employment date not read (use DD/MM/YYYY)" : employmentDate > new Date().toISOString().slice(0, 10) ? "employment date in the future"
      : confirmed === null ? "confirmation not read (use Confirmed or Not confirmed)"
      : email && !isInstitutionalEmail(email) ? "email is not a work email" : null;
    if (reason) skipped.push({ row, reason });
    else rows.push({ row, employeeCode, payGrade, employmentDate: employmentDate!, confirmed: confirmed!, email });
  });
  return { rows, skipped, monthFirst: dates.order === "mdy" || dates.swapDates };
}

/** Reads an Excel (.xlsx) or CSV file into rows of cells. */
export async function readSheet(buffer: Buffer, fileName: string): Promise<unknown[][]> {
  const isXlsx = buffer.subarray(0, 2).toString("latin1") === "PK";
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new DomainError("The spreadsheet could not be opened. Save it as Excel (.xlsx) or CSV and try again.");
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new DomainError("The spreadsheet has no sheets.");
    const out: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals: unknown[] = [];
      for (let c = 1; c <= r.cellCount; c++) {
        const v = r.getCell(c).value as unknown;
        vals.push(v && typeof v === "object" && !(v instanceof Date) ? ("text" in v ? (v as { text: unknown }).text : "result" in v ? (v as { result: unknown }).result : "richText" in v ? (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("") : String(v)) : v);
      }
      out.push(vals);
    });
    return out;
  }
  if (!/\.(csv|txt)$/i.test(fileName) && buffer.includes(0)) throw new DomainError("Upload the register as Excel (.xlsx) or CSV.");
  return parseCsv(buffer.toString("utf8").replace(/^﻿/, ""));
}

/** CSV with quoted fields; commas, semicolons or tabs. */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/)[0] ?? "";
  const sep = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

type Record_ = typeof staffRecords.$inferSelect;

/** The user a record belongs to: whoever has that employee code, else whoever has that work email. */
async function ownerOf(tx: Executor, rec: Pick<Record_, "employeeCode" | "email">) {
  const [byCode] = await tx.select({ id: staffProfiles.userId }).from(staffProfiles).where(sql`lower(${staffProfiles.staffNumber}) = ${rec.employeeCode.toLowerCase()}`);
  if (byCode) return byCode.id;
  if (!rec.email) return null;
  const [byEmail] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${rec.email.toLowerCase()}`);
  return byEmail?.id ?? null;
}

/**
 * Fills a staff member's profile from their record: employee code, pay grade, employment date and status.
 * "Not confirmed" records probation unless Human Resources has already recorded another status (such as
 * contract). The details count as confirmed, since they come from the record. Returns false when the code is
 * already held by someone else.
 */
async function fill(tx: Executor, userId: string, rec: Record_): Promise<boolean> {
  const [clash] = await tx.select({ id: staffProfiles.userId }).from(staffProfiles)
    .where(and(sql`lower(${staffProfiles.staffNumber}) = ${rec.employeeCode.toLowerCase()}`, ne(staffProfiles.userId, userId)));
  if (clash) return false;
  const [p] = await tx.select().from(staffProfiles).where(eq(staffProfiles.userId, userId));
  const current = p?.employmentStatus ?? null;
  const employmentStatus = rec.confirmed ? "confirmed" as const : !current || current === "confirmed" ? "probation" as const : current;
  const now = new Date();
  const patch = {
    staffNumber: rec.employeeCode, payGrade: rec.payGrade, employmentDate: rec.employmentDate, employmentStatus,
    payslipDetailsConfirmedAt: now, payslipDetailsConfirmedBy: rec.updatedBy, updatedAt: now,
  };
  const same = p && p.staffNumber === patch.staffNumber && p.payGrade === patch.payGrade && p.employmentDate === patch.employmentDate && p.employmentStatus === employmentStatus;
  if (same) return true;
  await tx.insert(staffProfiles).values({ userId, ...patch }).onConflictDoUpdate({ target: staffProfiles.userId, set: patch });
  return true;
}

/**
 * When Human Resources changes someone's employee code, pay grade, employment date or confirmation, the
 * Register follows, so the latest change from either Human Resources or the administrator is what holds.
 */
export async function syncRegisterFromProfile(tx: Executor, actorId: string, userId: string, before?: { staffNumber: string | null } | null) {
  const [u] = await tx.select({ email: users.email, p: staffProfiles }).from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(eq(users.id, userId));
  const p = u?.p;
  if (!u || !p?.staffNumber) return;
  const codes = [p.staffNumber, before?.staffNumber].filter((c): c is string => !!c).map((c) => c.toLowerCase());
  const [rec] = await tx.select().from(staffRecords).where(or(
    sql`lower(${staffRecords.employeeCode}) in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`,
    sql`lower(${staffRecords.email}) = ${u.email.toLowerCase()}`,
  )).limit(1);
  if (!rec) return;
  const next = {
    employeeCode: p.staffNumber, payGrade: p.payGrade ?? rec.payGrade, employmentDate: p.employmentDate ?? rec.employmentDate,
    confirmed: p.employmentStatus ? p.employmentStatus === "confirmed" : rec.confirmed,
  };
  if (next.employeeCode === rec.employeeCode && next.payGrade === rec.payGrade && next.employmentDate === rec.employmentDate && next.confirmed === rec.confirmed) return;
  const [clash] = await tx.select({ id: staffRecords.id }).from(staffRecords).where(and(sql`lower(${staffRecords.employeeCode}) = ${next.employeeCode.toLowerCase()}`, ne(staffRecords.id, rec.id)));
  if (clash) return;
  await tx.update(staffRecords).set({ ...next, updatedBy: actorId, updatedAt: new Date() }).where(eq(staffRecords.id, rec.id));
}

/**
 * At sign-in: fills the profile from the person's record, if there is one, unless Human Resources has changed
 * the profile since the record was last changed (the latest change holds).
 */
export async function applyStaffRecordTo(tx: Executor, userId: string) {
  const [u] = await tx.select({ email: users.email, code: staffProfiles.staffNumber }).from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(eq(users.id, userId));
  if (!u) return;
  const [rec] = await tx.select().from(staffRecords).where(or(
    u.code ? sql`lower(${staffRecords.employeeCode}) = ${u.code.toLowerCase()}` : sql`false`,
    sql`lower(${staffRecords.email}) = ${u.email.toLowerCase()}`,
  )).orderBy(sql`case when lower(${staffRecords.employeeCode}) = ${(u.code ?? "").toLowerCase()} then 0 else 1 end`).limit(1);
  if (!rec) return;
  const [p] = await tx.select({ hrAt: staffProfiles.employmentVerifiedAt }).from(staffProfiles).where(eq(staffProfiles.userId, userId));
  if (p?.hrAt && p.hrAt > rec.updatedAt) return;
  await fill(tx, userId, rec);
}

async function upsert(tx: Executor, actor: Actor, input: StaffRecordInput): Promise<{ rec: Record_; added: boolean }> {
  const [existing] = await tx.select().from(staffRecords).where(sql`lower(${staffRecords.employeeCode}) = ${input.employeeCode.toLowerCase()}`);
  const values = { employeeCode: input.employeeCode, email: input.email ?? existing?.email ?? null, payGrade: input.payGrade, employmentDate: input.employmentDate, confirmed: input.confirmed, updatedBy: actor.userId, updatedAt: new Date() };
  const [rec] = existing
    ? await tx.update(staffRecords).set(values).where(eq(staffRecords.id, existing.id)).returning()
    : await tx.insert(staffRecords).values(values).returning();
  return { rec, added: !existing };
}

/** Saves the rows of an uploaded spreadsheet and fills the profiles of those who have signed in. */
export async function importStaffRecords(db: Executor, actor: Actor, file: { buffer: Buffer; name: string }) {
  assertCan(actor, "register.manage");
  const { rows, skipped, monthFirst } = readRows(await readSheet(file.buffer, file.name));
  if (!rows.length && !skipped.length) throw new DomainError("The file has no rows under its headings.");
  if (rows.length > 5000) throw new DomainError("Upload at most 5,000 rows at a time.");
  const seen = new Set<string>();
  let added = 0, updated = 0, linked = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const key = r.employeeCode.toLowerCase();
      if (seen.has(key)) { skipped.push({ row: r.row, reason: "employee code repeated in the file" }); continue; }
      seen.add(key);
      const { rec, added: isNew } = await upsert(tx, actor, r);
      if (isNew) added++; else updated++;
      const owner = await ownerOf(tx, rec);
      if (owner) {
        if (await fill(tx, owner, rec)) linked++;
        else skipped.push({ row: r.row, reason: "saved, but the employee code is already used by another person" });
      }
    }
    await audit(tx, actor, { action: "staff_records.imported", entityType: "staff_record", summary: `${added} added, ${updated} updated, ${linked} profiles filled, ${skipped.length} not read` });
  });
  skipped.sort((a, b) => a.row - b.row);
  return { added, updated, linked, skipped, monthFirst };
}

/** One record added or changed by the administrator. */
export async function saveStaffRecord(db: Executor, actor: Actor, input: StaffRecordInput & { id?: string }) {
  assertCan(actor, "register.manage");
  const employeeCode = clean(input.employeeCode), payGrade = clean(input.payGrade), email = clean(input.email).toLowerCase() || null;
  const employmentDate = readDate(input.employmentDate);
  if (!employeeCode || employeeCode.length > 40) throw new DomainError("Enter the employee code.");
  if (!payGrade || payGrade.length > 120) throw new DomainError("Enter the pay grade as printed on the payslip.");
  if (!employmentDate || !ISO.test(employmentDate)) throw new DomainError("Enter the employment date.");
  if (email && !isInstitutionalEmail(email)) throw new DomainError(`${email} is not a work email address.`);
  return db.transaction(async (tx) => {
    if (input.id) {
      const [clash] = await tx.select({ id: staffRecords.id }).from(staffRecords).where(and(sql`lower(${staffRecords.employeeCode}) = ${employeeCode.toLowerCase()}`, ne(staffRecords.id, input.id)));
      if (clash) throw new DomainError(`Another record already has the employee code ${employeeCode}.`);
      const [before] = await tx.select().from(staffRecords).where(eq(staffRecords.id, input.id));
      if (!before) throw new DomainError("This record no longer exists.");
      const [rec] = await tx.update(staffRecords).set({ employeeCode, email, payGrade, employmentDate, confirmed: input.confirmed, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(staffRecords.id, input.id)).returning();
      const owner = await ownerOf(tx, rec) ?? await ownerOf(tx, before);
      const filled = owner ? await fill(tx, owner, rec) : true;
      await audit(tx, actor, { action: "staff_record.updated", entityType: "staff_record", entityId: rec.id, before, after: rec, summary: `Staff record ${employeeCode} updated` });
      if (!filled) throw new DomainError(`Saved, but the employee code ${employeeCode} is already used by another person's profile.`);
      return rec;
    }
    const { rec } = await upsert(tx, actor, { employeeCode, email, payGrade, employmentDate, confirmed: input.confirmed });
    const owner = await ownerOf(tx, rec);
    if (owner) await fill(tx, owner, rec);
    await audit(tx, actor, { action: "staff_record.saved", entityType: "staff_record", entityId: rec.id, after: rec, summary: `Staff record ${employeeCode} saved` });
    return rec;
  });
}

export async function deleteStaffRecord(db: Executor, actor: Actor, id: string) {
  assertCan(actor, "register.manage");
  const [rec] = await db.delete(staffRecords).where(eq(staffRecords.id, id)).returning();
  if (!rec) throw new DomainError("This record no longer exists.");
  await audit(db, actor, { action: "staff_record.deleted", entityType: "staff_record", entityId: id, before: rec, summary: `Staff record ${rec.employeeCode} removed` });
}

/** Every record, with the person it belongs to once they have signed in. */
export async function listStaffRecords(db: Executor, actor: Actor) {
  assertCan(actor, "register.view");
  const rows = await db.select().from(staffRecords).orderBy(asc(staffRecords.employeeCode));
  const people = await db.select({ id: users.id, name: users.displayName, email: users.email, code: staffProfiles.staffNumber }).from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id));
  const byCode = new Map(people.filter((p) => p.code).map((p) => [p.code!.toLowerCase(), p]));
  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]));
  return rows.map((r) => ({ ...r, person: byCode.get(r.employeeCode.toLowerCase()) ?? (r.email ? byEmail.get(r.email.toLowerCase()) : undefined) ?? null }));
}
