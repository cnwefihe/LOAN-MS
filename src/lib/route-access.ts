import type { Permission } from "./auth/permissions";

/**
 * The permission each page needs (any one of those listed; none means any signed-in person, with the page
 * checking further itself, for example that an application is theirs). It mirrors each page's own check, and
 * a test keeps the two in step. Links on overview pages use it, so a figure or card only links to a page the
 * person may open. "*" stands for an ID in the address.
 */
const PAGES: [pattern: string, anyOf: Permission[]][] = [
  ["/accounts", ["accounts.view"]],
  ["/accounts/advances", ["accounts.view"]],
  ["/accounts/approvals", ["accounts.view", "transaction.approve"]],
  ["/accounts/disbursements", ["accounts.view", "disbursement.record"]],
  ["/accounts/loans", ["accounts.view"]],
  ["/accounts/loans/*", ["accounts.view"]],
  ["/accounts/reconciliation", ["accounts.view"]],
  ["/accounts/repayments", ["accounts.view", "repayment.confirm"]],
  ["/accounts/servicing", ["servicing.run"]],
  ["/admin", ["admin.users.manage", "admin.roles.manage", "admin.policy.manage", "admin.settings.manage", "admin.audit.view"]],
  ["/admin/connections", ["admin.users.manage", "admin.roles.manage", "admin.policy.manage", "admin.settings.manage", "admin.audit.view"]],
  ["/admin/audit", ["admin.audit.view"]],
  ["/admin/audit/*", ["admin.audit.view"]],
  ["/admin/outbox", ["admin.audit.view"]],
  ["/admin/branding", ["admin.settings.manage"]],
  ["/admin/settings", ["admin.settings.manage"]],
  ["/admin/register", ["admin.settings.manage"]],
  ["/admin/releases", ["admin.settings.manage"]],
  ["/admin/content", ["admin.content.manage"]],
  ["/admin/content/*/*", ["admin.content.manage"]],
  ["/admin/guarantors", ["admin.policy.manage"]],
  ["/admin/organisation", ["admin.org.manage"]],
  ["/admin/organisation/*/*", ["admin.org.manage"]],
  ["/admin/organisation/import", ["admin.org.manage"]],
  ["/admin/products", ["admin.policy.manage", "admin.policy.approve"]],
  ["/admin/products/new", ["admin.policy.manage"]],
  ["/admin/products/*", ["admin.policy.manage", "admin.policy.approve"]],
  ["/admin/roles", ["admin.roles.manage"]],
  ["/admin/roles/*", ["admin.roles.manage"]],
  ["/admin/users", ["admin.users.manage"]],
  ["/admin/users/*", ["admin.users.manage"]],
  ["/applications", ["application.view_own"]],
  ["/applications/new", ["application.create"]],
  ["/applications/*", []],
  ["/applications/*/edit", ["application.create"]],
  ["/approvals", []],
  ["/approvals/*", []],
  ["/bursary/review", ["bursary.review"]],
  ["/bursary/review/*", ["bursary.review"]],
  ["/eligibility", ["application.create"]],
  ["/products", ["application.create"]],
  ["/finance", ["finance.overview", "fund.manage"]],
  ["/guarantor", ["guarantee.view_own"]],
  ["/guarantor/requests/*", ["guarantee.view_own"]],
  ["/hr", ["hr.queue.view"]],
  ["/hr/applications", ["hr.queue.view"]],
  ["/hr/applications/*", ["hr.queue.view"]],
  ["/hr/staff", ["hr.staff.view"]],
  ["/hr/staff/*", ["hr.staff.view"]],
  ["/loans", ["loan.view_own"]],
  ["/loans/*", []],
  ["/loans/*/repay-early", ["repayment.claim"]],
  ["/payroll", ["payroll.view"]],
  ["/payroll/early-repayments", ["payroll.view"]],
  ["/payroll/early-repayments/*", ["payroll.view"]],
  ["/profile", ["profile.view_own"]],
  ["/reports", ["reports.view"]],
];

const segments = (p: string) => p.split("/").filter(Boolean);

/** The page pattern an address belongs to: same number of parts, literal parts preferred over IDs. */
function pageFor(path: string) {
  const want = segments(path);
  return PAGES
    .filter(([pattern]) => { const s = segments(pattern); return s.length === want.length && s.every((x, i) => x === "*" || x === want[i]); })
    .sort((a, b) => segments(a[0]).filter((x) => x === "*").length - segments(b[0]).filter((x) => x === "*").length)[0];
}

/** Whether someone with these permissions may open the page at `href`. */
export function canOpen(permissions: ReadonlySet<Permission>, href: string): boolean {
  const page = pageFor(href.split(/[?#]/)[0]);
  return !page || !page[1].length || page[1].some((p) => permissions.has(p));
}

/** The link when the person may open it; otherwise nothing, so the figure or card shows without a link. */
export function linkIf(permissions: ReadonlySet<Permission>, href: string | undefined): string | undefined {
  return href && canOpen(permissions, href) ? href : undefined;
}
