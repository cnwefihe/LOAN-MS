import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "@/db";
import { departments, loanApplications, applicationGuarantors, loanAccounts, repaymentClaims, financialTransactions, notifications, policyVersions } from "@/db/schema";
import { can, canAny, type Actor } from "@/server/actor";
import { canVerifyDocuments } from "@/server/services/verification";
import { getWording } from "@/server/wording";
import { myApprovalQueue } from "@/server/services/approvals";
import { advancesToRecover } from "@/server/services/advances";
import { departmentsHeadedBy } from "@/server/services/staff";

export type IconName =
  | "dashboard" | "calculator" | "file" | "wallet" | "user" | "handshake" | "clipboard" | "users" | "gavel" | "landmark" | "banknote"
  | "receipt" | "check" | "scale" | "clock" | "chart" | "shield" | "package" | "building" | "book" | "settings" | "scroll" | "mail" | "bell"
  | "palette" | "verify" | "tag" | "plus";

export interface NavItem { href: string; label: string; icon: IconName; badge?: number }
export interface NavSection { title: string; items: NavItem[] }

/** What administrators keep in the menu from other people's areas. Approvals appears only if they also decide on applications. */
const OVERSIGHT = ["/hr/staff", "/approvals", "/accounts/advances", "/accounts/reconciliation", "/accounts/loans", "/accounts/servicing"];

async function count(db: Executor, q: Promise<{ n: number }[]>) {
  const [r] = await q;
  return Number(r?.n ?? 0);
}

export async function buildNav(db: Executor, actor: Actor): Promise<{ sections: NavSection[]; unread: number; overview: boolean }> {
  const n = sql<number>`count(*)`;
  const w = await getWording(db);
  const sections: NavSection[] = [];

  // Self-service (added last) follows the borrower's journey: learn, check, apply, track, repay, and guarantee others.
  const self: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
    { href: "/products", label: "Products", icon: "package" },
    { href: "/eligibility", label: "Eligibility", icon: "calculator" },
  ];
  self.push({ href: "/applications", label: "Applications", icon: "file" }, { href: "/loans", label: "Loans", icon: "wallet" });
  if (can(actor, "guarantee.view_own")) {
    const pending = await count(db, db.select({ n }).from(applicationGuarantors).where(and(eq(applicationGuarantors.guarantorId, actor.userId), inArray(applicationGuarantors.status, ["pending", "clarification_requested"]))));
    self.push({ href: "/guarantor", label: "Guarantees", icon: "handshake", badge: pending });
  }

  if (canAny(actor, "hr.queue.view", "hr.staff.view")) {
    const items: NavItem[] = [];
    if (can(actor, "hr.queue.view")) {
      const q = await count(db, db.select({ n }).from(loanApplications).where(eq(loanApplications.status, "pending_hr")));
      items.push({ href: "/hr", label: "Overview", icon: "dashboard" }, { href: "/hr/applications", label: "Verification", icon: "clipboard", badge: q });
    }
    if (can(actor, "hr.staff.view")) items.push({ href: "/hr/staff", label: "Staff records", icon: "users" });
    sections.push({ title: "Human Resources", items });
  }

  // HODs and Line Managers, the HR Director and the Bursar: the badge counts what is waiting for this person.
  // Administrators decide nothing, so they follow approvals from the Control centre instead.
  const decides = can(actor, "approval.hr_director") || can(actor, "approval.decide") || (await departmentsHeadedBy(db, actor.userId)).length > 0;
  if (decides || (can(actor, "approval.queue.view") && !actor.roles.includes("SUPER_ADMIN"))) {
    const q = (await myApprovalQueue(db, actor)).length;
    sections.push({ title: w.section.approval, items: [{ href: "/approvals", label: "Approvals", icon: "gavel", badge: q }] });
  }

  if (can(actor, "accounts.view")) {
    const awaiting = await count(db, db.select({ n }).from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement")));
    const claims = await count(db, db.select({ n }).from(repaymentClaims).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId))));
    const checker = await count(db, db.select({ n }).from(financialTransactions).where(eq(financialTransactions.status, "pending_approval")));
    const items: NavItem[] = [{ href: "/accounts", label: "Overview", icon: "dashboard" }];
    if (can(actor, "bursary.review")) {
      const q = await count(db, db.select({ n }).from(loanApplications).where(eq(loanApplications.status, "pending_bursary")));
      items.push({ href: "/bursary/review", label: "Reviews", icon: "clipboard", badge: q });
    }
    if (can(actor, "disbursement.record")) items.push({ href: "/accounts/disbursements", label: "Disbursements", icon: "banknote", badge: awaiting });
    if (can(actor, "repayment.confirm")) items.push({ href: "/accounts/repayments", label: "Repayments", icon: "receipt", badge: claims });
    if (can(actor, "transaction.approve")) items.push({ href: "/accounts/approvals", label: "Pending authorisations", icon: "check", badge: checker });
    items.push({ href: "/accounts/advances", label: "Advances", icon: "wallet", badge: await advancesToRecover(db) });
    items.push({ href: "/accounts/reconciliation", label: "Reconciliation", icon: "scale" }, { href: "/accounts/loans", label: "Loan accounts", icon: "landmark" });
    if (can(actor, "servicing.run")) items.push({ href: "/accounts/servicing", label: "Automation", icon: "clock" });
    sections.push({ title: w.section.bursary, items });
  } else if (can(actor, "servicing.run")) {
    sections.push({ title: w.section.bursary, items: [{ href: "/accounts/servicing", label: "Automation", icon: "clock" }] });
  }

  const insight: NavItem[] = [];
  if (can(actor, "reports.view")) insight.push({ href: "/reports", label: "Reports", icon: "chart" });
  if (canVerifyDocuments(actor)) insight.push({ href: "/verify", label: "Authenticate", icon: "verify" });
  if (insight.length) sections.push({ title: "Insight", items: insight });

  const admin: NavItem[] = [];
  if (canAny(actor, "admin.users.manage", "admin.roles.manage", "admin.policy.manage", "admin.settings.manage", "admin.audit.view")) admin.push({ href: "/admin", label: "Control centre", icon: "shield" });
  if (can(actor, "admin.users.manage")) admin.push({ href: "/admin/users", label: "Users", icon: "users" });
  if (can(actor, "admin.roles.manage")) admin.push({ href: "/admin/roles", label: "Roles", icon: "shield" });
  if (can(actor, "admin.org.manage")) admin.push({ href: "/admin/organisation", label: "Organisation", icon: "building" });
  if (canAny(actor, "admin.policy.manage", "admin.policy.approve")) {
    const pend = await count(db, db.select({ n }).from(policyVersions).where(eq(policyVersions.status, "pending_approval")));
    admin.push({ href: "/admin/products", label: "Products", icon: "package", badge: pend });
  }
  if (can(actor, "admin.content.manage")) admin.push({ href: "/admin/content", label: "Templates", icon: "book" });
  if (can(actor, "admin.settings.manage")) admin.push({ href: "/admin/branding", label: "Branding", icon: "palette" }, { href: "/admin/settings", label: "Settings", icon: "settings" }, { href: "/admin/releases", label: "Versions", icon: "tag" });
  if (can(actor, "admin.audit.view")) admin.push({ href: "/admin/audit", label: "Activity", icon: "scroll" }, { href: "/admin/outbox", label: "Emails", icon: "mail" });
  if (admin.length) sections.push({ title: "Administration", items: admin });

  // Administrators configure the system and oversee it. Other people's daily work stays with those people,
  // and the Control centre shows it all, so only what an administrator acts on or looks up is listed.
  if (actor.roles.includes("SUPER_ADMIN")) {
    const all = sections.flatMap((s) => s.items);
    const oversight = OVERSIGHT.flatMap((href) => all.filter((i) => i.href === href));
    const menu = [
      { title: "Administration", items: [...admin, self.find((i) => i.href === "/eligibility")!] },
      ...(oversight.length ? [{ title: "Oversight", items: oversight }] : []),
      ...(insight.length ? [{ title: "Insight", items: insight }] : []),
    ];
    const unreadCount = await count(db, db.select({ n }).from(notifications).where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt))));
    return { sections: menu, unread: unreadCount, overview: false };
  }

  const approvals = sections.find((s) => s.items.length === 1 && s.items[0].href === "/approvals");
  const bursary = sections.find((s) => s.title === w.section.bursary && s.items.length > 1);
  const alone = (s: NavSection) => s === approvals || s.title === "Insight" || s.items.length === 1;
  let overview = false;
  if (approvals && bursary && can(actor, "approval.decide")) {
    // The Bursar approves as part of the Bursary's work: Approvals sits straight after its Overview.
    sections.splice(sections.indexOf(approvals), 1);
    bursary.items.splice(1, 0, approvals.items[0]);
    sections.push({ title: "Self-service", items: self });
  } else if (approvals && sections.every(alone)) {
    // Approvers with no other work area (HOD, Line Manager, HR Director) get one menu, headed with their title:
    // Overview first (their approvals and their own loans), then Approvals, then the rest.
    overview = true;
    const staffRecords = sections.find((s) => s.items[0]?.href === "/hr/staff");
    for (const s of [approvals, staffRecords]) if (s) sections.splice(sections.indexOf(s), 1);
    self[0] = { ...self[0], label: "Overview" };
    self.splice(1, 0, approvals.items[0], ...(staffRecords?.items ?? []));
    const headed = await db.select({ title: departments.approverTitle }).from(departments).where(eq(departments.headUserId, actor.userId));
    const title = can(actor, "approval.hr_director") ? w.role.HR_DIRECTOR.name.replace(/^HR /, "Human Resources ") : headed.some((d) => d.title === "hod") ? "Head of Department" : "Line Manager";
    sections.unshift({ title, items: self });
  } else {
    // Staff with a work role see that work first; their own loans come last.
    sections.push({ title: "Self-service", items: self });
  }

  const unread = await count(db, db.select({ n }).from(notifications).where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt))));
  return { sections, unread, overview };
}

/** Where a person lands after signing in: the first page of their work area, or their own dashboard. */
export async function homeFor(db: Executor, actor: Actor) {
  const { sections } = await buildNav(db, actor);
  // Administrators start in the Control centre, whatever else they can see.
  const admin = sections.find((s) => s.title === "Administration");
  if (admin && actor.roles.includes("SUPER_ADMIN")) return admin.items[0].href;
  // Staff records alone (the HR Director) are a reference list, not the day's work: start at the next area instead.
  const work = sections.filter((s) => !(s.items.length === 1 && s.items[0].href === "/hr/staff"));
  return work[0]?.title === "Self-service" ? "/dashboard" : work[0].items[0].href;
}
