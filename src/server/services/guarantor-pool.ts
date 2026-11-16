import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { guarantorPool } from "@/db/schema";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError, NotFoundError } from "../errors";
import { isInstitutionalEmail } from "./identity";

/**
 * The staff who may stand as guarantors (the managerial cadre). An administrator keeps the list; applicants
 * choose by name, and the email is used only to send the request to the guarantor.
 */

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export async function listGuarantorPool(db: Executor) {
  return db.select().from(guarantorPool).orderBy(asc(guarantorPool.name));
}

/** The names an applicant may choose from: active entries, without the applicant. No emails. */
export async function guarantorChoices(db: Executor, applicantEmail: string) {
  const rows = await db.select({ id: guarantorPool.id, name: guarantorPool.name, email: guarantorPool.email }).from(guarantorPool)
    .where(eq(guarantorPool.isActive, true)).orderBy(asc(guarantorPool.name));
  return rows.filter((r) => r.email.toLowerCase() !== applicantEmail.toLowerCase()).map((r) => ({ id: r.id, name: r.name }));
}

/** Whether an administrator has set up the list yet. Until then, guarantors are not limited to it. */
export async function guarantorPoolInUse(db: Executor) {
  const [row] = await db.select({ id: guarantorPool.id }).from(guarantorPool).where(eq(guarantorPool.isActive, true)).limit(1);
  return !!row;
}

/** The emails behind the names chosen, in the order chosen. */
export async function guarantorEmailsFor(db: Executor, ids: string[]) {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return [];
  if (wanted.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new DomainError("Choose your guarantors from the list.");
  const rows = await db.select().from(guarantorPool).where(and(inArray(guarantorPool.id, wanted), eq(guarantorPool.isActive, true)));
  return wanted.map((id) => {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new DomainError("One of the guarantors chosen is no longer on the list. Please choose again.");
    return r.email.toLowerCase();
  });
}

/** Pool entries for these emails, so screens can show the guarantor's name and the form can show the choice. */
export async function guarantorsByEmail(db: Executor, emails: string[]) {
  const list = emails.map((e) => e.toLowerCase());
  if (!list.length) return new Map<string, { id: string; name: string; isActive: boolean }>();
  const rows = await db.select().from(guarantorPool).where(inArray(sql`lower(${guarantorPool.email})`, list));
  return new Map(rows.map((r) => [r.email.toLowerCase(), { id: r.id, name: r.name, isActive: r.isActive }]));
}

/** Throws unless every email is an active entry on the list (when the list is in use). */
export async function assertOnGuarantorList(db: Executor, emails: string[]) {
  if (!emails.length || !(await guarantorPoolInUse(db))) return;
  const found = await guarantorsByEmail(db, emails);
  for (const e of emails) {
    if (!found.get(e.toLowerCase())?.isActive) throw new DomainError("Guarantors must be chosen from the list of eligible guarantors. Please choose again.");
  }
}

export interface GuarantorEntry { id?: string; name: string; email: string; cadre?: string; isActive?: boolean }

export async function saveGuarantorEntry(db: Executor, actor: Actor, input: GuarantorEntry) {
  assertCan(actor, "admin.policy.manage");
  const name = clean(input.name);
  const email = input.email.trim().toLowerCase();
  const cadre = clean(input.cadre ?? "") || "Managerial";
  if (name.length < 3) throw new DomainError("Enter the guarantor's full name.");
  if (!isInstitutionalEmail(email)) throw new DomainError(`${email || "The email"} is not a work email address.`);
  return db.transaction(async (tx) => {
    const [clash] = await tx.select({ id: guarantorPool.id }).from(guarantorPool).where(sql`lower(${guarantorPool.email}) = ${email}`);
    if (clash && clash.id !== input.id) throw new DomainError(`${email} is already on the list.`);
    const values = { name, email, cadre, isActive: input.isActive ?? true, updatedAt: new Date() };
    const [row] = input.id
      ? await tx.update(guarantorPool).set(values).where(eq(guarantorPool.id, input.id)).returning()
      : await tx.insert(guarantorPool).values({ ...values, createdBy: actor.userId }).returning();
    if (!row) throw new NotFoundError("Guarantor");
    await audit(tx, actor, { action: input.id ? "guarantor_pool.updated" : "guarantor_pool.added", entityType: "guarantor_pool", entityId: row.id, summary: `${name} (${cadre})${values.isActive ? "" : ", not available"}` });
    return row;
  });
}

export async function removeGuarantorEntry(db: Executor, actor: Actor, id: string) {
  assertCan(actor, "admin.policy.manage");
  const [row] = await db.delete(guarantorPool).where(eq(guarantorPool.id, id)).returning();
  if (!row) throw new NotFoundError("Guarantor");
  await audit(db, actor, { action: "guarantor_pool.removed", entityType: "guarantor_pool", entityId: id, summary: row.name });
}

/**
 * Adds or updates many entries at once, one per line: "Full name, email" (a tab or semicolon also works).
 * An email already on the list has its name updated. Lines that cannot be read are reported back.
 */
export async function importGuarantors(db: Executor, actor: Actor, text: string, cadre = "Managerial") {
  assertCan(actor, "admin.policy.manage");
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new DomainError("Paste at least one line: full name, then email.");
  if (lines.length > 1000) throw new DomainError("Add at most 1,000 names at a time.");
  let added = 0, updated = 0;
  const skipped: string[] = [];
  await db.transaction(async (tx) => {
    for (const line of lines) {
      if (/^(full\s+)?name\b/i.test(line) && /e-?mail/i.test(line)) continue; // a header row
      const email = line.match(/[^\s,;<>\t]+@[^\s,;<>\t]+/)?.[0]?.toLowerCase();
      const name = clean(line.replace(/[^\s,;<>\t]+@[^\s,;<>\t]+/, "").replace(/[,;<>\t]/g, " "));
      if (!email || name.length < 3 || !isInstitutionalEmail(email)) { skipped.push(line); continue; }
      const [existing] = await tx.select({ id: guarantorPool.id }).from(guarantorPool).where(sql`lower(${guarantorPool.email}) = ${email}`);
      if (existing) {
        await tx.update(guarantorPool).set({ name, cadre, isActive: true, updatedAt: new Date() }).where(eq(guarantorPool.id, existing.id));
        updated++;
      } else {
        await tx.insert(guarantorPool).values({ name, email, cadre, createdBy: actor.userId });
        added++;
      }
    }
    await audit(tx, actor, { action: "guarantor_pool.imported", entityType: "guarantor_pool", summary: `${added} added, ${updated} updated, ${skipped.length} not read` });
  });
  return { added, updated, skipped };
}
