"use server";

import { and, eq, isNull, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { loanApplications, notifications } from "@/db/schema";
import { runAction, str, money, int, bool, file } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { DomainError, ForbiddenError, NotFoundError } from "@/server/errors";
import { saveDraft, submitApplication, cancelApplication, replaceGuarantor, postMessage } from "@/server/services/applications";
import { validateUpload, storeDocument } from "@/server/services/documents";
import { updateOwnProfile, updatePayslipDetails } from "@/server/services/staff";
import { submitRepaymentClaim, requestRestructure } from "@/server/services/loans";
import { uploadPayslip } from "@/server/services/payslips";
import { guarantorEmailsFor } from "@/server/services/guarantor-pool";

type Prev = ActionResult | null;

export async function saveApplicationAction(applicationId: string | null, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    // Eligibility is worked out from the latest payslip the applicant uploaded.
    const r = await saveDraft(db, actor, {
      applicationId: applicationId ?? undefined,
      productId: str(fd, "productId", true),
      requestedAmount: money(fd, "requestedAmount", "the loan amount"),
      tenorMonths: int(fd, "tenorMonths", "Tenor"),
      purpose: str(fd, "purpose"),
      guarantorEmails: [],
      guarantorIds: [str(fd, "guarantor1"), str(fd, "guarantor2")].filter(Boolean),
      contact: fd.has("phone") ? { phone: str(fd, "phone"), residentialAddress: str(fd, "residentialAddress") } : null,
      departmentId: str(fd, "departmentId") || null,
      advanceType: str(fd, "advanceType") || null,
    });
    return { redirectTo: `/applications/${r.id}`, message: "Draft saved." };
  }, { revalidate: ["/applications"] });
}

/** Upload a payslip: it is read, checked against the staff record and kept as the latest. */
export async function uploadPayslipAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const f = file(fd, "payslip");
    if (!f) throw new DomainError("Choose your payslip PDF.");
    const slip = await uploadPayslip(await getDb(), actor, f);
    // Back to the same page, marked as uploaded on this visit, so it is shown.
    const back = str(fd, "returnTo");
    if (!back.startsWith("/") || back.startsWith("//")) return { message: "Payslip read." };
    const url = new URL(back, "http://local");
    url.searchParams.set("slip", slip.id);
    return { redirectTo: url.pathname + url.search, message: "Payslip read." };
  }, { revalidate: ["/eligibility", "/applications", "/guarantor"] });
}

export async function uploadApplicationDocumentAction(applicationId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const [app] = await db.select().from(loanApplications).where(eq(loanApplications.id, applicationId));
    if (!app) throw new NotFoundError("Application");
    if (app.applicantId !== actor.userId) throw new ForbiddenError();
    if (!["draft", "returned", "pending_guarantor", "pending_hr"].includes(app.status)) throw new DomainError("Documents can no longer be added to this application.");
    const f = file(fd, "file");
    if (!f) throw new DomainError("Choose a file to upload.");
    const v = await validateUpload(db, f);
    const code = str(fd, "requirementCode") || null;
    await db.transaction((tx) => storeDocument(tx, actor, { buffer: v.buffer, fileName: v.fileName, mimeType: v.mime, category: "applicant_supporting", title: str(fd, "title") || code || v.fileName, ownerUserId: actor.userId, applicationId, requirementCode: code }));
    return "Document uploaded.";
  }, { revalidate: [`/applications/${applicationId}`], limit: 20 });
}

export async function submitApplicationAction(applicationId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await submitApplication(await getDb(), actor, applicationId, { termsAccepted: bool(fd, "termsAccepted") });
    return { message: "Application submitted.", redirectTo: `/applications/${applicationId}` };
  }, { revalidate: ["/applications", "/dashboard"] });
}

export async function cancelApplicationAction(applicationId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await cancelApplication(await getDb(), actor, applicationId, str(fd, "reason"));
    return "Application cancelled.";
  }, { revalidate: ["/applications"] });
}

export async function replaceGuarantorAction(guaranteeId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const [email] = await guarantorEmailsFor(db, [str(fd, "guarantorId", true)]);
    await replaceGuarantor(db, actor, guaranteeId, email);
    return "Replacement guarantor invited.";
  }, { revalidate: ["/applications"] });
}

export async function postMessageAction(applicationId: string, kind: "clarification" | "correction" | "internal", _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await postMessage(await getDb(), actor, applicationId, kind, str(fd, "body", true));
    return "Message sent.";
  }, { revalidate: [`/applications/${applicationId}`] });
}

export async function updateProfileAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const account = str(fd, "bankAccountNumber");
    await updateOwnProfile(await getDb(), actor, { phone: str(fd, "phone"), residentialAddress: str(fd, "residentialAddress"), bankName: str(fd, "bankName"), bankAccountName: str(fd, "bankAccountName"), bankAccountNumber: account || undefined });
    return "Profile updated.";
  }, { revalidate: ["/profile"] });
}

export async function submitClaimAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const f = file(fd, "evidence");
    const ev = f ? await validateUpload(db, f) : null;
    await submitRepaymentClaim(db, actor, loanId, {
      amount: money(fd, "amount", "the amount"), deductionMonth: str(fd, "deductionMonth", true), channel: str(fd, "channel") === "bank_transfer" ? "bank_transfer" : "payroll",
      payerReference: str(fd, "payerReference"), note: str(fd, "note"), evidence: ev ? { buffer: ev.buffer, fileName: ev.fileName, mimeType: ev.mime } : null,
    });
    return "Reported. Your balance will update once the Payroll Officer confirms the deduction.";
  }, { revalidate: [`/loans/${loanId}`], limit: 10 });
}

export async function requestRestructureAction(loanId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await requestRestructure(await getDb(), actor, loanId, { proposedTenorMonths: int(fd, "proposedTenorMonths", "Proposed tenor"), reason: str(fd, "reason") });
    return "Restructuring request sent to the Bursary.";
  }, { revalidate: [`/loans/${loanId}`] });
}

export async function markAllReadAction(_: Prev) {
  return runAction(async (actor) => {
    const db = await getDb();
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)));
    return "All notifications marked as read.";
  }, { revalidate: ["/notifications"] });
}

export async function markReadAction(ids: string[], _: Prev) {
  return runAction(async (actor) => {
    const db = await getDb();
    if (ids.length) await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, actor.userId), inArray(notifications.id, ids)));
  }, { revalidate: ["/notifications"] });
}

export async function updatePayslipDetailsAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const changed = await updatePayslipDetails(await getDb(), actor, { name: str(fd, "payslipName") });
    return changed ? "Saved." : "No changes.";
  }, { revalidate: ["/profile", "/eligibility"] });
}
