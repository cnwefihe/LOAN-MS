import { and, eq, ilike, or } from "drizzle-orm";
import type { Executor } from "@/db";
import { loanApplications, loanAccounts, users, staffProfiles } from "@/db/schema";
import { can, canAny, type Actor } from "../actor";

/**
 * Applications, loans and staff matching a reference, account number, name, email or staff number,
 * limited to what the person may see: staff see all records their role covers, everyone else their own.
 */
export async function searchRecords(db: Executor, actor: Actor, raw: string, limit = 25) {
  const q = raw.trim().slice(0, 100);
  const staff = canAny(actor, "hr.queue.view", "approval.queue.view", "accounts.view");
  if (!q) return { q, staff, apps: [], loans: [], people: [] };
  const like = `%${q}%`;
  const appHref = (id: string) => (can(actor, "hr.queue.view") ? `/hr/applications/${id}` : can(actor, "approval.queue.view") ? `/approvals/${id}` : `/applications/${id}`);
  const loanHref = (id: string) => (can(actor, "accounts.view") ? `/accounts/loans/${id}` : `/loans/${id}`);

  const apps = (await db.select({ app: loanApplications, name: users.displayName }).from(loanApplications).innerJoin(users, eq(users.id, loanApplications.applicantId))
    .where(and(or(ilike(loanApplications.reference, like), ilike(users.displayName, like)), staff ? undefined : eq(loanApplications.applicantId, actor.userId))).limit(limit))
    .map((r) => ({ ...r, href: appHref(r.app.id) }));
  const loans = (await db.select({ loan: loanAccounts, name: users.displayName }).from(loanAccounts).innerJoin(users, eq(users.id, loanAccounts.borrowerId))
    .where(and(or(ilike(loanAccounts.accountNumber, like), ilike(users.displayName, like)), can(actor, "accounts.view") ? undefined : eq(loanAccounts.borrowerId, actor.userId))).limit(limit))
    .map((r) => ({ ...r, href: loanHref(r.loan.id) }));
  const people = can(actor, "hr.staff.view")
    ? (await db.select({ u: users, staffNumber: staffProfiles.staffNumber }).from(users).leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(or(ilike(users.displayName, like), ilike(users.email, like), ilike(staffProfiles.staffNumber, like))).limit(limit))
      .map((r) => ({ ...r, href: `/hr/staff/${r.u.id}` }))
    : [];
  return { q, staff, apps, loans, people };
}
