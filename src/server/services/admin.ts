import { and, desc, eq, ilike, inArray, or, sql, isNull, max } from "drizzle-orm";
import type { Executor } from "@/db";
import {
  users, roles, userRoles, permissions, rolePermissions, sessions, schools, departments, staffCategories, documentRequirements,
  termsDocuments, notificationTemplates, systemSettings, auditLogs, emailOutbox, documentAccessLogs, documents, brandAssets, staffProfiles,
} from "@/db/schema";
import { sha256Hex } from "@/lib/security/crypto";
import { LOGO_VARIANTS, type LogoVariant } from "../branding";
import { LOCKED_SUPER_ADMIN_PERMISSIONS, RETIRED_ROLE_CODES, ROLE_CODES, type Permission, type RoleCode } from "@/lib/auth/permissions";
import { assertCan, type Actor } from "../actor";
import { audit } from "../audit";
import { SETTINGS, getSetting, type SettingKey, type SettingGroup } from "../settings";
import { notify } from "../notifications";
import { preferredName } from "./staff";
import { DomainError, NotFoundError } from "../errors";
import { grantRole } from "./identity";

/* ───────────────────────── Users & roles ───────────────────────── */

export async function searchUsers(db: Executor, actor: Actor, q?: string) {
  assertCan(actor, "admin.users.manage");
  const where = q?.trim() ? or(ilike(users.displayName, `%${q.trim()}%`), ilike(users.email, `%${q.trim()}%`)) : sql`true`;
  const list = await db.select().from(users).where(where).orderBy(users.displayName);
  const ur = list.length ? await db.select({ userId: userRoles.userId, code: roles.code }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(inArray(userRoles.userId, list.map((u) => u.id))) : [];
  const staff = list.length ? await db.select({ userId: staffProfiles.userId, staffNumber: staffProfiles.staffNumber, designation: staffProfiles.designation, department: departments.name })
    .from(staffProfiles).leftJoin(departments, eq(departments.id, staffProfiles.departmentId)).where(inArray(staffProfiles.userId, list.map((u) => u.id))) : [];
  return list.map((u) => ({ ...u, staff: staff.find((x) => x.userId === u.id) ?? null, roles: ur.filter((r) => r.userId === u.id).map((r) => r.code as RoleCode) }));
}

export async function setUserRole(db: Executor, actor: Actor, userId: string, roleCode: RoleCode, grant: boolean) {
  assertCan(actor, "admin.users.manage");
  return db.transaction(async (tx) => {
    const roleEmail = async (template: string, name: string, description: string | null) => notify(tx, {
      template, userIds: [userId], link: "/home",
      vars: { systemName: await getSetting(tx, "org.systemName"), roleName: name, roleDescription: description || "See your dashboard for details.", actorName: await preferredName(tx, actor.userId, actor.displayName) },
    });
    if (grant) {
      if (await grantRole(tx, userId, roleCode, actor)) {
        const [added] = await tx.select().from(roles).where(eq(roles.code, roleCode));
        await roleEmail("account.role_granted", added.name, added.description);
      }
      return;
    }
    if (roleCode === "APPLICANT") throw new DomainError("Every staff member keeps the Applicant role. Deactivate the account instead.");
    const [role] = await tx.select().from(roles).where(eq(roles.code, roleCode));
    if (!role) throw new NotFoundError("Role");
    if (roleCode === "SUPER_ADMIN") {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId)).where(and(eq(userRoles.roleId, role.id), eq(users.isActive, true)));
      if (Number(n) <= 1) throw new DomainError("At least one active Super Administrator must remain.");
      if (userId === actor.userId) throw new DomainError("Ask another Super Administrator to remove your administrator role.");
    }
    const removed = await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id))).returning();
    if (removed.length) {
      await audit(tx, actor, { action: "user.role_revoked", entityType: "user", entityId: userId, summary: `Revoked ${roleCode}`, before: { role: roleCode } });
      await roleEmail("account.role_removed", role.name, role.description);
    }
  });
}

export async function setUserActive(db: Executor, actor: Actor, userId: string, isActive: boolean) {
  assertCan(actor, "admin.users.manage");
  if (userId === actor.userId && !isActive) throw new DomainError("You cannot deactivate your own account.");
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, userId));
    await tx.update(users).set({ isActive, updatedAt: new Date() }).where(eq(users.id, userId));
    if (!isActive) await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await audit(tx, actor, { action: isActive ? "user.activated" : "user.deactivated", entityType: "user", entityId: userId });
    if (before && before.isActive !== isActive) {
      await notify(tx, {
        template: isActive ? "account.reactivated" : "account.deactivated", userIds: [userId], link: isActive ? "/home" : undefined,
        vars: { systemName: await getSetting(tx, "org.systemName"), actorName: await preferredName(tx, actor.userId, actor.displayName) },
      });
    }
  });
}

export async function revokeUserSessions(db: Executor, actor: Actor, userId: string) {
  assertCan(actor, "admin.users.manage");
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await audit(db, actor, { action: "user.sessions_revoked", entityType: "user", entityId: userId });
}

export async function roleMatrix(db: Executor, actor: Actor) {
  assertCan(actor, "admin.roles.manage");
  const r = await db.select().from(roles).orderBy(roles.name);
  const p = await db.select().from(permissions).orderBy(permissions.category, permissions.code);
  const rp = await db.select().from(rolePermissions);
  const held = await db.select({ roleId: userRoles.roleId }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId)).where(eq(users.isActive, true));
  // Workflow order for the built-in roles, then the roles administrators added.
  const rank = (code: string) => { const i = ROLE_CODES.indexOf(code as RoleCode); return i < 0 ? ROLE_CODES.length : i; };
  return {
    roles: [...r].sort((a, b) => rank(a.code) - rank(b.code)),
    permissions: p,
    grants: new Set(rp.map((x) => `${x.roleId}:${x.permissionId}`)),
    holders: (roleId: string) => held.filter((h) => h.roleId === roleId).length,
  };
}

export async function setRolePermission(db: Executor, actor: Actor, roleId: string, permissionId: string, grant: boolean) {
  assertCan(actor, "admin.roles.manage");
  return db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
    const [perm] = await tx.select().from(permissions).where(eq(permissions.id, permissionId));
    if (!role || !perm) throw new NotFoundError("Role or permission");
    if (!grant && role.code === "SUPER_ADMIN" && LOCKED_SUPER_ADMIN_PERMISSIONS.includes(perm.code as Permission)) throw new DomainError("This permission is locked on the Super Administrator role to prevent lock-out.");
    if (grant && role.code === "SUPER_ADMIN" && ["transaction.approve"].includes(perm.code)) {
      throw new DomainError("Financial checker rights cannot be granted to the Super Administrator role (segregation of duties). Assign the Bursar role to a named user instead.");
    }
    if (grant) await tx.insert(rolePermissions).values({ roleId, permissionId }).onConflictDoNothing();
    else await tx.delete(rolePermissions).where(and(eq(rolePermissions.roleId, roleId), eq(rolePermissions.permissionId, permissionId)));
    await audit(tx, actor, { action: grant ? "role.permission_granted" : "role.permission_revoked", entityType: "role", entityId: roleId, summary: `${role.code}: ${perm.code}` });
  });
}

/** Rename a role or change its description. The code, and so the workflow behind it, never changes. */
function cleanRoleDetails(input: { name: string; description: string }) {
  const name = input.name.trim().replace(/\s+/g, " ");
  const description = input.description.trim();
  if (name.length < 2 || name.length > 60) throw new DomainError("A role title must be 2 to 60 characters.");
  if (description.length > 200) throw new DomainError("Keep the description to 200 characters or fewer.");
  return { name, description };
}

/** Saves a role's whole permission list at once. Locked permissions stay as they are. */
export async function setRolePermissions(db: Executor, actor: Actor, roleId: string, codes: string[]) {
  assertCan(actor, "admin.roles.manage");
  return db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
    if (!role) throw new NotFoundError("Role");
    const wanted = new Set(codes);
    if (role.code === "SUPER_ADMIN") LOCKED_SUPER_ADMIN_PERMISSIONS.forEach((c) => wanted.add(c));
    const current = new Set((await tx.select({ id: rolePermissions.permissionId }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId))).map((x) => x.id));
    let changed = 0;
    for (const p of await tx.select().from(permissions)) {
      if (wanted.has(p.code) === current.has(p.id)) continue;
      await setRolePermission(tx, actor, roleId, p.id, wanted.has(p.code));
      changed++;
    }
    return changed;
  });
}

/** Adds a role, optionally starting from another role's permissions. */
export async function createRole(db: Executor, actor: Actor, input: { name: string; description: string; copyFrom?: string }) {
  assertCan(actor, "admin.roles.manage");
  const { name, description } = cleanRoleDetails(input);
  return db.transaction(async (tx) => {
    const existing = await tx.select({ code: roles.code, name: roles.name }).from(roles);
    const clash = existing.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new DomainError(`Another role is already called "${clash.name}".`);
    const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ROLE";
    const taken = new Set<string>([...existing.map((r) => r.code), ...ROLE_CODES, ...RETIRED_ROLE_CODES]);
    let code = base;
    for (let i = 2; taken.has(code); i++) code = `${base}_${i}`;
    const [role] = await tx.insert(roles).values({ code, name, description: description || null, isSystem: false }).returning();
    if (input.copyFrom) {
      const from = await tx.select({ permissionId: rolePermissions.permissionId }).from(rolePermissions).where(eq(rolePermissions.roleId, input.copyFrom));
      if (from.length) await tx.insert(rolePermissions).values(from.map((x) => ({ roleId: role.id, permissionId: x.permissionId })));
    }
    await audit(tx, actor, { action: "role.created", entityType: "role", entityId: role.id, summary: `Created ${code}: "${name}"`, after: { name, description, copyFrom: input.copyFrom ?? null } });
    return role;
  });
}

/** Only roles added by an administrator can be deleted, and only once nobody holds them. */
export async function deleteRole(db: Executor, actor: Actor, roleId: string) {
  assertCan(actor, "admin.roles.manage");
  return db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
    if (!role) throw new NotFoundError("Role");
    if (role.isSystem) throw new DomainError("Built-in roles cannot be deleted.");
    const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(userRoles).where(eq(userRoles.roleId, roleId));
    if (Number(n) > 0) throw new DomainError("Remove this role from every user before deleting it.");
    await tx.delete(roles).where(eq(roles.id, roleId));
    await audit(tx, actor, { action: "role.deleted", entityType: "role", entityId: roleId, summary: `Deleted ${role.code}: "${role.name}"`, before: { name: role.name, description: role.description } });
  });
}

export async function updateRoleDetails(db: Executor, actor: Actor, roleId: string, input: { name: string; description: string }) {
  assertCan(actor, "admin.roles.manage");
  const { name, description } = cleanRoleDetails(input);
  return db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
    if (!role) throw new NotFoundError("Role");
    const clash = (await tx.select({ id: roles.id, name: roles.name }).from(roles)).find((r) => r.id !== roleId && r.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new DomainError(`Another role is already called "${clash.name}".`);
    await tx.update(roles).set({ name, description: description || null }).where(eq(roles.id, roleId));
    await audit(tx, actor, { action: "role.renamed", entityType: "role", entityId: roleId, summary: `${role.code}: "${role.name}" → "${name}"`, before: { name: role.name, description: role.description }, after: { name, description } });
  });
}

/* ───────────────────────── Organisation ───────────────────────── */

export async function upsertSchool(db: Executor, actor: Actor, input: { id?: string; code: string; name: string; isActive: boolean }) {
  assertCan(actor, "admin.org.manage");
  const values = { code: input.code.trim().toUpperCase(), name: input.name.trim(), isActive: input.isActive };
  if (!values.code || !values.name) throw new DomainError("Code and name are required.");
  const [row] = input.id
    ? await db.update(schools).set(values).where(eq(schools.id, input.id)).returning()
    : await db.insert(schools).values(values).returning();
  await audit(db, actor, { action: input.id ? "org.school_updated" : "org.school_created", entityType: "school", entityId: row.id, after: values });
}

export async function upsertDepartment(db: Executor, actor: Actor, input: { id?: string; code: string; name: string; schoolId: string | null; headUserId?: string | null; approverTitle?: string; isActive: boolean }) {
  assertCan(actor, "admin.org.manage");
  const approverTitle = input.approverTitle === "line_manager" ? "line_manager" as const : "hod" as const;
  const values = { code: input.code.trim().toUpperCase(), name: input.name.trim(), schoolId: input.schoolId || null, headUserId: input.headUserId || null, approverTitle, isActive: input.isActive };
  if (values.headUserId) {
    const [head] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, values.headUserId));
    if (!head?.isActive) throw new DomainError("Choose an active member of staff as Line Manager.");
  }
  if (!values.code || !values.name) throw new DomainError("Code and name are required.");
  const [row] = input.id
    ? await db.update(departments).set(values).where(eq(departments.id, input.id)).returning()
    : await db.insert(departments).values(values).returning();
  await audit(db, actor, { action: input.id ? "org.department_updated" : "org.department_created", entityType: "department", entityId: row.id, after: values });
}

export async function upsertCategory(db: Executor, actor: Actor, input: { id?: string; code: string; name: string; isActive: boolean }) {
  assertCan(actor, "admin.org.manage");
  const values = { code: input.code.trim().toUpperCase(), name: input.name.trim(), isActive: input.isActive };
  const [row] = input.id
    ? await db.update(staffCategories).set(values).where(eq(staffCategories.id, input.id)).returning()
    : await db.insert(staffCategories).values(values).returning();
  await audit(db, actor, { action: "org.category_saved", entityType: "staff_category", entityId: row.id, after: values });
}

/* ───────────────────────── Content ───────────────────────── */

export async function upsertDocumentRequirement(db: Executor, actor: Actor, input: { id?: string; productId: string | null; code: string; label: string; appliesTo: "applicant" | "guarantor"; isRequired: boolean; isActive: boolean }) {
  assertCan(actor, "admin.content.manage");
  const values = { productId: input.productId || null, code: input.code.trim().toUpperCase(), label: input.label.trim(), appliesTo: input.appliesTo, isRequired: input.isRequired, isActive: input.isActive };
  const [row] = input.id
    ? await db.update(documentRequirements).set(values).where(eq(documentRequirements.id, input.id)).returning()
    : await db.insert(documentRequirements).values(values).returning();
  await audit(db, actor, { action: "content.document_requirement_saved", entityType: "document_requirement", entityId: row.id, after: values });
}

/** Terms are versioned: publishing creates a new version and deactivates the previous one. Accepted versions are kept forever. */
export async function publishTerms(db: Executor, actor: Actor, input: { kind: "loan_terms" | "guarantor_agreement"; title: string; body: string }) {
  assertCan(actor, "admin.content.manage");
  if (input.body.trim().length < 50) throw new DomainError("Terms text is too short.");
  return db.transaction(async (tx) => {
    const [{ v }] = await tx.select({ v: max(termsDocuments.version) }).from(termsDocuments).where(eq(termsDocuments.kind, input.kind));
    await tx.update(termsDocuments).set({ isActive: false }).where(and(eq(termsDocuments.kind, input.kind), eq(termsDocuments.isActive, true)));
    const [row] = await tx.insert(termsDocuments).values({ kind: input.kind, version: (v ?? 0) + 1, title: input.title.trim(), body: input.body.trim(), isActive: true, createdBy: actor.userId }).returning();
    await audit(tx, actor, { action: "content.terms_published", entityType: "terms_document", entityId: row.id, summary: `${input.kind} v${row.version}` });
    return row;
  });
}

export async function updateTemplate(db: Executor, actor: Actor, code: string, input: { subject: string; body: string; sendEmail: boolean; isActive: boolean }) {
  assertCan(actor, "admin.content.manage");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(notificationTemplates).where(eq(notificationTemplates.code, code));
    if (!before) throw new NotFoundError("Template");
    await tx.update(notificationTemplates).set({ ...input, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(notificationTemplates.code, code));
    await audit(tx, actor, { action: "content.template_updated", entityType: "notification_template", entityId: before.id, before: { subject: before.subject, body: before.body }, after: input });
  });
}

/* ───────────────────────── Settings ───────────────────────── */

export async function updateSetting(db: Executor, actor: Actor, key: SettingKey, raw: unknown) {
  assertCan(actor, "admin.settings.manage");
  const def = SETTINGS[key];
  if (!def) throw new DomainError("Unknown setting.");
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) throw new DomainError(`${def.label}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(systemSettings).where(eq(systemSettings.key, key));
    await tx.insert(systemSettings).values({ key, value: parsed.data as never, description: def.label, isSensitive: def.sensitive, updatedBy: actor.userId })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: parsed.data as never, updatedBy: actor.userId, updatedAt: new Date() } });
    await audit(tx, actor, { action: def.sensitive ? "settings.sensitive_changed" : "settings.changed", entityType: "system_setting", entityId: key, before: { value: before?.value ?? def.default }, after: { value: parsed.data } });
  });
}

/**
 * Saves every setting in a group from one form. Only changed values are written (each is audited);
 * a change to a sensitive control needs explicit confirmation.
 */
export async function updateSettingsGroup(db: Executor, actor: Actor, group: SettingGroup, values: Partial<Record<SettingKey, unknown>>, confirmed: boolean) {
  assertCan(actor, "admin.settings.manage");
  const keys = (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].group === group && k in values);
  const current = new Map((await db.select().from(systemSettings).where(inArray(systemSettings.key, keys))).map((r) => [r.key, r.value]));
  const changed = keys.filter((k) => {
    const parsed = SETTINGS[k].schema.safeParse(values[k]);
    const now = current.has(k) ? current.get(k) : SETTINGS[k].default;
    return !parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(now);
  });
  if (!changed.length) return 0;
  if (!confirmed && changed.some((k) => SETTINGS[k].sensitive)) throw new DomainError("Tick the confirmation box to change a sensitive control.");
  await db.transaction(async (tx) => {
    for (const k of changed) await updateSetting(tx, actor, k, values[k]);
  });
  return changed.length;
}

/* ───────────────────────── Branding assets ───────────────────────── */

const IMAGE_SIGNATURES: [string, number[]][] = [["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], ["image/jpeg", [0xff, 0xd8, 0xff]]];

export async function uploadBrandAsset(db: Executor, actor: Actor, variant: LogoVariant, file: { buffer: Buffer; fileName: string }) {
  assertCan(actor, "admin.settings.manage");
  if (!(variant in LOGO_VARIANTS)) throw new DomainError("Unknown logo type.");
  if (file.buffer.length > 2 * 1024 * 1024) throw new DomainError("Logos must be 2 MB or smaller.");
  // Identify the image from its content, not from the name or the browser-declared type.
  const mimeType = IMAGE_SIGNATURES.find(([, sig]) => sig.every((b, i) => file.buffer[i] === b))?.[0];
  if (!mimeType) throw new DomainError("Upload a PNG or JPEG image. PNG with a transparent background works best.");
  const sha = sha256Hex(file.buffer);
  await db.insert(brandAssets).values({ variant, mimeType, dataBase64: file.buffer.toString("base64"), sha256: sha, updatedBy: actor.userId })
    .onConflictDoUpdate({ target: brandAssets.variant, set: { mimeType, dataBase64: file.buffer.toString("base64"), sha256: sha, updatedBy: actor.userId, updatedAt: new Date() } });
  await audit(db, actor, { action: "branding.logo_uploaded", entityType: "brand_asset", entityId: variant, summary: `${LOGO_VARIANTS[variant].label} replaced (${file.fileName}, ${Math.round(file.buffer.length / 1024)} KB, sha256 ${sha.slice(0, 12)})` });
}

export async function resetBrandAsset(db: Executor, actor: Actor, variant: LogoVariant) {
  assertCan(actor, "admin.settings.manage");
  const removed = await db.delete(brandAssets).where(eq(brandAssets.variant, variant)).returning({ v: brandAssets.variant });
  if (removed.length) await audit(db, actor, { action: "branding.logo_reset", entityType: "brand_asset", entityId: variant, summary: `${LOGO_VARIANTS[variant].label} restored to the bundled default` });
}

/* ───────────────────────── Audit & outbox ───────────────────────── */

export async function queryAudit(db: Executor, actor: Actor, opts: { q?: string; entityType?: string; limit?: number }) {
  assertCan(actor, "admin.audit.view");
  const conds = [];
  if (opts.entityType) conds.push(eq(auditLogs.entityType, opts.entityType));
  if (opts.q?.trim()) conds.push(or(ilike(auditLogs.action, `%${opts.q.trim()}%`), ilike(auditLogs.summary, `%${opts.q.trim()}%`), ilike(auditLogs.entityId, `%${opts.q.trim()}%`)));
  return db.select({ log: auditLogs, actorName: users.displayName }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(conds.length ? and(...conds) : sql`true`).orderBy(desc(auditLogs.id)).limit(opts.limit ?? 5000);
}

export async function activeSessions(db: Executor, actor: Actor) {
  assertCan(actor, "admin.users.manage");
  return db.select({ s: sessions, name: users.displayName, email: users.email }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(isNull(sessions.revokedAt), sql`${sessions.expiresAt} > now()`)).orderBy(desc(sessions.lastSeenAt));
}

export async function revokeSession(db: Executor, actor: Actor, sessionId: string) {
  assertCan(actor, "admin.users.manage");
  const [s] = await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))).returning();
  if (s) await audit(db, actor, { action: "session.revoked", entityType: "user", entityId: s.userId, summary: `Session ${s.id.slice(0, 8)} revoked` });
}

export async function documentAccessLog(db: Executor, actor: Actor, q?: string) {
  assertCan(actor, "admin.audit.view");
  return db.select({ log: documentAccessLogs, user: users.displayName, title: documents.title, fileName: documents.fileName, category: documents.category })
    .from(documentAccessLogs).innerJoin(users, eq(users.id, documentAccessLogs.userId)).innerJoin(documents, eq(documents.id, documentAccessLogs.documentId))
    .where(q?.trim() ? or(ilike(users.displayName, `%${q.trim()}%`), ilike(documents.title, `%${q.trim()}%`), ilike(documentAccessLogs.action, `%${q.trim()}%`)) : sql`true`)
    .orderBy(desc(documentAccessLogs.id)).limit(5000);
}

/** Put failed / undelivered emails back in the queue (e.g. after configuring the transport). */
export async function requeueEmails(db: Executor, actor: Actor) {
  assertCan(actor, "admin.settings.manage");
  const rows = await db.update(emailOutbox).set({ status: "queued", attempts: 0, lastError: null })
    .where(and(inArray(emailOutbox.status, ["failed", "not_configured"]), sql`${emailOutbox.createdAt} > now() - interval '14 days'`)).returning({ id: emailOutbox.id });
  await audit(db, actor, { action: "email.requeued", entityType: "system", summary: `${rows.length} email(s) re-queued` });
  return rows.length;
}

export async function emailOutboxList(db: Executor, actor: Actor) {
  assertCan(actor, "admin.audit.view");
  return db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(5000);
}

/** Sends one test email immediately so administrators can confirm the Microsoft 365 set-up. */
export async function sendTestEmail(db: Executor, actor: Actor, to: string, systemName: string) {
  assertCan(actor, "admin.settings.manage");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new DomainError("Enter a valid email address.");
  const [row] = await db.insert(emailOutbox).values({
    toAddress: to, subject: `Test email from the ${systemName}`,
    body: `Dear colleague,

This is a test message sent by ${actor.displayName} from Administration > Email outbox to confirm that email delivery through Microsoft 365 is working.

No action is needed.`,
  }).returning();
  await audit(db, actor, { action: "email.test_sent", entityType: "email_outbox", entityId: row.id, summary: `Test email queued to ${to}` });
  return row.id;
}
