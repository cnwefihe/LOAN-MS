/**
 * Permission catalogue and default role grants. Seeded into the database; role→permission
 * grants can be edited by the Super Administrator (except the locked SUPER_ADMIN set).
 * Authorisation is always checked server-side against the database, never from client state.
 */

export const PERMISSIONS = {
  // Applicant self-service
  "profile.view_own": { category: "Self-service", description: "View own staff profile" },
  "profile.edit_own": { category: "Self-service", description: "Edit own contact and bank details" },
  "application.create": { category: "Self-service", description: "Create and submit loan applications" },
  "application.view_own": { category: "Self-service", description: "View own applications" },
  "loan.view_own": { category: "Self-service", description: "View own loans, schedules and statements" },
  "repayment.claim": { category: "Self-service", description: "Report salary deductions / repayments for confirmation" },
  "restructure.request": { category: "Self-service", description: "Request loan restructuring" },
  // Guarantor
  "guarantee.view_own": { category: "Guarantor", description: "View guarantor invitations and obligations" },
  "guarantee.respond": { category: "Guarantor", description: "Accept, decline or request clarification on guarantees" },
  // HR
  "hr.queue.view": { category: "Human Resources", description: "View Human Resources verification queue and application details" },
  "hr.verify": { category: "Human Resources", description: "Record Human Resources due diligence and verification decisions" },
  "hr.guarantor.assess": { category: "Human Resources", description: "Assess guarantor eligibility and capacity" },
  "hr.staff.view": { category: "Human Resources", description: "View staff employment and salary records" },
  "hr.staff.edit": { category: "Human Resources", description: "Update staff employment and salary records" },
  // Approval
  "approval.queue.view": { category: "Approval", description: "View applications at the approval stages" },
  "approval.hr_director": { category: "Approval", description: "Approve applications as HR Director (after the Line Manager)" },
  "approval.decide": { category: "Approval", description: "Give final approval to applications (Bursar)" },
  // Bursary
  "bursary.review": { category: "Bursary", description: "Check loan history, the deduction limit and funds, and forward applications to the Line Manager" },
  "accounts.view": { category: "Bursary", description: "View loan accounts, ledgers and transactions" },
  "disbursement.record": { category: "Bursary", description: "Pay out approved loans" },
  "repayment.confirm": { category: "Payroll", description: "Confirm the first salary deduction on each loan and record repayments" },
  "payroll.view": { category: "Payroll", description: "See salary deductions, repayments and early repayment requests" },
  "settlement.confirm": { category: "Payroll", description: "Mark a loan repaid in full after an early repayment (needs a two-step verification code)" },
  "fund.view": { category: "Bursary", description: "See the fund pool for staff loans and what is left of it" },
  "fund.manage": { category: "Bursary", description: "Set the fund pool for staff loans each year" },
  "finance.overview": { category: "Bursary", description: "See the overview of lending, repayments and the fund pool" },
  "transaction.adjust": { category: "Bursary", description: "Propose adjustments and refunds" },
  "transaction.approve": { category: "Bursary", description: "Approve or reject pending financial transactions (checker)" },
  "transaction.reverse": { category: "Bursary", description: "Propose reversals of posted transactions" },
  "restructure.approve": { category: "Bursary", description: "Approve loan restructuring requests" },
  "servicing.run": { category: "Bursary", description: "Run the automatic check for overdue and defaulted loans" },
  // Shared staff
  "documents.view_all": { category: "Documents", description: "View documents across all applications and loans" },
  "reports.view": { category: "Reporting", description: "View institutional reports and analytics" },
  "reports.export": { category: "Reporting", description: "Export reports to Excel, CSV and PDF" },
  // Administration
  "admin.users.manage": { category: "Administration", description: "Manage users and role assignments" },
  "admin.roles.manage": { category: "Administration", description: "Add roles and manage their permissions" },
  "admin.policy.manage": { category: "Administration", description: "Create and edit loan products and policy drafts" },
  "admin.policy.approve": { category: "Administration", description: "Approve and activate policy versions" },
  "admin.org.manage": { category: "Administration", description: "Manage schools, departments and staff categories" },
  "admin.content.manage": { category: "Administration", description: "Manage terms, document requirements and notification templates" },
  "admin.settings.manage": { category: "Administration", description: "Manage system settings, branding, document markings and email" },
  "admin.audit.view": { category: "Administration", description: "View audit logs, sessions and email outbox" },
} as const;

/** Display order: the workflow first, then reporting and administration. */
export const PERMISSION_CATEGORIES = ["Self-service", "Guarantor", "Human Resources", "Bursary", "Payroll", "Approval", "Documents", "Reporting", "Administration"];

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** In workflow order: HR, Bursary Officer, (Line Manager), HR Director, Bursar, Accounts Payable, then repayment and oversight. */
export const ROLE_CODES = [
  "APPLICANT", "GUARANTOR", "HR_ADMIN", "BURSARY_OFFICER", "HR_DIRECTOR", "ACCOUNTS_ADMIN", "ACCOUNTS_OFFICER",
  "PAYROLL_OFFICER", "PAYROLL_MANAGER", "HEAD_OF_ACCOUNT", "SUPER_ADMIN",
] as const;

/** Roles from the earlier workflow, removed by seeding (HR_OFFICER holders become HR Administrators). */
export const RETIRED_ROLE_CODES = ["HR_OFFICER", "FINAL_APPROVER"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

const SELF: Permission[] = ["profile.view_own", "profile.edit_own", "application.create", "application.view_own", "loan.view_own", "repayment.claim", "restructure.request"];

export const ROLE_DEFINITIONS: Record<RoleCode, { name: string; description: string; permissions: Permission[] }> = {
  APPLICANT: { name: "Applicant", description: "Apply for and manage your own loans.", permissions: SELF },
  GUARANTOR: { name: "Guarantor", description: "Guarantee colleagues' loans.", permissions: ["guarantee.view_own", "guarantee.respond"] },
  HR_ADMIN: {
    name: "HR Administrator", description: "Verifies each applicant's employment and salary, and keeps staff records.",
    permissions: ["hr.queue.view", "hr.verify", "hr.guarantor.assess", "hr.staff.view", "hr.staff.edit", "documents.view_all", "reports.view", "reports.export"],
  },
  BURSARY_OFFICER: {
    name: "Bursary Officer", description: "Checks loan history, the deduction limit and the fund pool after Human Resources.",
    permissions: ["bursary.review", "accounts.view", "fund.view", "transaction.adjust", "transaction.reverse", "documents.view_all", "reports.view"],
  },
  HR_DIRECTOR: {
    name: "HR Director", description: "Approves applications after the Line Manager.",
    permissions: ["approval.queue.view", "approval.hr_director", "hr.staff.view", "documents.view_all", "reports.view"],
  },
  ACCOUNTS_ADMIN: {
    name: "Bursar", description: "Gives final approval to loans and oversees loan servicing.",
    permissions: ["approval.queue.view", "approval.decide", "accounts.view", "fund.view", "transaction.approve", "restructure.approve", "servicing.run", "documents.view_all", "reports.view", "reports.export"],
  },
  ACCOUNTS_OFFICER: {
    name: "Accounts Payable Officer", description: "Pays out loans once the Bursar has approved them. The loan starts when it is paid.",
    permissions: ["accounts.view", "fund.view", "disbursement.record", "documents.view_all", "reports.view"],
  },
  PAYROLL_OFFICER: {
    name: "Payroll Officer", description: "Confirms the first salary deduction on each loan; later deductions are then recorded automatically.",
    permissions: ["accounts.view", "repayment.confirm", "payroll.view", "documents.view_all", "reports.view"],
  },
  PAYROLL_MANAGER: {
    name: "Payroll Manager", description: "Oversees deductions and repayments, and marks loans repaid in full after an early repayment.",
    permissions: ["accounts.view", "payroll.view", "settlement.confirm", "fund.view", "documents.view_all", "reports.view", "reports.export"],
  },
  HEAD_OF_ACCOUNT: {
    name: "Head of Account", description: "Sets the fund pool for staff loans each year and oversees lending and repayments.",
    permissions: ["accounts.view", "finance.overview", "fund.view", "fund.manage", "payroll.view", "reports.view", "reports.export"],
  },
  // Financial maker and checker rights are assigned to named staff, never to this role (segregation of duties).
  SUPER_ADMIN: {
    name: "Super Administrator",
    description: "System administration, users, products and portfolio oversight.",
    permissions: [
      "admin.users.manage", "admin.roles.manage", "admin.policy.manage", "admin.policy.approve", "admin.org.manage",
      "admin.content.manage", "admin.settings.manage", "admin.audit.view", "reports.view", "reports.export", "accounts.view",
      "servicing.run",
    ],
  },
};

/**
 * Grants on SUPER_ADMIN that cannot be removed through the UI, and that seeding restores if they go
 * missing: the administrator can always reach every configuration screen.
 */
// Administration, plus every report (including the Bursary's and the audit extract), so administrators can always pull any report.
export const LOCKED_SUPER_ADMIN_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => p.startsWith("admin.") || ["reports.view", "reports.export", "accounts.view"].includes(p));
