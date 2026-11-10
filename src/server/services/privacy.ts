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
import { PdfBuilder, lagosStamp } from "../pdf";
import { formatNaira } from "@/lib/finance/money";
import { formatDate, formatDateTime } from "@/lib/finance/dates";
import { humanise } from "@/lib/text";
import { getWording } from "../wording";
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

/**
 * The same records as a readable PDF: the University's document layout, one section for each kind of
 * record. The export is registered like every other issued document so it can be verified later.
 */
export async function myDataPdf(db: Executor, actor: Actor): Promise<Buffer> {
  const d = await exportMyData(db, actor);
  const [u, p] = [d.identity as Record<string, unknown>, d.staffProfile as Record<string, unknown> | null];
  const naira = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : formatNaira(v as string));
  const day = (v: unknown) => (v ? formatDate(v as string | Date) : "-");
  const when = (v: unknown) => (v ? formatDateTime(v as string | Date) : "-");
  const txt = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : String(v));
  const none = (pdf: PdfBuilder, what: string) => pdf.note(`No ${what}.`);
  const roleNames = (await getWording(db)).role as Record<string, { name: string } | undefined>;

  const pdf = await PdfBuilder.create(db, { kind: "data_export", title: "My data", numbered: true, subtitle: `${txt(u.displayName)} | ${lagosStamp()}` });
  pdf.note(d.notice);

  pdf.heading("About you");
  pdf.keyValues([
    ["Name", txt(u.displayName)], ["Email", txt(u.email)], ["Account created", day(u.createdAt)], ["Last sign-in", when(u.lastLoginAt)],
    ["Roles", d.roles.map((r) => roleNames[r.code]?.name ?? humanise(r.code)).join(", ") || "-"],
  ]);

  pdf.heading("Staff record");
  if (!p) none(pdf, "staff record");
  else pdf.keyValues([
    ["Staff number", txt(p.staffNumber)], ["Name on payslip", txt(p.payslipName)], ["Designation", txt(p.designation)], ["Pay grade", txt(p.payGrade)],
    ["Employment status", humanise(p.employmentStatus ?? "not recorded")], ["Employment date", day(p.employmentDate)], ["Confirmation date", day(p.confirmationDate)],
    ["Phone", txt(p.phone)], ["Residential address", txt(p.residentialAddress)], ["Bank", txt(p.bankName)], ["Account name", txt(p.bankAccountName)],
    ["Monthly net pay on record", naira(p.monthlyNet)],
  ]);

  pdf.heading("Applications");
  if (!d.applications.length) none(pdf, "applications");
  else pdf.table(["Reference", "Status", "Amount", "Tenor", "Purpose", "Created"],
    d.applications.map((a) => [a.reference, humanise(a.status), naira(a.requestedAmount), a.tenorMonths ? `${a.tenorMonths} months` : "-", txt(a.purpose), day(a.createdAt)]),
    ["left", "left", "right", "right", "left", "left"]);

  pdf.heading("Loans");
  if (!d.loans.length) none(pdf, "loans");
  else pdf.table(["Account", "Status", "Principal", "Instalment", "Repaid", "Outstanding", "Disbursed"],
    d.loans.map((l) => [l.accountNumber, humanise(l.status), naira(l.principal), naira(l.monthlyInstalment), naira(l.totalRepaid), naira(l.principalOutstanding), day(l.disbursedAt)]),
    ["left", "left", "right", "right", "right", "right", "left"]);

  if (d.repaymentSchedules.length) {
    pdf.heading("Repayment schedule");
    pdf.table(["No.", "Due", "Amount due", "Paid", "Status"],
      [...d.repaymentSchedules].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((i) => [String(i.sequence), day(i.dueDate), naira(i.totalDue), naira((Number(i.principalPaid) + Number(i.interestPaid)).toFixed(2)), humanise(i.status)]),
      ["right", "left", "right", "right", "left"]);
  }
  if (d.financialTransactions.length) {
    pdf.heading("Payments and other transactions");
    pdf.table(["Reference", "Type", "Amount", "Date", "Status"],
      d.financialTransactions.map((t) => [txt(t.reference), humanise(t.type), naira(t.amount), day(t.valueDate), humanise(t.status)]),
      ["left", "left", "right", "left", "left"]);
  }

  pdf.heading("Loans you guarantee");
  if (!d.guaranteesGiven.length) none(pdf, "guarantees");
  else pdf.table(["Status", "Amount guaranteed", "Invited", "Responded"],
    d.guaranteesGiven.map((g) => [humanise(g.status), naira(g.guaranteedAmount), day(g.invitedAt), day(g.respondedAt)]),
    ["left", "right", "left", "left"]);

  pdf.heading("Documents");
  if (!d.documents.length) none(pdf, "documents");
  else pdf.table(["Title", "File", "Uploaded"], d.documents.map((x) => [txt(x.title), txt(x.fileName), day(x.createdAt)]));

  pdf.heading("Messages and notifications");
  pdf.keyValues([["Messages on your applications", String(d.applicationMessages.length)], ["Notifications", String(d.notifications.length)]]);
  if (d.notifications.length) pdf.table(["Date", "Notification"], d.notifications.slice(0, 50).map((n) => [when(n.createdAt), txt(n.title)]));

  pdf.heading("Sign-ins and activity");
  if (d.sessions.length) pdf.table(["Signed in", "Last active", "Device"],
    d.sessions.slice(0, 30).map((s) => [when(s.createdAt), when((s as Record<string, unknown>).lastSeenAt), txt((s as Record<string, unknown>).userAgent).slice(0, 60)]));
  if (d.activityLog.length) pdf.table(["Date", "What you did"], d.activityLog.slice(0, 100).map((a) => [when(a.createdAt), txt(a.summary ?? a.action)]));
  if (d.activityLog.length > 100) pdf.note(`The ${d.activityLog.length - 100} earlier actions are kept on record and available from the Data Protection Officer.`);

  return pdf.finish(db, actor, { entityType: "user", entityId: actor.userId, subjectUserId: actor.userId });
}
