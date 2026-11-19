import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { listOpenProducts } from "@/server/services/policies";
import type { Executor } from "@/db";
import { departments, loanApplications, applicationGuarantors, loanAccounts, repaymentClaims, financialTransactions, notifications, earlyRepayments } from "@/db/schema";
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
  const decides = can(actor, "approval.hr_director") || can(actor, "approval.decide") || (await departmentsHeadedBy(db, actor.userId)).length > 0;
  if (decides || can(actor, "approval.queue.view")) {
    const q = (await myApprovalQueue(db, actor)).length;
    sections.push({ title: w.section.approval, items: [{ href: "/approvals", label: "Approvals", icon: "gavel", badge: q }] });
  }

  if (can(actor, "accounts.view")) {
    const awaiting = await count(db, db.select({ n }).from(loanAccounts).where(eq(loanAccounts.status, "pending_disbursement")));
    const checker = await count(db, db.select({ n }).from(financialTransactions).where(eq(financialTransactions.status, "pending_approval")));
    const items: NavItem[] = [{ href: "/accounts", label: "Overview", icon: "dashboard" }];
    if (can(actor, "bursary.review")) {
      const q = await count(db, db.select({ n }).from(loanApplications).where(eq(loanApplications.status, "pending_bursary")));
      items.push({ href: "/bursary/review", label: "Reviews", icon: "clipboard", badge: q });
    }
    if (can(actor, "disbursement.record")) items.push({ href: "/accounts/disbursements", label: "Disbursements", icon: "banknote", badge: awaiting });
    if (can(actor, "transaction.approve")) items.push({ href: "/accounts/approvals", label: "Pending authorisations", icon: "check", badge: checker });
    // Advances only while an advance product is open or advances are still being recovered.
    const advancesOpen = await advancesToRecover(db);
    if (advancesOpen > 0 || (await listOpenProducts(db)).some((p) => p.params.productType === "advance")) items.push({ href: "/accounts/advances", label: "Advances", icon: "wallet", badge: advancesOpen });
    items.push({ href: "/accounts/reconciliation", label: "Reconciliation", icon: "scale" }, { href: "/accounts/loans", label: "Loan accounts", icon: "landmark" });
    // The automatic check runs by itself, as often as set in Settings, so it has no menu entry (the Control centre shows whether it is running).
    sections.push({ title: w.section.bursary, items });
  }

  // Payroll: confirming the first salary deduction on each loan, and early repayments.
  if (canAny(actor, "payroll.view", "repayment.confirm")) {
    const items: NavItem[] = [];
    if (can(actor, "payroll.view")) items.push({ href: "/payroll", label: "Overview", icon: "dashboard" });
    if (can(actor, "repayment.confirm")) {
      const claims = await count(db, db.select({ n }).from(repaymentClaims).where(and(eq(repaymentClaims.status, "pending"), isNull(repaymentClaims.transactionId))));
      items.push({ href: "/accounts/repayments", label: "Repayments", icon: "receipt", badge: claims });
    }
    if (can(actor, "payroll.view")) {
      const early = await count(db, db.select({ n }).from(earlyRepayments).where(eq(earlyRepayments.status, "pending")));
      items.push({ href: "/payroll/early-repayments", label: "Early repayments", icon: "wallet", badge: can(actor, "settlement.confirm") ? early : undefined });
    }
    sections.push({ title: "Payroll", items });
  }
  // The overview holds the fund pools; anyone who may only set the pools (such as the Payroll Manager) finds them here too.
  if (can(actor, "finance.overview")) sections.push({ title: "Finance", items: [{ href: "/finance", label: "Overview", icon: "chart" }] });
  else if (can(actor, "fund.manage")) sections.push({ title: "Finance", items: [{ href: "/finance", label: "Fund pools", icon: "wallet" }] });

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
    admin.push({ href: "/admin/products", label: "Products", icon: "package" });
  }
  if (can(actor, "admin.policy.manage")) admin.push({ href: "/admin/guarantors", label: "Guarantors", icon: "handshake" });
  if (can(actor, "admin.content.manage")) admin.push({ href: "/admin/content", label: "Templates", icon: "book" });
  if (can(actor, "admin.settings.manage")) admin.push({ href: "/admin/branding", label: "Branding", icon: "palette" }, { href: "/admin/settings", label: "Settings", icon: "settings" }, { href: "/admin/register", label: "Register", icon: "clipboard" }, { href: "/admin/releases", label: "Versions", icon: "tag" });
  if (can(actor, "admin.audit.view")) admin.push({ href: "/admin/audit", label: "Activity", icon: "scroll" }, { href: "/admin/outbox", label: "Emails", icon: "mail" });
  if (admin.length) sections.push({ title: "Administration", items: admin });

  // Administrators: Administration first, then every other area their permissions open (so turning a permission
  // on or off shows or hides its menu at once), then Insight.
  if (actor.roles.includes("SUPER_ADMIN")) {
    const work = sections.filter((s) => s.title !== "Administration" && s.title !== "Insight");
    const menu = [
      { title: "Administration", items: admin },
      ...work,
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
