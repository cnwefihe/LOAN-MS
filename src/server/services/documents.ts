import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { documents, documentAccessLogs, loanApplications, applicationGuarantors, loanAccounts } from "@/db/schema";
import { sha256Hex, randomToken } from "@/lib/security/crypto";
import { storage } from "../storage";
import { getSetting } from "../settings";
import { audit } from "../audit";
import { can, type Actor } from "../actor";
import { DomainError, ForbiddenError } from "../errors";
import { departmentHeadOf } from "./staff";

export const DOCUMENT_CATEGORIES = {
  applicant_supporting: "Applicant supporting document",
  guarantor_supporting: "Guarantor supporting document",
  hr_verification: "Human Resources verification document",
  approval: "Approval document",
  loan_agreement: "Loan agreement",
  guarantor_agreement: "Guarantor agreement",
  disbursement_evidence: "Disbursement evidence",
  repayment_evidence: "Repayment evidence",
  restructuring: "Restructuring document",
  statement: "Statement / confirmation",
} as const;
export type DocumentCategory = keyof typeof DOCUMENT_CATEGORIES;

/** Categories never shown to applicants or guarantors (internal due diligence). */
const INTERNAL: DocumentCategory[] = ["hr_verification", "approval"];

const SIGNATURES: { mime: string; ext: string[]; test: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: [".pdf"], test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: [".png"], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: [".jpg", ".jpeg"], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

export async function validateUpload(db: Executor, file: File): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) throw new DomainError("Please choose a file to upload.");
  const maxMb = await getSetting(db, "documents.maxUploadMb");
  if (file.size > maxMb * 1024 * 1024) throw new DomainError(`Files must be ${maxMb} MB or smaller.`);
  const fileName = file.name.replace(/[^\w.\- ()]/g, "_").slice(0, 200) || "document";
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  const buffer = Buffer.from(await file.arrayBuffer());
  // Trust file content, not the browser-supplied type or extension.
  const sig = SIGNATURES.find((s) => s.test(buffer));
  if (!sig || !sig.ext.includes(ext)) throw new DomainError("Only PDF, PNG and JPEG files are accepted, and the file extension must match its content.");
  return { buffer, mime: sig.mime, fileName };
}

export interface StoreInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  category: DocumentCategory;
  title: string;
  ownerUserId?: string | null;
  applicationId?: string | null;
  loanAccountId?: string | null;
  applicationGuarantorId?: string | null;
  requirementCode?: string | null;
  isSystemGenerated?: boolean;
}

/** Store a new document (or a new version of an existing requirement slot). */
export async function storeDocument(db: Executor, actor: Actor, input: StoreInput) {
  let version = 1;
  let supersedesId: string | null = null;
  if (input.requirementCode && (input.applicationId || input.loanAccountId)) {
    const [prev] = await db.select().from(documents).where(and(
      eq(documents.requirementCode, input.requirementCode),
      input.applicationId ? eq(documents.applicationId, input.applicationId) : eq(documents.loanAccountId, input.loanAccountId!),
      input.applicationGuarantorId ? eq(documents.applicationGuarantorId, input.applicationGuarantorId) : sql`true`,
    )).orderBy(desc(documents.version)).limit(1);
    if (prev) { version = prev.version + 1; supersedesId = prev.id; }
  }
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomToken(18).replace(/[^a-z0-9_-]/gi, "")}`;
  await storage().put(key, input.buffer);
  const [doc] = await db.insert(documents).values({
    category: input.category, title: input.title, fileName: input.fileName, mimeType: input.mimeType,
    sizeBytes: input.buffer.length, sha256: sha256Hex(input.buffer), storageKey: key,
    ownerUserId: input.ownerUserId ?? null, applicationId: input.applicationId ?? null, loanAccountId: input.loanAccountId ?? null,
    applicationGuarantorId: input.applicationGuarantorId ?? null, requirementCode: input.requirementCode ?? null,
    version, supersedesId, isSystemGenerated: input.isSystemGenerated ?? false, uploadedBy: actor.userId,
  }).returning();
  await db.insert(documentAccessLogs).values({ documentId: doc.id, userId: actor.userId, action: "upload", ipAddress: actor.ip ?? null });
  await audit(db, actor, { action: "document.stored", entityType: "document", entityId: doc.id, summary: `${input.title} (v${version})`, after: { category: input.category, sha256: doc.sha256, applicationId: doc.applicationId, loanAccountId: doc.loanAccountId } });
  return doc;
}

export async function canAccessDocument(db: Executor, actor: Actor, doc: typeof documents.$inferSelect): Promise<boolean> {
  if (can(actor, "documents.view_all")) return true;
  if (doc.uploadedBy === actor.userId || doc.ownerUserId === actor.userId) return !INTERNAL.includes(doc.category as DocumentCategory) || doc.uploadedBy === actor.userId;
  if (INTERNAL.includes(doc.category as DocumentCategory)) return false;

  let applicationId = doc.applicationId;
  if (doc.loanAccountId) {
    const [loan] = await db.select({ borrowerId: loanAccounts.borrowerId, applicationId: loanAccounts.applicationId }).from(loanAccounts).where(eq(loanAccounts.id, doc.loanAccountId));
    if (loan?.borrowerId === actor.userId) return true;
    applicationId ??= loan?.applicationId ?? null;
  }
  if (!applicationId) return false;
  const [app] = await db.select({ applicantId: loanApplications.applicantId }).from(loanApplications).where(eq(loanApplications.id, applicationId));
  if (app?.applicantId === actor.userId) return true;
  // The applicant's Line Manager sees what other approvers see.
  if (app && (await departmentHeadOf(db, app.applicantId))?.headUserId === actor.userId) return true;

  // Guarantors may see the applicant's supporting documents and the loan agreement; guarantor documents only if their own.
  const [g] = await db.select({ id: applicationGuarantors.id }).from(applicationGuarantors).where(and(
    eq(applicationGuarantors.applicationId, applicationId), eq(applicationGuarantors.guarantorId, actor.userId),
    inArray(applicationGuarantors.status, ["pending", "accepted", "clarification_requested"]),
  ));
  if (!g) return false;
  if (doc.category === "applicant_supporting" || doc.category === "loan_agreement") return true;
  if (doc.category === "guarantor_agreement" || doc.category === "guarantor_supporting") return doc.applicationGuarantorId === g.id;
  return false;
}

export async function readDocument(db: Executor, actor: Actor, documentId: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) throw new DomainError("Document not found.");
  if (!(await canAccessDocument(db, actor, doc))) {
    await db.insert(documentAccessLogs).values({ documentId: doc.id, userId: actor.userId, action: "denied", ipAddress: actor.ip ?? null });
    throw new ForbiddenError("You do not have access to this document.");
  }
  const data = await storage().get(doc.storageKey);
  if (sha256Hex(data) !== doc.sha256) throw new DomainError("Document integrity check failed. Contact support.");
  await db.insert(documentAccessLogs).values({ documentId: doc.id, userId: actor.userId, action: "download", ipAddress: actor.ip ?? null });
  return { doc, data };
}

/** Latest version per (requirement slot) for an application or loan, filtered for the viewer. */
export async function listDocumentsFor(db: Executor, actor: Actor, scope: { applicationId?: string; loanAccountId?: string }) {
  const conds = [];
  if (scope.applicationId) conds.push(eq(documents.applicationId, scope.applicationId));
  if (scope.loanAccountId) conds.push(eq(documents.loanAccountId, scope.loanAccountId));
  if (!conds.length) return [];
  const rows = await db.select().from(documents).where(or(...conds)).orderBy(desc(documents.createdAt));
  const supersededIds = new Set(rows.filter((r) => r.supersedesId).map((r) => r.supersedesId));
  const visible = [];
  for (const r of rows) if (await canAccessDocument(db, actor, r)) visible.push({ ...r, isLatest: !supersededIds.has(r.id) });
  return visible;
}

export async function documentsWithRequirement(db: Executor, applicationId: string) {
  return db.select({ code: documents.requirementCode }).from(documents).where(and(eq(documents.applicationId, applicationId), isNotNull(documents.requirementCode)));
}
