"use server";

import { getDb } from "@/db";
import { runAction, str, bool, file } from "@/server/action";
import type { ActionResult } from "@/server/action-result";
import { DomainError } from "@/server/errors";
import type { RoleCode } from "@/lib/auth/permissions";
import { POLICY_FIELD_LABELS, type PolicyParameters } from "@/lib/finance/policy";
import { DEFAULT_POLICY } from "@/lib/finance/defaults";
import { processOutbox } from "@/server/email";
import { assertCan } from "@/server/actor";
import { setUserRole, setUserActive, revokeUserSessions, setRolePermissions, createRole, deleteRole, updateRoleDetails, upsertSchool, upsertDepartment, upsertCategory, deleteOrgItem, setDepartmentApprover, clearDepartmentApprover, upsertDocumentRequirement, publishTerms, updateTemplate, updateSetting,
  revokeSession, requeueEmails, updateSettingsGroup, uploadBrandAsset, resetBrandAsset, sendTestEmail,
} from "@/server/services/admin";
import { createProduct, setProductActive, createDraftFrom, updateDraft, updateProductDetails, deleteProduct, discardDraft, submitPolicy, approvePolicy, rejectPolicy, retirePolicy } from "@/server/services/policies";
import { SETTINGS, SETTING_GROUPS, type SettingKey, type SettingGroup } from "@/server/settings";
import { isLogoVariant, getBranding } from "@/server/branding";
import { emailOutbox } from "@/db/schema";
import { eq } from "drizzle-orm";

type Prev = ActionResult | null;

export async function setUserRoleAction(userId: string, role: string, grant: boolean, _: Prev) {
  return runAction(async (actor) => {
    await setUserRole(await getDb(), actor, userId, role as RoleCode, grant);
    return grant ? `${role} granted.` : `${role} revoked.`;
  }, { revalidate: ["/admin/users", `/admin/users/${userId}`] });
}

export async function setUserActiveAction(userId: string, active: boolean, _: Prev) {
  return runAction(async (actor) => {
    await setUserActive(await getDb(), actor, userId, active);
    return active ? "Account activated." : "Account deactivated and sessions revoked.";
  }, { revalidate: ["/admin/users", `/admin/users/${userId}`] });
}

export async function revokeSessionsAction(userId: string, _: Prev) {
  return runAction(async (actor) => {
    await revokeUserSessions(await getDb(), actor, userId);
    return "All sessions revoked.";
  }, { revalidate: ["/admin/users", `/admin/users/${userId}`] });
}

export async function revokeSessionAction(sessionId: string, _: Prev) {
  return runAction(async (actor) => {
    await revokeSession(await getDb(), actor, sessionId);
    return "Session revoked.";
  }, { revalidate: ["/admin/audit"] });
}

export async function requeueEmailsAction(_: Prev) {
  return runAction(async (actor) => {
    const n = await requeueEmails(await getDb(), actor);
    const r = await processOutbox(500);
    return `${n} re-queued. Dispatch: ${r.sent} sent, ${r.skipped} not sent (no transport), ${r.failed} failed.`;
  }, { revalidate: ["/admin/outbox"], limit: 5 });
}

export async function dispatchEmailsAction(_: Prev) {
  return runAction(async (actor) => {
    assertCan(actor, "admin.audit.view");
    const r = await processOutbox(500);
    return `Dispatch: ${r.sent} sent, ${r.skipped} not sent (no transport), ${r.failed} failed.`;
  }, { revalidate: ["/admin/outbox"], limit: 5 });
}

export async function setRolePermissionsAction(roleId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const changed = await setRolePermissions(await getDb(), actor, roleId, fd.getAll("perm").map(String));
    return changed ? "Permissions saved." : "No changes to save.";
  }, { revalidate: ["/admin/roles", `/admin/roles/${roleId}`] });
}

export async function createRoleAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const role = await createRole(await getDb(), actor, { name: str(fd, "name", true), description: str(fd, "description"), copyFrom: str(fd, "copyFrom") || undefined });
    return { redirectTo: `/admin/roles/${role.id}`, message: "Role created. Choose its permissions." };
  }, { revalidate: ["/admin/roles"] });
}

export async function deleteRoleAction(roleId: string, _: Prev) {
  return runAction(async (actor) => {
    await deleteRole(await getDb(), actor, roleId);
    return { redirectTo: "/admin/roles", message: "Role deleted." };
  }, { revalidate: ["/admin/roles"] });
}

export async function updateRoleDetailsAction(roleId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await updateRoleDetails(await getDb(), actor, roleId, { name: str(fd, "name"), description: str(fd, "description") });
    return "Role updated. The new title shows across the system straight away.";
  }, { revalidate: ["/"] });
}

export async function createProductAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const p = await createProduct(await getDb(), actor, { code: str(fd, "code", true), name: str(fd, "name", true), description: str(fd, "description") });
    return { redirectTo: `/admin/products/${p.id}`, message: "Product created with a draft policy." };
  }, { revalidate: ["/admin/products"] });
}

export async function setProductActiveAction(productId: string, active: boolean, _: Prev) {
  return runAction(async (actor) => {
    await setProductActive(await getDb(), actor, productId, active);
    return active ? "Product opened for applications." : "Product closed to new applications.";
  }, { revalidate: ["/admin/products"] });
}

export async function updateProductDetailsAction(productId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await updateProductDetails(await getDb(), actor, productId, { name: str(fd, "name"), description: str(fd, "description") });
    return "Product details saved.";
  }, { revalidate: ["/admin/products", "/products"] });
}

export async function deleteProductAction(productId: string, _: Prev) {
  return runAction(async (actor) => {
    await deleteProduct(await getDb(), actor, productId);
    return { redirectTo: "/admin/products", message: "Product deleted." };
  }, { revalidate: ["/admin/products", "/products"] });
}

export async function discardDraftAction(versionId: string, _: Prev) {
  return runAction(async (actor) => {
    const productId = await discardDraft(await getDb(), actor, versionId);
    return { redirectTo: `/admin/products/${productId}`, message: "Draft discarded." };
  }, { revalidate: ["/admin/products"] });
}

export async function newPolicyDraftAction(productId: string, fromVersionId: string | null, _: Prev) {
  return runAction(async (actor) => {
    const d = await createDraftFrom(await getDb(), actor, productId, fromVersionId ?? undefined);
    return { redirectTo: `/admin/products/${productId}?version=${d.id}`, message: `Draft v${d.version} created.` };
  }, { revalidate: ["/admin/products"] });
}

const NUMBER_FIELDS: (keyof PolicyParameters)[] = [
  "minServiceMonths", "maxActiveLoans", "annualInterestRate", "minTenorMonths", "maxTenorMonths",
  "maxDeductionPercent", "requiredGuarantors", "guarantorMinServiceMonths", "maxGuaranteesPerGuarantor", "repaymentDayOfMonth", "gracePeriodMonths",
  "overdueAfterDays", "defaultAfterDays", "reminderDaysBeforeDue", "maxRestructuredTenorMonths",
];

export async function savePolicyDraftAction(versionId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const raw: Record<string, unknown> = {};
    for (const k of NUMBER_FIELDS) {
      const v = str(fd, k);
      if (v === "" || Number.isNaN(Number(v))) throw new DomainError(`${POLICY_FIELD_LABELS[k]} must be a number.`);
      raw[k] = Number(v);
    }
    for (const k of ["productType", "interestMethod", "repaymentFrequency"] as const) raw[k] = str(fd, k);
    // Fixed by how the system works: eligibility comes from the payslip (a share of net pay). The rebate setting now
    // only decides whether a Bursar-approved principal waiver also releases the interest on the amount waived.
    Object.assign(raw, { affordabilityRule: "deduction_cap", deductionBasis: "net", minTakeHomePercent: DEFAULT_POLICY.minTakeHomePercent, earlySettlementRebate: DEFAULT_POLICY.earlySettlementRebate });
    raw.maxGuarantorExposure = str(fd, "maxGuarantorExposure").replace(/,/g, "");
    raw.cafeteriaAmount = str(fd, "cafeteriaAmount").replace(/,/g, "") || "25000.00";
    raw.guarantorMustBeConfirmed = bool(fd, "guarantorMustBeConfirmed");
    raw.allowRestructuring = bool(fd, "allowRestructuring");
    raw.eligibleEmploymentStatuses = fd.getAll("eligibleEmploymentStatuses").map(String);
    raw.requiredDocumentCodes = str(fd, "requiredDocumentCodes").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    await updateDraft(await getDb(), actor, versionId, raw, str(fd, "changeNote"));
    return "Draft saved and validated.";
  }, { revalidate: ["/admin/products"] });
}

export async function submitPolicyAction(versionId: string, _: Prev) {
  return runAction(async (actor) => {
    await submitPolicy(await getDb(), actor, versionId);
    return "Submitted for approval.";
  }, { revalidate: ["/admin/products"] });
}

export async function approvePolicyAction(versionId: string, _: Prev) {
  return runAction(async (actor) => {
    await approvePolicy(await getDb(), actor, versionId);
    return "Policy version approved and activated. Existing loans keep their original terms.";
  }, { revalidate: ["/admin/products"] });
}

export async function retirePolicyAction(versionId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await retirePolicy(await getDb(), actor, versionId, str(fd, "reason"));
    return "Policy deactivated and product closed to new applications. Existing loans are unaffected.";
  }, { revalidate: ["/admin/products"] });
}

export async function rejectPolicyAction(versionId: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await rejectPolicy(await getDb(), actor, versionId, str(fd, "reason", true));
    return "Policy version rejected.";
  }, { revalidate: ["/admin/products"] });
}

export async function deleteOrgAction(kind: "school" | "department" | "category", id: string, _: Prev) {
  return runAction(async (actor) => {
    if (!["school", "department", "category"].includes(kind)) throw new DomainError("Unknown organisation type.");
    await deleteOrgItem(await getDb(), actor, kind, id);
    const tab = { school: "schools", department: "departments", category: "categories" }[kind];
    return { redirectTo: `/admin/organisation?tab=${tab}`, message: "Deleted." };
  }, { revalidate: ["/admin/organisation"] });
}

export async function assignApproverAction(userId: string, title: "hod" | "line_manager", _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const departmentId = str(fd, "departmentId", true);
    await setDepartmentApprover(await getDb(), actor, departmentId, userId, title === "line_manager" ? "line_manager" : "hod");
    return "Approver set.";
  }, { revalidate: [`/admin/users/${userId}`, "/admin/organisation"] });
}

export async function removeApproverAction(userId: string, departmentId: string, _: Prev) {
  return runAction(async (actor) => {
    await clearDepartmentApprover(await getDb(), actor, departmentId, userId);
    return "Approver removed.";
  }, { revalidate: [`/admin/users/${userId}`, "/admin/organisation"] });
}

export async function saveOrgAction(kind: "school" | "department" | "category", id: string | null, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    if (!["school", "department", "category"].includes(kind)) throw new DomainError("Unknown organisation type.");
    const db = await getDb();
    const base = { id: id ?? undefined, code: str(fd, "code", true), name: str(fd, "name", true), isActive: id ? bool(fd, "isActive") : true };
    if (kind === "school") await upsertSchool(db, actor, base);
    else if (kind === "department") await upsertDepartment(db, actor, { ...base, schoolId: str(fd, "schoolId") || null, headUserId: str(fd, "headUserId") || null, approverTitle: str(fd, "approverTitle") });
    else await upsertCategory(db, actor, base);
    const tab = { school: "schools", department: "departments", category: "categories" }[kind];
    return id ? "Saved." : { redirectTo: `/admin/organisation?tab=${tab}`, message: "Added." };
  }, { revalidate: ["/admin/organisation", `/admin/organisation/${kind}/${id ?? "new"}`] });
}

export async function saveRequirementAction(id: string | null, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await upsertDocumentRequirement(await getDb(), actor, {
      id: id ?? undefined, productId: str(fd, "productId") || null, code: str(fd, "code", true), label: str(fd, "label", true),
      appliesTo: str(fd, "appliesTo") === "guarantor" ? "guarantor" : "applicant", isRequired: bool(fd, "isRequired"), isActive: id ? bool(fd, "isActive") : true,
    });
    return id ? "Requirement saved." : { redirectTo: "/admin/content?tab=documents", message: "Requirement added." };
  }, { revalidate: ["/admin/content", `/admin/content/documents/${id ?? "new"}`] });
}

export async function publishTermsAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const kind = str(fd, "kind") === "guarantor_agreement" ? "guarantor_agreement" : "loan_terms";
    const t = await publishTerms(await getDb(), actor, { kind, title: str(fd, "title", true), body: str(fd, "body", true) });
    return `Published ${kind.replace("_", " ")} v${t.version}. New submissions and acceptances will use this version.`;
  }, { revalidate: ["/admin/content", "/admin/content/terms/loan_terms", "/admin/content/terms/guarantor_agreement"] });
}

export async function saveTemplateAction(code: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    await updateTemplate(await getDb(), actor, code, { subject: str(fd, "subject", true), body: str(fd, "body", true), sendEmail: bool(fd, "sendEmail"), isActive: bool(fd, "isActive") });
    return "Template saved.";
  }, { revalidate: ["/admin/content", `/admin/content/templates/${code}`] });
}

export async function saveSettingAction(key: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    if (!(key in SETTINGS)) throw new DomainError("Unknown setting.");
    const def = SETTINGS[key as SettingKey];
    const t = def.schema._zod.def.type;
    const raw = str(fd, "value");
    const value = t === "boolean" ? bool(fd, "value") : t === "number" ? Number(raw) : raw;
    if (str(fd, "confirm") !== "yes" && def.sensitive) throw new DomainError("Tick the confirmation box to change a sensitive control.");
    await updateSetting(await getDb(), actor, key as SettingKey, value);
    return "Setting updated.";
  }, { revalidate: ["/admin/settings"] });
}

/** Reads a form value according to the setting's type. */
function settingValue(fd: FormData, key: SettingKey): unknown {
  const t = SETTINGS[key].schema._zod.def.type;
  if (t === "boolean") return bool(fd, key);
  const raw = str(fd, key);
  const unit = fd.get(`${key}__unit`);
  if (unit) return Number(raw) * Number(unit);
  return t === "number" ? Number(raw) : raw;
}

export async function saveSettingsGroupAction(group: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    if (!(SETTING_GROUPS as readonly string[]).includes(group)) throw new DomainError("Unknown settings group.");
    const keys = fd.getAll("__keys").map(String).filter((k): k is SettingKey => k in SETTINGS && SETTINGS[k as SettingKey].group === group);
    const values = Object.fromEntries(keys.map((k) => [k, settingValue(fd, k)]));
    const n = await updateSettingsGroup(await getDb(), actor, group as SettingGroup, values, str(fd, "confirm") === "yes");
    return n ? `${n} setting${n === 1 ? "" : "s"} updated.` : "No changes to save.";
  }, { revalidate: ["/", "/admin/settings", "/admin/branding"] });
}

export async function uploadLogoAction(variant: string, _: Prev, fd: FormData) {
  return runAction(async (actor) => {
    if (!isLogoVariant(variant)) throw new DomainError("Unknown logo type.");
    const f = file(fd, "logo");
    if (!f) throw new DomainError("Choose an image to upload.");
    await uploadBrandAsset(await getDb(), actor, variant, { buffer: Buffer.from(await f.arrayBuffer()), fileName: f.name });
    return "Logo updated. It now appears on screens, emails and new documents.";
  }, { revalidate: ["/"], limit: 10 });
}

export async function resetLogoAction(variant: string, _: Prev) {
  return runAction(async (actor) => {
    if (!isLogoVariant(variant)) throw new DomainError("Unknown logo type.");
    await resetBrandAsset(await getDb(), actor, variant);
    return "Restored the bundled logo.";
  }, { revalidate: ["/"] });
}

export async function sendTestEmailAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const db = await getDb();
    const id = await sendTestEmail(db, actor, str(fd, "to", true), (await getBranding(db)).systemName);
    await processOutbox(50);
    const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id));
    if (row?.status === "sent") return `Test email sent to ${row.toAddress}. Check the inbox (and junk folder).`;
    if (row?.status === "not_configured") throw new DomainError("Email is not configured on this server, so the test was recorded but not sent. Set EMAIL_TRANSPORT=graph and the Microsoft 365 credentials.");
    throw new DomainError(`Microsoft 365 did not accept the message: ${row?.lastError?.slice(0, 300) ?? "unknown error"}`);
  }, { revalidate: ["/admin/outbox"], limit: 5 });
}

export async function publishReleaseAction(_: Prev, fd: FormData) {
  return runAction(async (actor) => {
    const { publishRelease } = await import("@/server/services/releases");
    const r = await publishRelease(await getDb(), actor, { version: str(fd, "version", true), title: str(fd, "title", true), notes: str(fd, "notes", true) });
    return `Version ${r.release.version} published. ${r.notified} staff notified.`;
  }, { revalidate: ["/admin/releases", "/whats-new"] });
}

export async function resetMfaAction(userId: string, _: Prev) {
  return runAction(async (actor) => {
    const { resetMfa } = await import("@/server/services/mfa");
    await resetMfa(await getDb(), actor, userId);
    return "Two-step verification reset. They will set it up again at their next sign-in.";
  }, { revalidate: ["/admin/users", `/admin/users/${userId}`] });
}
