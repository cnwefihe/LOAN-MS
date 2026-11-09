import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { getDb } from "@/db";
import { users, roles, userRoles, rolePermissions, permissions, staffProfiles } from "@/db/schema";
import type { Permission, RoleCode } from "@/lib/auth/permissions";
import type { Actor } from "../actor";
import { audit } from "../audit";
import { DomainError } from "../errors";
import { notify } from "../notifications";
import { getSetting } from "../settings";

export async function loadActor(db: Executor, userId: string, ctx: { ip?: string | null; userAgent?: string | null } = {}): Promise<Actor | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || !u.isActive) return null;
  const roleRows = await db
    .select({ code: roles.code, roleId: roles.id })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  const roleIds = roleRows.map((r) => r.roleId);
  const permRows = roleIds.length
    ? await db
        .selectDistinct({ code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(inArray(rolePermissions.roleId, roleIds))
    : [];
  return {
    userId: u.id,
    email: u.email,
    displayName: u.displayName,
    roles: roleRows.map((r) => r.code as RoleCode),
    permissions: new Set(permRows.map((p) => p.code as Permission)),
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  };
}

export async function grantRole(db: Executor, userId: string, roleCode: RoleCode, grantedBy: Actor | null): Promise<boolean> {
  const [role] = await db.select().from(roles).where(eq(roles.code, roleCode));
  if (!role) throw new DomainError(`Role ${roleCode} is not configured.`);
  const inserted = await db
    .insert(userRoles)
    .values({ userId, roleId: role.id, assignedBy: grantedBy?.userId ?? null })
    .onConflictDoNothing()
    .returning();
  if (inserted.length) {
    await audit(db, grantedBy, { action: "user.role_granted", entityType: "user", entityId: userId, summary: `Granted ${roleCode}`, after: { role: roleCode } });
  }
  return inserted.length > 0;
}

export function allowedEmailDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS ?? "example.edu.ng").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export function isInstitutionalEmail(email: string): boolean {
  const domain = email.toLowerCase().split("@")[1] ?? "";
  return allowedEmailDomains().includes(domain);
}

export interface EntraIdentity {
  oid: string;
  tenantId: string;
  email: string;
  displayName: string;
  givenName?: string | null;
  surname?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  employeeId?: string | null;
  mobilePhone?: string | null;
}

/**
 * Called after a successful Entra ID sign-in. Creates the user + staff profile on first login,
 * links pre-created records (e.g. a colleague nominated as guarantor before ever signing in),
 * assigns the default Applicant role and refreshes directory attributes.
 */
export async function provisionEntraUser(identity: EntraIdentity): Promise<string> {
  const db = await getDb();
  if (!isInstitutionalEmail(identity.email)) {
    throw new DomainError("Only institutional staff accounts may use this system.");
  }
  return db.transaction(async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.entraOid, identity.oid));
    if (!user) {
      [user] = await tx.select().from(users).where(and(sql`lower(${users.email}) = ${identity.email.toLowerCase()}`, sql`${users.entraOid} is null`));
    }
    const isNew = !user;
    // Someone nominated as a guarantor has a record already, but this is still their first sign-in.
    const firstSignIn = isNew || !user.entraOid;
    if (!user) {
      [user] = await tx.insert(users).values({
        entraOid: identity.oid, entraTenantId: identity.tenantId, email: identity.email.toLowerCase(),
        displayName: identity.displayName, givenName: identity.givenName ?? null, surname: identity.surname ?? null, lastLoginAt: new Date(),
      }).returning();
    } else {
      if (!user.isActive) throw new DomainError("Your platform access has been deactivated. Contact the Bursary or Human Resources.");
      [user] = await tx.update(users).set({
        entraOid: identity.oid, entraTenantId: identity.tenantId, displayName: user.nameLocked ? user.displayName : identity.displayName,
        givenName: identity.givenName ?? user.givenName, surname: identity.surname ?? user.surname, lastLoginAt: new Date(), updatedAt: new Date(),
      }).where(eq(users.id, user.id)).returning();
    }

    await tx.insert(staffProfiles).values({
      userId: user.id, entraJobTitle: identity.jobTitle ?? null, entraDepartment: identity.department ?? null,
      phone: identity.mobilePhone ?? null, staffNumber: identity.employeeId || null,
    }).onConflictDoUpdate({
      target: staffProfiles.userId,
      set: { entraJobTitle: identity.jobTitle ?? null, entraDepartment: identity.department ?? null, updatedAt: new Date() },
    });

    await grantRole(tx, user.id, "APPLICANT", null);

    const bootstrap = (process.env.BOOTSTRAP_SUPER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (bootstrap.includes(user.email.toLowerCase())) {
      await grantRole(tx, user.id, "SUPER_ADMIN", null);
    }

    await audit(tx, { userId: user.id, email: user.email, displayName: user.displayName, roles: [], permissions: new Set() }, {
      action: isNew ? "user.provisioned" : "user.signed_in", entityType: "user", entityId: user.id,
      summary: isNew ? "Profile created on first Microsoft sign-in" : "Signed in with Microsoft Entra ID",
    });
    if (firstSignIn) {
      const held = await tx.select({ name: roles.name }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, user.id));
      await notify(tx, {
        template: "account.created", userIds: [user.id], link: "/home", dedupeKey: `welcome:${user.id}`,
        vars: { systemName: await getSetting(tx, "org.systemName"), email: user.email, roles: held.map((r) => r.name).join(", ") },
      });
    }
    return user.id;
  });
}

/** Find or create a placeholder user for a colleague nominated by email who has not yet signed in. */
export async function findOrCreateStaffByEmail(db: Executor, email: string, actor: Actor): Promise<typeof users.$inferSelect> {
  const normalized = email.trim().toLowerCase();
  if (!isInstitutionalEmail(normalized)) throw new DomainError(`${email} is not an institutional email address.`);
  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${normalized}`);
  if (existing) return existing;
  const local = normalized.split("@")[0];
  const [created] = await db.insert(users).values({
    email: normalized,
    displayName: local.split(/[._-]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" "),
  }).returning();
  await db.insert(staffProfiles).values({ userId: created.id }).onConflictDoNothing();
  await audit(db, actor, { action: "user.placeholder_created", entityType: "user", entityId: created.id, summary: `Placeholder created for nominated colleague ${normalized}` });
  return created;
}
