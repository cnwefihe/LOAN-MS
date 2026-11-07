"use server";

import { getDb } from "@/db";
import { runAction, str, bool, file, money } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { DomainError } from "@/server/errors";
import { respondToGuarantee, getGuaranteeForGuarantor } from "@/server/services/guarantors";
import { validateUpload, storeDocument } from "@/server/services/documents";

type Prev = ActionResult | null;

export async function respondGuaranteeAction(guaranteeId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const decision = str(fd, "decision");
    if (decision === "accept") {
      const r = await respondToGuarantee(db, actor, guaranteeId, { decision: "accept", typedName: str(fd, "typedName"), confirmations: [bool(fd, "c1"), bool(fd, "c2"), bool(fd, "c3")], relationship: str(fd, "relationship"), phone: str(fd, "phone") });
      return { message: r === "accepted" ? "Thank you. Your acceptance has been recorded." : "", redirectTo: "/guarantor" };
    }
    if (decision === "decline") {
      await respondToGuarantee(db, actor, guaranteeId, { decision: "decline", reason: str(fd, "reason") });
      return { message: "You have declined this request.", redirectTo: "/guarantor" };
    }
    if (decision === "clarify") {
      await respondToGuarantee(db, actor, guaranteeId, { decision: "clarify", question: str(fd, "question") });
      return "Your question has been sent to the applicant.";
    }
    throw new DomainError("Choose a response.");
  }, { revalidate: ["/guarantor"] });
}

export async function uploadGuarantorDocumentAction(guaranteeId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const g = await getGuaranteeForGuarantor(db, actor, guaranteeId);
    const f = file(fd, "file");
    if (!f) throw new DomainError("Choose a file to upload.");
    const v = await validateUpload(db, f);
    await db.transaction((tx) => storeDocument(tx, actor, { buffer: v.buffer, fileName: v.fileName, mimeType: v.mime, category: "guarantor_supporting", title: str(fd, "title") || v.fileName, ownerUserId: actor.userId, applicationId: g.applicationId, applicationGuarantorId: g.id }));
    return "Document uploaded.";
  }, { revalidate: [`/guarantor/requests/${guaranteeId}`], limit: 20 });
}
