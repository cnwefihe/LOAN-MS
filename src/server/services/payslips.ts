/**
 * Payslips uploaded by staff. Each upload is read, checked against the staff record (name, employee code
 * and pay grade) and kept with its reading; the latest one is what eligibility is worked out from.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "@/db";
import { documents, staffPayslips } from "@/db/schema";
import { readPayslipPdf, PayslipReadError } from "@/lib/finance/payslip-reader";
import { renderPayslipPdf } from "@/lib/finance/payslip-pdf";
import { payslipMismatches, type Payslip } from "@/lib/finance/payslip";
import type { Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";
import { storeDocument, validateUpload } from "./documents";
import { storage } from "../storage";
import { getStaffRecord, payslipIdentity } from "./staff";

export type StoredPayslip = typeof staffPayslips.$inferSelect;

/** Read and check an uploaded payslip, then keep it as the staff member's latest. */
export async function uploadPayslip(db: Executor, actor: Actor, file: File): Promise<StoredPayslip> {
  const { buffer, mime, fileName } = await validateUpload(db, file);
  if (mime !== "application/pdf") throw new DomainError("Please upload your payslip as a PDF.");
  let slip: Payslip;
  try {
    slip = await readPayslipPdf(new Uint8Array(buffer));
  } catch (err) {
    if (err instanceof PayslipReadError) throw new DomainError(err.message);
    throw err;
  }
  const rec = await getStaffRecord(db, actor.userId);
  const mismatches = payslipMismatches(slip.employee, payslipIdentity(rec));
  if (mismatches.length) throw new DomainError(`This payslip does not match your profile. ${mismatches.join(" ")} Update your payslip details on My profile so they read exactly as on the payslip, then upload it again.`);

  return db.transaction(async (tx) => {
    const doc = await storeDocument(tx, actor, {
      buffer, fileName, mimeType: mime, category: "applicant_supporting", title: `Payslip${slip.period ? ` ${slip.period}` : ""}`, ownerUserId: actor.userId,
    });
    const [row] = await tx.insert(staffPayslips).values({ userId: actor.userId, documentId: doc.id, period: slip.period, data: slip }).returning();
    await audit(tx, actor, { action: "payslip.uploaded", entityType: "staff_payslip", entityId: row.id, summary: `Payslip ${slip.period ?? ""} read` });
    return row;
  });
}

/** Keep a payslip drawn from given figures (development seed and tests only; uploads go through uploadPayslip). */
export async function recordSamplePayslip(db: Executor, actor: Actor, userId: string, slip: Payslip): Promise<StoredPayslip> {
  const buffer = Buffer.from(await renderPayslipPdf(slip));
  const doc = await storeDocument(db, actor, { buffer, fileName: `payslip-${slip.period ?? "sample"}.pdf`, mimeType: "application/pdf", category: "applicant_supporting", title: `Payslip ${slip.period ?? ""}`.trim(), ownerUserId: userId });
  const [row] = await db.insert(staffPayslips).values({ userId, documentId: doc.id, period: slip.period, data: slip }).returning();
  return row;
}

export async function latestPayslip(db: Executor, userId: string): Promise<StoredPayslip | null> {
  const [row] = await db.select().from(staffPayslips).where(eq(staffPayslips.userId, userId)).orderBy(desc(staffPayslips.createdAt)).limit(1);
  return row ?? null;
}

/**
 * File a copy of the payslip with an application (as its PAYSLIP document) so everyone reviewing the
 * application sees the payslip it was assessed on. Nothing is added when that file is already there.
 */
export async function attachPayslip(db: Executor, actor: Actor, applicationId: string, payslipId: string) {
  const slip = await getPayslip(db, payslipId);
  if (!slip) return;
  const [source] = await db.select().from(documents).where(eq(documents.id, slip.documentId));
  const [latest] = await db.select({ sha256: documents.sha256 }).from(documents)
    .where(and(eq(documents.applicationId, applicationId), eq(documents.requirementCode, "PAYSLIP"))).orderBy(desc(documents.version)).limit(1);
  if (!source || latest?.sha256 === source.sha256) return;
  await storeDocument(db, actor, {
    buffer: await storage().get(source.storageKey), fileName: source.fileName, mimeType: source.mimeType, category: "applicant_supporting",
    title: source.title, ownerUserId: slip.userId, applicationId, requirementCode: "PAYSLIP",
  });
}

/**
 * Files a copy of the guarantor's payslip with the application, so Human Resources and the Bursary can open
 * it beside the applicant's. Only the guarantor and staff who see all documents may open it.
 */
export async function attachGuarantorPayslip(db: Executor, actor: Actor, applicationId: string, applicationGuarantorId: string, payslipId: string) {
  const slip = await getPayslip(db, payslipId);
  if (!slip) return;
  const [source] = await db.select().from(documents).where(eq(documents.id, slip.documentId));
  const [latest] = await db.select({ sha256: documents.sha256 }).from(documents)
    .where(and(eq(documents.applicationGuarantorId, applicationGuarantorId), eq(documents.requirementCode, "GUARANTOR_PAYSLIP"))).orderBy(desc(documents.version)).limit(1);
  if (!source || latest?.sha256 === source.sha256) return;
  await storeDocument(db, actor, {
    buffer: await storage().get(source.storageKey), fileName: source.fileName, mimeType: source.mimeType, category: "guarantor_supporting",
    title: `Guarantor's ${source.title.charAt(0).toLowerCase()}${source.title.slice(1)}`, ownerUserId: slip.userId, applicationId, applicationGuarantorId, requirementCode: "GUARANTOR_PAYSLIP",
  });
}

export async function getPayslip(db: Executor, id: string | null | undefined): Promise<StoredPayslip | null> {
  if (!id) return null;
  const [row] = await db.select().from(staffPayslips).where(eq(staffPayslips.id, id));
  return row ?? null;
}
