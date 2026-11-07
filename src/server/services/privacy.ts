/**
 * Data subject access (Nigeria Data Protection Act 2023, s.34): a staff member can download every
 * record the platform holds about them. Secrets (session token hashes, encrypted account numbers,
 * storage keys) are never included; internal HR/approval notes about others are excluded.
 */
import { desc, eq, inArray, or } from "drizzle-orm";
import type { Executor } from "@/db";
import {
  users, staffProfiles, userRoles, roles, loanApplications, applicationGuarantors, loanAccounts, financialTransactions, repaymentClaims,
  restructureRequests, notifications, documents, sessions, auditLogs, applicationMessages, scheduleInstalments,
} from "@/db/schema";
import { getBranding } from "../branding";
import type { Actor } from "../actor";
import { audit } from "../audit";

export async function exportMyData(db: Executor, actor: Actor) {
  const me = actor.userId;
  const [user] = await db.select().from(users).where(eq(users.id, me));
  const [profile] = await db.select().from(staffProfiles).where(eq(staffProfiles.userId, me));
  const myRoles = await db.select({ code: roles.code, assignedAt: userRoles.assignedAt }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, me));
  const apps = await db.select().from(loanApplications).where(eq(loanApplications.applicantId, me));
  const appIds = apps.map((a) => a.id);
  const guaranteesGiven = await db.select().from(applicationGuarantors).where(eq(applicationGuarantors.guarantorId, me));
  const loans = await db.select().from(loanAccounts).where(eq(loanAccounts.borrowerId, me));
  const loanIds = loans.map((l) => l.id);
  const txns = loanIds.length ? await db.select().from(financialTransactions).where(inArray(financialTransactions.loanAccountId, loanIds)) : [];
  const instalments = loanIds.length ? await db.select().from(scheduleInstalments).where(inArray(scheduleInstalments.loanAccountId, loanIds)) : [];
  const claims = await db.select().from(repaymentClaims).where(eq(repaymentClaims.claimedBy, me));
  const restructures = await db.select().from(restructureRequests).where(eq(restructureRequests.requestedBy, me));
  const msgs = appIds.length ? await db.select().from(applicationMessages).where(inArray(applicationMessages.applicationId, appIds)) : [];
  const notes = await db.select().from(notifications).where(eq(notifications.userId, me)).orderBy(desc(notifications.createdAt));
  const docs = await db.select().from(documents).where(or(eq(documents.ownerUserId, me), eq(documents.uploadedBy, me), appIds.length ? inArray(documents.applicationId, appIds) : eq(documents.ownerUserId, me)));
  const sess = await db.select().from(sessions).where(eq(sessions.userId, me));
  const activity = await db.select().from(auditLogs).where(eq(auditLogs.actorId, me)).orderBy(desc(auditLogs.id)).limit(5000);

  const brand = await getBranding(db);
  await audit(db, actor, { action: "privacy.data_exported", entityType: "user", entityId: me, summary: "Data subject access export downloaded" });

  const strip = <T extends Record<string, unknown>>(row: T, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
  return {
    generatedAt: new Date().toISOString(),
    controller: brand.institutionName,
    notice: `This file contains the personal data the ${brand.systemName} holds about you. Internal due-diligence notes and other people's data are excluded. Contact the Data Protection Officer to request correction or to ask about anything not included.`,
    identity: strip(user, []),
    staffProfile: profile ? strip(profile, ["bankAccountNumberEnc"]) : null,
    roles: myRoles,
    applications: apps,
    applicationMessages: msgs.filter((m) => m.kind !== "internal"),
    guaranteesGiven,
    loans,
    repaymentSchedules: instalments,
    financialTransactions: txns.map((t) => strip(t, ["proposedEntries", "idempotencyKey"])),
    repaymentClaims: claims,
    restructureRequests: restructures,
    notifications: notes,
    documents: docs.filter((d) => d.category !== "hr_verification" && d.category !== "approval").map((d) => strip(d, ["storageKey"])),
    sessions: sess.map((x) => strip(x, ["tokenHash"])),
    activityLog: activity.map((a) => strip(a, ["before", "after"])),
  };
}
