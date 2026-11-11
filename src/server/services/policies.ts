import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanProducts, policyVersions, termsDocuments, documentRequirements, loanApplications, loanAccounts } from "@/db/schema";
import { parsePolicy, policyParametersSchema, type PolicyParameters } from "@/lib/finance/policy";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { DomainError, NotFoundError } from "../errors";
import { DEFAULT_LOAN_POLICY_BODY, DEFAULT_LOAN_POLICY_TITLE } from "@/lib/loan-policy-default";

export async function getPolicyVersion(db: Executor, id: string) {
  const [row] = await db.select().from(policyVersions).where(eq(policyVersions.id, id));
  if (!row) throw new NotFoundError("Policy version");
  return { ...row, params: parsePolicy(row.parameters) };
}

export async function getActivePolicy(db: Executor, productId: string) {
  const [row] = await db.select().from(policyVersions).where(and(eq(policyVersions.productId, productId), eq(policyVersions.status, "active")));
  if (!row) return null;
  return { ...row, params: parsePolicy(row.parameters) };
}

/** Products open for applications: active product with an active policy version. */
export async function listOpenProducts(db: Executor) {
  const rows = await db
    .select({ product: loanProducts, policy: policyVersions })
    .from(loanProducts)
    .innerJoin(policyVersions, and(eq(policyVersions.productId, loanProducts.id), eq(policyVersions.status, "active")))
    .where(eq(loanProducts.isActive, true))
    .orderBy(loanProducts.name);
  // Everyday products first: Personal, Bereavement, Asset, Advance; any others alphabetically after.
  const rank = (code: string) => { const i = ["PERSONAL", "BEREAVEMENT", "ASSET", "ADVANCE"].indexOf(code); return i < 0 ? 99 : i; };
  return rows.sort((x, y) => rank(x.product.code) - rank(y.product.code))
    .map((r) => ({ ...r.product, policyVersionId: r.policy.id, policyVersion: r.policy.version, params: parsePolicy(r.policy.parameters) }));
}

/** Active applicant document requirements (global ones have productId null). */
export async function requiredDocsLabels(db: Executor) {
  return db.select({ productId: documentRequirements.productId, label: documentRequirements.label, code: documentRequirements.code })
    .from(documentRequirements)
    .where(and(eq(documentRequirements.isActive, true), eq(documentRequirements.isRequired, true), eq(documentRequirements.appliesTo, "applicant")));
}

export async function getActiveTerms(db: Executor, kind: "loan_terms" | "guarantor_agreement") {
  const [t] = await db.select().from(termsDocuments).where(and(eq(termsDocuments.kind, kind), eq(termsDocuments.isActive, true)));
  return t ?? null;
}

/** The loan policy staff read before applying: the version an administrator published, or the built-in wording. */
export async function getLoanPolicy(db: Executor) {
  const [t] = await db.select().from(termsDocuments).where(and(eq(termsDocuments.kind, "loan_policy"), eq(termsDocuments.isActive, true)));
  return { title: t?.title ?? DEFAULT_LOAN_POLICY_TITLE, body: t?.body ?? DEFAULT_LOAN_POLICY_BODY };
}

/* ───────────────────────── Administration ───────────────────────── */

export async function createProduct(db: Executor, actor: Actor, input: { code: string; name: string; description?: string }) {
  assertCan(actor, "admin.policy.manage");
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,30}$/.test(code)) throw new DomainError("Product code must be 2 to 30 characters: letters, digits, hyphens or underscores.");
  return db.transaction(async (tx) => {
    const [p] = await tx.insert(loanProducts).values({ code, name: input.name.trim(), description: input.description?.trim() || null, createdBy: actor.userId, isActive: false }).returning();
    await audit(tx, actor, { action: "product.created", entityType: "loan_product", entityId: p.id, after: p });
    return p;
  });
}

export async function setProductActive(db: Executor, actor: Actor, productId: string, isActive: boolean) {
  assertCan(actor, "admin.policy.manage");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(loanProducts).where(eq(loanProducts.id, productId));
    if (!before) throw new NotFoundError("Product");
    if (isActive && !(await getActivePolicy(tx, productId))) throw new DomainError("Save the loan terms before opening this product to applications.");
    await tx.update(loanProducts).set({ isActive, updatedAt: new Date() }).where(eq(loanProducts.id, productId));
    await audit(tx, actor, { action: isActive ? "product.activated" : "product.deactivated", entityType: "loan_product", entityId: productId, before: { isActive: before.isActive }, after: { isActive } });
  });
}

export async function updateProductDetails(db: Executor, actor: Actor, productId: string, input: { name: string; description: string }) {
  assertCan(actor, "admin.policy.manage");
  const name = input.name.trim();
  if (name.length < 3 || name.length > 150) throw new DomainError("Product name must be 3 to 150 characters.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(loanProducts).where(eq(loanProducts.id, productId));
    if (!before) throw new NotFoundError("Product");
    const after = { name, description: input.description.trim() || null };
    await tx.update(loanProducts).set({ ...after, updatedAt: new Date() }).where(eq(loanProducts.id, productId));
    await audit(tx, actor, { action: "product.updated", entityType: "loan_product", entityId: productId, before: { name: before.name, description: before.description }, after });
  });
}

/**
 * Delete a product that has never been used. Once any application has been made under it, the
 * product must stay for the record (loans keep their product and policy); close it instead.
 */
export async function deleteProduct(db: Executor, actor: Actor, productId: string) {
  assertCan(actor, "admin.policy.manage");
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(loanProducts).where(eq(loanProducts.id, productId));
    if (!p) throw new NotFoundError("Product");
    const [app] = await tx.select({ id: loanApplications.id }).from(loanApplications).where(eq(loanApplications.productId, productId)).limit(1);
    const [loan] = await tx.select({ id: loanAccounts.id }).from(loanAccounts).where(eq(loanAccounts.productId, productId)).limit(1);
    if (app || loan) throw new DomainError(`${p.name} has applications or loans on record, so it cannot be deleted. Close it to stop new applications.`);
    await tx.delete(documentRequirements).where(eq(documentRequirements.productId, productId));
    await tx.delete(policyVersions).where(eq(policyVersions.productId, productId));
    await tx.delete(loanProducts).where(eq(loanProducts.id, productId));
    await audit(tx, actor, { action: "product.deleted", entityType: "loan_product", entityId: productId, before: p, summary: `${p.code}: ${p.name}` });
  });
}

/**
 * Save a product's loan terms; they apply to new applications at once. There are no versions to manage:
 * while no application uses the current terms they are changed in place. Once applications or loans
 * use them, the new terms are kept as a fresh record, so those applications and loans keep exactly the
 * terms they were made on.
 */
export async function saveProductTerms(db: Executor, actor: Actor, productId: string, raw: unknown) {
  assertCan(actor, "admin.policy.manage");
  const parsed = policyParametersSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(loanProducts).where(eq(loanProducts.id, productId));
    if (!product) throw new NotFoundError("Product");
    const versions = await tx.select().from(policyVersions).where(eq(policyVersions.productId, productId)).orderBy(desc(policyVersions.version));
    const current = versions.find((v) => v.status === "active") ?? versions[0];
    const now = new Date();
    const live = { status: "active" as const, changeNote: "Terms updated", submittedBy: actor.userId, approvedBy: actor.userId, approvedAt: now, effectiveFrom: now };
    const [usedApp] = current ? await tx.select({ id: loanApplications.id }).from(loanApplications).where(eq(loanApplications.policyVersionId, current.id)).limit(1) : [];
    const [usedLoan] = current ? await tx.select({ id: loanAccounts.id }).from(loanAccounts).where(eq(loanAccounts.policyVersionId, current.id)).limit(1) : [];
    if (current && !usedApp && !usedLoan) {
      await tx.update(policyVersions).set({ parameters: parsed.data, ...live }).where(eq(policyVersions.id, current.id));
    } else {
      if (current?.status === "active") await tx.update(policyVersions).set({ status: "retired", retiredAt: now }).where(eq(policyVersions.id, current.id));
      await tx.insert(policyVersions).values({ productId, version: (versions[0]?.version ?? 0) + 1, parameters: parsed.data, createdBy: actor.userId, ...live });
    }
    // Leftovers from the old draft-and-approve steps are no longer used.
    await tx.delete(policyVersions).where(and(eq(policyVersions.productId, productId), inArray(policyVersions.status, ["draft", "pending_approval", "rejected"])));
    await audit(tx, actor, { action: "product.terms_updated", entityType: "loan_product", entityId: productId, before: current ? current.parameters : null, after: parsed.data, summary: `${product.name}: loan terms updated` });
  });
}

/** Throw away a draft (or rejected) policy version that is no longer wanted. */
export async function discardDraft(db: Executor, actor: Actor, versionId: string) {
  assertCan(actor, "admin.policy.manage");
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "draft" && v.status !== "rejected") throw new DomainError("Only draft or rejected versions can be discarded.");
    await tx.delete(policyVersions).where(eq(policyVersions.id, versionId));
    await audit(tx, actor, { action: "policy.draft_discarded", entityType: "policy_version", entityId: versionId, before: v.params, summary: `v${v.version}` });
    return v.productId;
  });
}

export async function createDraftFrom(db: Executor, actor: Actor, productId: string, fromVersionId?: string) {
  assertCan(actor, "admin.policy.manage");
  return db.transaction(async (tx) => {
    const [{ v }] = await tx.select({ v: max(policyVersions.version) }).from(policyVersions).where(eq(policyVersions.productId, productId));
    let params: PolicyParameters = DEFAULT_POLICY;
    if (fromVersionId) params = (await getPolicyVersion(tx, fromVersionId)).params;
    else {
      const active = await getActivePolicy(tx, productId);
      if (active) params = active.params;
    }
    const [draft] = await tx.insert(policyVersions).values({
      productId, version: (v ?? 0) + 1, status: "draft", parameters: params, createdBy: actor.userId, changeNote: "",
    }).returning();
    await audit(tx, actor, { action: "policy.draft_created", entityType: "policy_version", entityId: draft.id, summary: `v${draft.version}` });
    return draft;
  });
}

export async function updateDraft(db: Executor, actor: Actor, versionId: string, raw: unknown, changeNote: string) {
  assertCan(actor, "admin.policy.manage");
  const parsed = policyParametersSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "draft" && v.status !== "rejected") throw new DomainError("Only draft policy versions can be edited. Create a new version instead.");
    await tx.update(policyVersions).set({ parameters: parsed.data, changeNote, status: "draft" }).where(eq(policyVersions.id, versionId));
    await audit(tx, actor, { action: "policy.draft_updated", entityType: "policy_version", entityId: versionId, before: v.params, after: parsed.data, summary: changeNote });
  });
}

export async function submitPolicy(db: Executor, actor: Actor, versionId: string) {
  assertCan(actor, "admin.policy.manage");
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "draft") throw new DomainError("Only drafts can be submitted for approval.");
    if (!v.changeNote?.trim()) throw new DomainError("Add a change note describing this version before submitting.");
    await tx.update(policyVersions).set({ status: "pending_approval", submittedBy: actor.userId }).where(eq(policyVersions.id, versionId));
    await audit(tx, actor, { action: "policy.submitted", entityType: "policy_version", entityId: versionId });
  });
}

/**
 * Approve and activate a policy version. The previously active version is retired, but loans
 * already approved keep referencing their own version, so their terms are unchanged.
 */
/** One step for an administrator who both drafts and approves: the draft becomes the active policy at once. */
export async function activatePolicyDraft(db: Executor, actor: Actor, versionId: string) {
  assertCan(actor, "admin.policy.manage");
  assertCan(actor, "admin.policy.approve");
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "draft") throw new DomainError("Only a draft can be activated.");
    const changeNote = v.changeNote?.trim() || "Policy updated";
    const current = await getActivePolicy(tx, v.productId);
    if (current) await tx.update(policyVersions).set({ status: "retired", retiredAt: new Date() }).where(eq(policyVersions.id, current.id));
    await tx.update(policyVersions).set({ status: "active", changeNote, submittedBy: actor.userId, approvedBy: actor.userId, approvedAt: new Date(), effectiveFrom: new Date() }).where(eq(policyVersions.id, versionId));
    await audit(tx, actor, { action: "policy.activated", entityType: "policy_version", entityId: versionId, summary: `Version ${v.version} activated`, before: current ? { activeVersion: current.version } : null, after: { activeVersion: v.version } });
  });
}

export async function approvePolicy(db: Executor, actor: Actor, versionId: string) {
  assertCan(actor, "admin.policy.approve");
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "pending_approval") throw new DomainError("Only versions pending approval can be approved.");
    const current = await getActivePolicy(tx, v.productId);
    if (current) await tx.update(policyVersions).set({ status: "retired", retiredAt: new Date() }).where(eq(policyVersions.id, current.id));
    await tx.update(policyVersions).set({ status: "active", approvedBy: actor.userId, approvedAt: new Date(), effectiveFrom: new Date() }).where(eq(policyVersions.id, versionId));
    await audit(tx, actor, { action: "policy.activated", entityType: "policy_version", entityId: versionId, before: current ? { activeVersion: current.version } : null, after: { activeVersion: v.version } });
  });
}

export async function rejectPolicy(db: Executor, actor: Actor, versionId: string, reason: string) {
  assertCan(actor, "admin.policy.approve");
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "pending_approval") throw new DomainError("Only versions pending approval can be rejected.");
    await tx.update(policyVersions).set({ status: "rejected" }).where(eq(policyVersions.id, versionId));
    await audit(tx, actor, { action: "policy.rejected", entityType: "policy_version", entityId: versionId, summary: reason });
  });
}

/**
 * Deactivate (retire) the active policy version without a replacement. The product is closed to new
 * applications in the same transaction; existing loans keep their version. Drafts awaiting submission
 * on that version can no longer be submitted until a new version is approved.
 */
export async function retirePolicy(db: Executor, actor: Actor, versionId: string, reason: string) {
  assertCan(actor, "admin.policy.approve");
  if (reason.trim().length < 5) throw new DomainError("Give a reason for deactivating this policy.");
  return db.transaction(async (tx) => {
    const v = await getPolicyVersion(tx, versionId);
    if (v.status !== "active") throw new DomainError("Only the active policy version can be deactivated.");
    await tx.update(policyVersions).set({ status: "retired", retiredAt: new Date() }).where(eq(policyVersions.id, versionId));
    await tx.update(loanProducts).set({ isActive: false, updatedAt: new Date() }).where(eq(loanProducts.id, v.productId));
    await audit(tx, actor, { action: "policy.deactivated", entityType: "policy_version", entityId: versionId, summary: `v${v.version} deactivated; product closed. ${reason.trim()}` });
  });
}

export async function listPolicyVersions(db: Executor, productId: string) {
  return db.select().from(policyVersions).where(eq(policyVersions.productId, productId)).orderBy(desc(policyVersions.version));
}
