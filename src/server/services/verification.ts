import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Executor } from "@/db";
import { issuedDocuments, users, loanAccounts } from "@/db/schema";
import { sha256Hex } from "@/lib/security/crypto";
import { canAny, type Actor } from "../actor";
import { audit } from "../audit";
import { ForbiddenError } from "../errors";

export const canVerifyDocuments = (actor: Actor) => canAny(actor, "documents.view_all", "accounts.view", "admin.audit.view");

const subject = alias(users, "subject");
const issuer = alias(users, "issuer");

async function lookup(db: Executor, where: ReturnType<typeof eq>) {
  return db.select({
    reference: issuedDocuments.reference, kind: issuedDocuments.kind, title: issuedDocuments.title, sha256: issuedDocuments.sha256, issuedAt: issuedDocuments.createdAt,
    subjectName: subject.displayName, issuedByName: issuer.displayName, accountNumber: loanAccounts.accountNumber, loanAccountId: issuedDocuments.loanAccountId,
  }).from(issuedDocuments)
    .leftJoin(subject, eq(subject.id, issuedDocuments.subjectUserId))
    .leftJoin(issuer, eq(issuer.id, issuedDocuments.issuedBy))
    .leftJoin(loanAccounts, eq(loanAccounts.id, issuedDocuments.loanAccountId))
    .where(where).orderBy(desc(issuedDocuments.createdAt)).limit(5);
}

/** Checks a presented PDF against the register: identical bytes mean the document is genuine and unaltered. */
export async function verifyFile(db: Executor, actor: Actor, bytes: Buffer) {
  if (!canVerifyDocuments(actor)) throw new ForbiddenError();
  const sha = sha256Hex(bytes);
  const matches = await lookup(db, eq(issuedDocuments.sha256, sha));
  await audit(db, actor, { action: "document.verified", entityType: "issued_document", entityId: matches[0]?.reference ?? null, summary: matches.length ? `Genuine: ${matches[0].reference}` : `No match for sha256 ${sha.slice(0, 16)}` });
  return { sha, matches };
}

export async function findByReference(db: Executor, actor: Actor, reference: string) {
  if (!canVerifyDocuments(actor)) throw new ForbiddenError();
  return lookup(db, eq(issuedDocuments.reference, reference.trim().toUpperCase()));
}

export async function findBySha(db: Executor, actor: Actor, sha: string) {
  if (!canVerifyDocuments(actor)) throw new ForbiddenError();
  return /^[0-9a-f]{64}$/.test(sha) ? lookup(db, eq(issuedDocuments.sha256, sha)) : [];
}
