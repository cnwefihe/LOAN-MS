import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { applicationGuarantors, loanAccounts, loanApplications, staffProfiles, users } from "@/db/schema";
import { assertCan, type Actor } from "../actor";
import { DomainError } from "../errors";

/**
 * Any active user may be chosen as a guarantor; there is no separate list to keep. Whether they qualify
 * (confirmed, minimum service, deductions within the limit, number of guarantees) is checked by the loan
 * policy when the application is submitted and when they accept. Applicants see names only; the email is
 * used to send the request.
 */

const nameOf = (r: { displayName: string; payslipName: string | null }) => r.payslipName?.trim() || r.displayName;

/** The names an applicant may choose from: every active user except the applicant. No emails. */
export async function guarantorChoices(db: Executor, applicantEmail: string) {
  const rows = await db.select({ id: users.id, displayName: users.displayName, payslipName: staffProfiles.payslipName, email: users.email }).from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(eq(users.isActive, true)).orderBy(asc(users.displayName));
  return rows.filter((r) => r.email.toLowerCase() !== applicantEmail.toLowerCase())
    .map((r) => ({ id: r.id, name: nameOf(r) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The emails behind the names chosen, in the order chosen. */
export async function guarantorEmailsFor(db: Executor, ids: string[]) {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return [];
  if (wanted.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new DomainError("Choose your guarantors from the list.");
  const rows = await db.select({ id: users.id, email: users.email }).from(users).where(and(inArray(users.id, wanted), eq(users.isActive, true)));
  return wanted.map((id) => {
    const r = rows.find((x) => x.id === id);
    if (!r) throw new DomainError("One of the guarantors chosen can no longer be chosen. Please choose again.");
    return r.email.toLowerCase();
  });
}

/** Users with these emails, so screens can show the guarantor's name and the form can show the choice. */
export async function guarantorsByEmail(db: Executor, emails: string[]) {
  const list = emails.map((e) => e.toLowerCase());
  if (!list.length) return new Map<string, { id: string; name: string; isActive: boolean }>();
  const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName, payslipName: staffProfiles.payslipName, isActive: users.isActive }).from(users)
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(inArray(sql`lower(${users.email})`, list));
  return new Map(rows.map((r) => [r.email.toLowerCase(), { id: r.id, name: nameOf(r), isActive: r.isActive }]));
}

/** Throws when a guarantor chosen is a user who has been deactivated. */
export async function assertOnGuarantorList(db: Executor, emails: string[]) {
  if (!emails.length) return;
  const found = await guarantorsByEmail(db, emails);
  for (const e of emails) {
    const u = found.get(e.toLowerCase());
    if (u && !u.isActive) throw new DomainError(`${u.name} can no longer be chosen as a guarantor. Please choose again.`);
  }
}

const OPEN_APP: string[] = ["pending_guarantor", "pending_hr", "pending_bursary", "pending_approval", "returned", "approved"];
const ENDED_LOAN: string[] = ["closed", "cancelled", "written_off"];

export const GUARANTEE_FILTERS = ["all", "active", "pending", "accepted", "declined"] as const;
export type GuaranteeFilter = (typeof GUARANTEE_FILTERS)[number];

/**
 * Everyone chosen as a guarantor, one row per request: who they are guaranteeing, whether they accepted,
 * declined or have not replied, and whether the guarantee is still in force.
 */
export async function guaranteeRequests(db: Executor, actor: Actor) {
  assertCan(actor, "admin.policy.manage");
  const applicant = sql<string>`(select coalesce(nullif(trim(sp.payslip_name), ''), u.display_name) from users u left join staff_profiles sp on sp.user_id = u.id where u.id = ${loanApplications.applicantId})`;
  const rows = await db.select({
    id: applicationGuarantors.id, status: applicationGuarantors.status, invitedAt: applicationGuarantors.invitedAt, respondedAt: applicationGuarantors.respondedAt,
    amount: applicationGuarantors.guaranteedAmount, guarantorId: users.id, displayName: users.displayName, payslipName: staffProfiles.payslipName, email: users.email,
    applicationId: loanApplications.id, reference: loanApplications.reference, applicationStatus: loanApplications.status, loanStatus: loanAccounts.status, applicant,
  }).from(applicationGuarantors)
    .innerJoin(users, eq(users.id, applicationGuarantors.guarantorId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .innerJoin(loanApplications, eq(loanApplications.id, applicationGuarantors.applicationId))
    .leftJoin(loanAccounts, eq(loanAccounts.applicationId, loanApplications.id))
    .orderBy(desc(applicationGuarantors.invitedAt));
  // Active: accepted, and the application or loan is still running.
  const running = (r: (typeof rows)[number]) => r.loanStatus ? !ENDED_LOAN.includes(r.loanStatus) : OPEN_APP.includes(r.applicationStatus);
  return rows.map((r) => ({ ...r, guarantor: nameOf(r), active: r.status === "accepted" && running(r) }));
}
